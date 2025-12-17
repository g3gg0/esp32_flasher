// NVS Parser encapsulated as a standalone class
// Depends on SparseImage and SparseImageDataView from esp32-parser.js being loaded in the page

class NVSParser {
    constructor(sparseImage) {
        if (!sparseImage) {
            throw new Error('NVSParser requires a SparseImage');
        }
        this.sparseImage = sparseImage;
        this.buffer = SparseImage._createProxy(sparseImage);
        this.view = sparseImage.createDataView();
    }

    static bytesToHex(bytes, separator = '') {
        return Array.from(bytes)
            .map(b => b.toString(16).padStart(2, '0').toUpperCase())
            .join(separator);
    }

    static crc32Byte(crc, d) {
        for (let i = 0; i < 8; i++) {
            const bit = d & 1;
            crc ^= bit;
            crc = (crc & 1) ? (crc >>> 1) ^ 0xEDB88320 : crc >>> 1;
            d >>>= 1;
        }
        return crc >>> 0;
    }

    static crc32(data, offset = 0, length = null) {
        let crc = 0;
        const len = length ?? data.length - offset;
        for (let i = 0; i < len; i++) {
            crc = NVSParser.crc32Byte(crc, data[offset + i]);
        }
        return (~crc) >>> 0;
    }

    static crc32Header(data, offset = 0) {
        const buf = new Uint8Array(0x20 - 4);
        buf.set(data.subarray(offset, offset + 4), 0);
        buf.set(data.subarray(offset + 8, offset + 8 + 0x18), 4);
        return NVSParser.crc32(buf, 0, 0x1C);
    }

    async readString(offset, maxLength) {
        let result = '';
        for (let i = 0; i < maxLength; i++) {
            const byte = await this.view.getUint8(offset + i);
            if (byte === 0) break;
            if (byte >= 32 && byte <= 126) {
                result += String.fromCharCode(byte);
            } else if (byte !== 0) {
                return result;
            }
        }
        return result;
    }

    getNVSTypeName(datatype) {
        const types = {
            0x01: 'U8',
            0x02: 'U16',
            0x04: 'U32',
            0x08: 'U64',
            0x11: 'I8',
            0x12: 'I16',
            0x14: 'I32',
            0x18: 'I64',
            0x21: 'String',
            0x42: 'Blob',
            0x48: 'Blob Index'
        };
        return types[datatype] || `Unknown (0x${datatype.toString(16)})`;
    }

    getNVSItemState(stateBitmap, index) {
        const bmpIdx = Math.floor(index / 4);
        const bmpBit = (index % 4) * 2;
        return (stateBitmap[bmpIdx] >> bmpBit) & 3;
    }

    setNVSItemState(stateBitmap, index, state) {
        const bmpIdx = Math.floor(index / 4);
        const bmpBit = (index % 4) * 2;
        stateBitmap[bmpIdx] &= ~(3 << bmpBit);
        stateBitmap[bmpIdx] |= (state << bmpBit);
    }

    async parseItem(offset, namespaces, partition) {
        if (offset + 32 > this.buffer.length) {
            return null;
        }

        const nsIndex = await this.view.getUint8(offset);
        const datatype = await this.view.getUint8(offset + 1);
        const span = await this.view.getUint8(offset + 2);
        const chunkIndex = await this.view.getUint8(offset + 3);
        const crc32 = await this.view.getUint32(offset + 4, true);
        const key = await this.readString(offset + 8, 16);

        if (span === 0 || span > 126) {
            console.warn(`Invalid span ${span} at offset ${offset}`);
            return null;
        }

        if (nsIndex !== 0 && (!key || key.length === 0)) {
            return null;
        }

        if (nsIndex !== 0) {
            for (let i = 0; i < key.length; i++) {
                const code = key.charCodeAt(i);
                if (code < 32 || code > 126) {
                    return null;
                }
            }
        }

        if (datatype === 0xFF || datatype === 0x00) {
            return null;
        }

        if (nsIndex === 0xFF) {
            return null;
        }

        const headerCrcCalc = NVSParser.crc32Header(this.buffer, offset);

        const item = {
            nsIndex: nsIndex,
            datatype: datatype,
            span: span,
            chunkIndex: chunkIndex,
            crc32: crc32 >>> 0,
            headerCrcCalc: headerCrcCalc >>> 0,
            headerCrcValid: (crc32 >>> 0) === (headerCrcCalc >>> 0),
            key: key,
            value: null,
            typeName: this.getNVSTypeName(datatype),
            isBlobChunk: false,
            offset: partition ? offset - partition.offset : offset,
            entrySize: 32
        };

        if (nsIndex === 0) {
            const namespaceIndex = await this.view.getUint8(offset + 24);
            item.value = namespaceIndex;
            item.namespace = key;
        } else {
            switch (datatype) {
                case 0x01:
                    item.value = await this.view.getUint8(offset + 24);
                    break;
                case 0x02:
                    item.value = await this.view.getUint16(offset + 24, true);
                    break;
                case 0x04:
                    item.value = await this.view.getUint32(offset + 24, true);
                    break;
                case 0x08:
                    item.value = (await this.view.getBigUint64(offset + 24, true)).toString();
                    break;
                case 0x11:
                    item.value = await this.view.getInt8(offset + 24);
                    break;
                case 0x12:
                    item.value = await this.view.getInt16(offset + 24, true);
                    break;
                case 0x14:
                    item.value = await this.view.getInt32(offset + 24, true);
                    break;
                case 0x18:
                    item.value = (await this.view.getBigInt64(offset + 24, true)).toString();
                    break;
                case 0x21: {
                    const strSize = await this.view.getUint16(offset + 24, true);
                    const strCrc = (await this.view.getUint32(offset + 28, true)) >>> 0;
                    if (strSize > 0 && strSize < 4096 && offset + 32 + strSize <= this.buffer.length) {
                        const strData = new Uint8Array(strSize);
                        for (let i = 0; i < strSize; i++) {
                            strData[i] = await this.view.getUint8(offset + 32 + i);
                        }
                        const allErased = strData.every(b => b === 0xFF);
                        let strValue = '';
                        for (let i = 0; i < strData.length; i++) {
                            if (strData[i] === 0) break;
                            if (strData[i] >= 32 && strData[i] <= 126) {
                                strValue += String.fromCharCode(strData[i]);
                            }
                        }
                        item.value = allErased ? '<erased>' : strValue;
                        item.rawValue = strData;
                        const dataCrcCalc = NVSParser.crc32(strData, 0, strSize);
                        item.dataCrcStored = strCrc >>> 0;
                        item.dataCrcCalc = dataCrcCalc >>> 0;
                        item.dataCrcValid = (dataCrcCalc >>> 0) === (strCrc >>> 0);
                        item.size = strSize;
                        item.entrySize = 32 + strSize;
                    } else {
                        item.value = '<invalid string>';
                        item.size = 0;
                    }
                    break;
                }
                case 0x42: {
                    const blobSize = await this.view.getUint16(offset + 24, true);
                    const blobCrc = (await this.view.getUint32(offset + 28, true)) >>> 0;
                    if (chunkIndex !== 0xFF) {
                        item.chunkIndex = chunkIndex;
                    }
                    if (blobSize > 0 && blobSize < 4096 && offset + 32 + blobSize <= this.buffer.length) {
                        const blobData = new Uint8Array(blobSize);
                        for (let i = 0; i < blobSize; i++) {
                            blobData[i] = await this.view.getUint8(offset + 32 + i);
                        }
                        const allErased = blobData.every(b => b === 0xFF);
                        item.value = allErased ? '<erased>' : NVSParser.bytesToHex(blobData, ' ');
                        item.rawValue = blobData;
                        const dataCrcCalc = NVSParser.crc32(blobData, 0, blobSize);
                        item.dataCrcStored = blobCrc >>> 0;
                        item.dataCrcCalc = dataCrcCalc >>> 0;
                        item.dataCrcValid = (dataCrcCalc >>> 0) === (blobCrc >>> 0);
                        item.size = blobSize;
                        item.entrySize = 32 + blobSize;
                    } else {
                        item.value = '<invalid blob>';
                        item.size = 0;
                    }
                    break;
                }
                case 0x48:
                    item.totalSize = await this.view.getUint32(offset + 24, true);
                    item.chunkCount = await this.view.getUint8(offset + 28);
                    item.chunkStart = await this.view.getUint8(offset + 29);
                    item.isBlobIndex = true;
                    item.value = `${item.chunkCount} chunks, ${item.totalSize} bytes total`;
                    break;
            }
        }

        return item;
    }

    async parse(partition) {
        const NVS_SECTOR_SIZE = 4096;
        const MAX_ENTRY_COUNT = 126;
        const NVS_PAGE_STATE = {
            UNINIT: 0xFFFFFFFF,
            ACTIVE: 0xFFFFFFFE,
            FULL: 0xFFFFFFFC,
            FREEING: 0xFFFFFFF8,
            CORRUPT: 0xFFFFFFF0
        };

        const pages = [];
        const namespaces = new Map();
        namespaces.set(0, '');

        console.log(`[NVS Parse] Starting NVS parse for partition at offset 0x${partition.offset.toString(16)}, length 0x${partition.length.toString(16)}`);

        for (let sectorOffset = 0; sectorOffset < partition.length; sectorOffset += NVS_SECTOR_SIZE) {
            const blockOffset = partition.offset + sectorOffset;
            if (blockOffset + 64 > this.buffer.length) break;

            const state = await this.view.getUint32(blockOffset, true);
            const seq = await this.view.getUint32(blockOffset + 4, true);
            const version = await this.view.getUint8(blockOffset + 8);
            const crc32 = await this.view.getUint32(blockOffset + 28, true);

            const stateBitmap = new Uint8Array(32);
            for (let i = 0; i < 32; i++) {
                stateBitmap[i] = await this.view.getUint8(blockOffset + 32 + i);
            }

            let stateName = 'UNKNOWN';
            if (state === NVS_PAGE_STATE.UNINIT) {
                stateName = 'UNINIT';
                console.log(`[NVS Parse] Page at 0x${blockOffset.toString(16)}: UNINIT, skipping`);
                continue;
            } else if (state === NVS_PAGE_STATE.ACTIVE) {
                stateName = 'ACTIVE';
            } else if (state === NVS_PAGE_STATE.FULL) {
                stateName = 'FULL';
            } else if (state === NVS_PAGE_STATE.FREEING) {
                stateName = 'FREEING';
            } else if (state === NVS_PAGE_STATE.CORRUPT) {
                stateName = 'CORRUPT';
                console.log(`[NVS Parse] Page at 0x${blockOffset.toString(16)}: CORRUPT, skipping`);
                continue;
            }

            console.log(`[NVS Parse] Page at 0x${blockOffset.toString(16)}: state=${stateName}, seq=${seq}, version=${version}`);

            const page = {
                offset: blockOffset,
                state: stateName,
                seq: seq,
                version: version,
                crc32: crc32,
                items: []
            };

            for (let entry = 0; entry < MAX_ENTRY_COUNT; entry++) {
                const itemState = this.getNVSItemState(stateBitmap, entry);
                console.log(`[NVS Parse]   Entry ${entry}: state=${itemState} (0=ERASED, 2=WRITTEN, 3=EMPTY)`);
                if (itemState !== 2) continue;

                const entryOffset = blockOffset + 64 + entry * 32;
                if (entryOffset + 32 > this.buffer.length) break;

                const nsIndex = await this.view.getUint8(entryOffset);
                const datatype = await this.view.getUint8(entryOffset + 1);
                const span = await this.view.getUint8(entryOffset + 2);

                console.log(`[NVS Parse]     nsIndex=${nsIndex}, datatype=0x${datatype.toString(16)}, span=${span}`);

                if (span === 0 || span > 126) {
                    console.warn(`[NVS Parse]     Invalid span ${span} at offset ${entryOffset}, skipping`);
                    continue;
                }

                if (nsIndex === 0 && datatype !== 0xFF && datatype !== 0x00) {
                    const key = await this.readString(entryOffset + 8, 16);
                    const namespaceIndex = await this.view.getUint8(entryOffset + 24);
                    console.log(`[NVS Parse]     Namespace definition: "${key}" -> index ${namespaceIndex}`);
                    if (key && namespaceIndex < 255) {
                        namespaces.set(namespaceIndex, key);
                    }
                }

                const item = await this.parseItem(entryOffset, namespaces, partition);
                if (item) {
                    console.log(`[NVS Parse]     Parsed item: nsIndex=${item.nsIndex}, key="${item.key}", type=${item.typeName}, value=${JSON.stringify(item.value)}`);
                    page.items.push(item);
                    if (item.span > 1) {
                        entry += item.span - 1;
                    }
                } else {
                    console.log(`[NVS Parse]     Item parsing returned null, skipping`);
                }
            }

            if (page.items.length > 0) {
                console.log(`[NVS Parse] Page added with ${page.items.length} items`);
                pages.push(page);
            } else {
                console.log(`[NVS Parse] Page has no items, not added`);
            }
        }

        for (const page of pages) {
            for (const item of page.items) {
                if (item.nsIndex !== undefined && item.nsIndex !== 0) {
                    item.namespace = namespaces.get(item.nsIndex) || `ns_${item.nsIndex}`;
                }
            }
        }

        console.log(`[NVS Parse] Parse complete: ${pages.length} pages, ${pages.reduce((sum, p) => sum + p.items.length, 0)} total items`);
        return pages;
    }

    /**
     * Add a new namespace entry to NVS
     */
    async addNamespace(partition, namespaceName) {
        const NVS_SECTOR_SIZE = 4096;
        const MAX_ENTRY_COUNT = 126;

        let maxNsIndex = 0;
        const usedIndices = new Set();

        for (let sectorOffset = 0; sectorOffset < partition.length; sectorOffset += NVS_SECTOR_SIZE) {
            const blockOffset = partition.offset + sectorOffset;
            if (blockOffset + 64 > this.buffer.length) break;

            const state = await this.view.getUint32(blockOffset, true);
            if (state === 0xFFFFFFFF || state === 0xFFFFFFF0) continue;

            const stateBitmap = new Uint8Array(32);
            for (let i = 0; i < 32; i++) {
                stateBitmap[i] = await this.view.getUint8(blockOffset + 32 + i);
            }

            for (let entry = 0; entry < MAX_ENTRY_COUNT; entry++) {
                const itemState = this.getNVSItemState(stateBitmap, entry);
                if (itemState !== 2) continue;

                const entryOffset = blockOffset + 64 + entry * 32;
                if (entryOffset + 32 > this.buffer.length) break;

                const itemNsIndex = await this.view.getUint8(entryOffset);
                const datatype = await this.view.getUint8(entryOffset + 1);
                const span = await this.view.getUint8(entryOffset + 2);
                const itemKey = await this.readString(entryOffset + 8, 16);

                if (itemNsIndex === 0 && datatype !== 0xFF && datatype !== 0x00) {
                    const existingIndex = await this.view.getUint8(entryOffset + 24);
                    usedIndices.add(existingIndex);
                    if (existingIndex > maxNsIndex) maxNsIndex = existingIndex;

                    if (itemKey === namespaceName) {
                        throw new Error(`Namespace "${namespaceName}" already exists with index ${existingIndex}`);
                    }
                }

                entry += span - 1;
            }
        }

        let newNsIndex = 1;
        while (usedIndices.has(newNsIndex) && newNsIndex < 255) newNsIndex++;
        if (newNsIndex >= 255) throw new Error('No available namespace indices (max 254 namespaces)');

        console.log(`[NVS AddNamespace] Creating namespace "${namespaceName}" with index ${newNsIndex}`);

        const entry = new Uint8Array(32);
        entry[0] = 0;
        entry[1] = 0x01;
        entry[2] = 1;
        entry[3] = 0xFF;

        const keyBytes = new TextEncoder().encode(namespaceName);
        for (let i = 0; i < Math.min(keyBytes.length, 15); i++) entry[8 + i] = keyBytes[i];
        entry[8 + Math.min(keyBytes.length, 15)] = 0;
        entry[24] = newNsIndex;

        const headerCrc = NVSParser.crc32Header(entry);
        new DataView(entry.buffer).setUint32(4, headerCrc, true);

        for (let sectorOffset = 0; sectorOffset < partition.length; sectorOffset += NVS_SECTOR_SIZE) {
            const blockOffset = partition.offset + sectorOffset;
            if (blockOffset + 64 > this.buffer.length) break;
            const state = await this.view.getUint32(blockOffset, true);
            if (state === 0xFFFFFFFF || state === 0xFFFFFFF0) continue;
            if (state !== 0xFFFFFFFE && state !== 0xFFFFFFFC) continue;

            const stateBitmap = new Uint8Array(32);
            for (let i = 0; i < 32; i++) stateBitmap[i] = await this.view.getUint8(blockOffset + 32 + i);

            for (let entryIdx = 0; entryIdx < MAX_ENTRY_COUNT; entryIdx++) {
                const itemState = this.getNVSItemState(stateBitmap, entryIdx);
                if (itemState === 3 || itemState === 0) {
                    const entryOffset = blockOffset + 64 + entryIdx * 32;
                    console.log(`[NVS AddNamespace] Writing namespace definition at entry ${entryIdx}, offset 0x${entryOffset.toString(16)}`);
                    this.sparseImage.write(entryOffset, entry);
                    this.setNVSItemState(stateBitmap, entryIdx, 2);
                    this.sparseImage.write(blockOffset + 32, stateBitmap);
                    console.log(`[NVS AddNamespace] Successfully added namespace "${namespaceName}" with index ${newNsIndex}`);
                    return;
                }
            }
        }

        throw new Error('No space available in NVS partition for namespace definition');
    }

    /**
     * Delete an item by namespace + key
     */
    async deleteItem(partition, namespace, key) {
        const NVS_SECTOR_SIZE = 4096;
        const MAX_ENTRY_COUNT = 126;

        let nsIndex = -1;

        for (let sectorOffset = 0; sectorOffset < partition.length; sectorOffset += NVS_SECTOR_SIZE) {
            const blockOffset = partition.offset + sectorOffset;
            if (blockOffset + 64 > this.buffer.length) break;
            const state = await this.view.getUint32(blockOffset, true);
            if (state === 0xFFFFFFFF || state === 0xFFFFFFF0) continue;

            const stateBitmap = new Uint8Array(32);
            for (let i = 0; i < 32; i++) stateBitmap[i] = await this.view.getUint8(blockOffset + 32 + i);

            for (let entry = 0; entry < MAX_ENTRY_COUNT; entry++) {
                const itemState = this.getNVSItemState(stateBitmap, entry);
                if (itemState !== 2) continue;

                const entryOffset = blockOffset + 64 + entry * 32;
                if (entryOffset + 32 > this.buffer.length) break;

                const itemNsIndex = await this.view.getUint8(entryOffset);
                const datatype = await this.view.getUint8(entryOffset + 1);
                const span = await this.view.getUint8(entryOffset + 2);
                const itemKey = await this.readString(entryOffset + 8, 16);

                if (itemNsIndex === 0 && datatype !== 0xFF && datatype !== 0x00) {
                    const namespaceIndex = await this.view.getUint8(entryOffset + 24);
                    if (itemKey === namespace) nsIndex = namespaceIndex;
                    entry += span - 1;
                    continue;
                }

                if (nsIndex === itemNsIndex && itemKey === key) {
                    for (let slice = 0; slice < span; slice++) {
                        const sliceOffset = entryOffset + slice * 32;
                        const erasedEntry = new Uint8Array(32);
                        erasedEntry.fill(0xFF);
                        this.sparseImage.write(sliceOffset, erasedEntry);
                        this.setNVSItemState(stateBitmap, entry + slice, 3);
                    }
                    this.sparseImage.write(blockOffset + 32, stateBitmap);
                    return;
                }

                entry += span - 1;
            }
        }

        throw new Error(`NVS item ${namespace}.${key} not found`);
    }

    /**
     * Add an item
     */
    async addItem(partition, namespace, key, type, value) {
        const NVS_SECTOR_SIZE = 4096;
        const MAX_ENTRY_COUNT = 126;

        const item = this.createItem(key, type, value);
        let nsIndex = -1;

        for (let sectorOffset = 0; sectorOffset < partition.length; sectorOffset += NVS_SECTOR_SIZE) {
            const blockOffset = partition.offset + sectorOffset;
            if (blockOffset + 64 > this.buffer.length) break;
            const state = await this.view.getUint32(blockOffset, true);
            if (state === 0xFFFFFFFF || state === 0xFFFFFFF0) continue;

            const stateBitmap = new Uint8Array(32);
            for (let i = 0; i < 32; i++) stateBitmap[i] = await this.view.getUint8(blockOffset + 32 + i);

            for (let entry = 0; entry < MAX_ENTRY_COUNT; entry++) {
                const itemState = this.getNVSItemState(stateBitmap, entry);
                if (itemState !== 2) continue;

                const entryOffset = blockOffset + 64 + entry * 32;
                if (entryOffset + 32 > this.buffer.length) break;

                const itemNsIndex = await this.view.getUint8(entryOffset);
                const datatype = await this.view.getUint8(entryOffset + 1);
                const span = await this.view.getUint8(entryOffset + 2);
                const itemKey = await this.readString(entryOffset + 8, 16);

                if (itemNsIndex === 0 && datatype !== 0xFF && datatype !== 0x00 && itemKey === namespace) {
                    nsIndex = await this.view.getUint8(entryOffset + 24);
                }

                entry += span - 1;
            }

            if (nsIndex !== -1) {
                for (let entry = 0; entry < MAX_ENTRY_COUNT && (entry + item.span - 1 < MAX_ENTRY_COUNT); entry++) {
                    let hasSpace = true;
                    for (let slice = 0; slice < item.span; slice++) {
                        const sliceState = this.getNVSItemState(stateBitmap, entry + slice);
                        if (sliceState === 2) { hasSpace = false; break; }
                    }

                    if (hasSpace) {
                        const entryOffset = blockOffset + 64 + entry * 32;
                        item.entries[0][0] = nsIndex;
                        const headerCrc = NVSParser.crc32Header(item.entries[0]);
                        new DataView(item.entries[0].buffer).setUint32(4, headerCrc, true);

                        console.log(`[NVS Add] Writing item at entry ${entry}, nsIndex=${nsIndex}, key="${key}", span=${item.span}`);

                        for (let slice = 0; slice < item.entries.length; slice++) {
                            const sliceOffset = entryOffset + slice * 32;
                            this.sparseImage.write(sliceOffset, item.entries[slice]);
                            this.setNVSItemState(stateBitmap, entry + slice, 2);
                        }

                        this.sparseImage.write(blockOffset + 32, stateBitmap);
                        console.log(`[NVS Add] Successfully added item to partition`);
                        return;
                    }

                    const curState = this.getNVSItemState(stateBitmap, entry);
                    if (curState === 2) {
                        const entryOffset = blockOffset + 64 + entry * 32;
                        const entrySpan = await this.view.getUint8(entryOffset + 2);
                        entry += entrySpan - 1;
                    }
                }
            }
        }

        throw new Error(`No space available in NVS partition or namespace ${namespace} not found`);
    }

    /**
     * Create entries for an item
     */
    createItem(key, type, value) {
        const typeMap = {
            'U8': 0x01, 'U16': 0x02, 'U32': 0x04, 'U64': 0x08,
            'I8': 0x11, 'I16': 0x12, 'I32': 0x14, 'I64': 0x18,
            'String': 0x21, 'Blob': 0x42
        };

        const datatype = typeMap[type];
        if (!datatype) throw new Error(`Unknown type: ${type}`);

        const entry = new Uint8Array(32);
        entry.fill(0xFF);
        entry[0] = 0; /* nsIndex will be set later */
        entry[1] = datatype;
        entry[3] = 0xFF; /* chunkIndex */

        const keyBytes = new TextEncoder().encode(key.substring(0, 15));
        entry.set(keyBytes, 8);
        entry[8 + keyBytes.length] = 0;

        const entries = [];

        switch (type) {
            case 'U8': {
                const val = parseInt(value);
                if (isNaN(val) || val < 0 || val > 255) throw new Error('Invalid U8 value');
                entry[24] = val;
                entry[2] = 1;
                entries.push(entry);
                break;
            }
            case 'U16': {
                const val = parseInt(value);
                if (isNaN(val) || val < 0 || val > 65535) throw new Error('Invalid U16 value');
                new DataView(entry.buffer).setUint16(24, val, true);
                entry[2] = 1;
                entries.push(entry);
                break;
            }
            case 'U32': {
                const val = parseInt(value);
                if (isNaN(val) || val < 0 || val > 4294967295) throw new Error('Invalid U32 value');
                new DataView(entry.buffer).setUint32(24, val, true);
                entry[2] = 1;
                entries.push(entry);
                break;
            }
            case 'U64': {
                const val = BigInt(value);
                if (val < 0n || val > 18446744073709551615n) throw new Error('Invalid U64 value');
                new DataView(entry.buffer).setBigUint64(24, val, true);
                entry[2] = 1;
                entries.push(entry);
                break;
            }
            case 'I8': {
                const val = parseInt(value);
                if (isNaN(val) || val < -128 || val > 127) throw new Error('Invalid I8 value');
                new DataView(entry.buffer).setInt8(24, val);
                entry[2] = 1;
                entries.push(entry);
                break;
            }
            case 'I16': {
                const val = parseInt(value);
                if (isNaN(val) || val < -32768 || val > 32767) throw new Error('Invalid I16 value');
                new DataView(entry.buffer).setInt16(24, val, true);
                entry[2] = 1;
                entries.push(entry);
                break;
            }
            case 'I32': {
                const val = parseInt(value);
                if (isNaN(val) || val < -2147483648 || val > 2147483647) throw new Error('Invalid I32 value');
                new DataView(entry.buffer).setInt32(24, val, true);
                entry[2] = 1;
                entries.push(entry);
                break;
            }
            case 'I64': {
                const val = BigInt(value);
                if (val < -9223372036854775808n || val > 9223372036854775807n) throw new Error('Invalid I64 value');
                new DataView(entry.buffer).setBigInt64(24, val, true);
                entry[2] = 1;
                entries.push(entry);
                break;
            }
            case 'String': {
                const strBytes = new TextEncoder().encode(value);
                if (strBytes.length > 64) throw new Error('String too long (max 64 bytes)');
                new DataView(entry.buffer).setUint16(24, strBytes.length, true);
                const dataCrc = NVSParser.crc32(strBytes);
                new DataView(entry.buffer).setUint32(28, dataCrc, true);
                const span = 1 + Math.ceil(strBytes.length / 32);
                entry[2] = span;
                entries.push(entry);
                const dataEntry = new Uint8Array(32 * (span - 1));
                dataEntry.fill(0xFF);
                dataEntry.set(strBytes, 0);
                for (let i = 0; i < span - 1; i++) entries.push(dataEntry.slice(i * 32, (i + 1) * 32));
                break;
            }
            case 'Blob': {
                const hexBytes = value.split(/\s+/).filter(b => b).map(b => parseInt(b, 16));
                if (hexBytes.some(b => isNaN(b) || b < 0 || b > 255)) throw new Error('Invalid hex bytes');
                if (hexBytes.length > 64) throw new Error('Blob too long (max 64 bytes)');
                const blobData = new Uint8Array(hexBytes);
                new DataView(entry.buffer).setUint16(24, blobData.length, true);
                const dataCrc = NVSParser.crc32(blobData);
                new DataView(entry.buffer).setUint32(28, dataCrc, true);
                const span = 1 + Math.ceil(blobData.length / 32);
                entry[2] = span;
                entry[3] = 0; /* chunkIndex for first chunk */
                entries.push(entry);
                const dataEntry = new Uint8Array(32 * (span - 1));
                dataEntry.fill(0xFF);
                dataEntry.set(blobData, 0);
                for (let i = 0; i < span - 1; i++) entries.push(dataEntry.slice(i * 32, (i + 1) * 32));
                break;
            }
        }

        const headerCrc = NVSParser.crc32Header(entries[0]);
        new DataView(entries[0].buffer).setUint32(4, headerCrc, true);

        return { span: entry[2], entries };
    }

    /**
     * Convenience: update item by deleting and re-adding
     */
    async updateItem(partition, namespace, key, type, value) {
        try { await this.deleteItem(partition, namespace, key); } catch (e) { /* ignore if not exists */ }
        await this.addItem(partition, namespace, key, type, value);
    }

    /**
     * Find item metadata by namespace/key
     */
    async findItem(partition, namespace, key) {
        const NVS_SECTOR_SIZE = 4096;
        const MAX_ENTRY_COUNT = 126;
        let nsIndex = -1;
        for (let sectorOffset = 0; sectorOffset < partition.length; sectorOffset += NVS_SECTOR_SIZE) {
            const blockOffset = partition.offset + sectorOffset;
            if (blockOffset + 64 > this.buffer.length) break;
            const state = await this.view.getUint32(blockOffset, true);
            if (state === 0xFFFFFFFF || state === 0xFFFFFFF0) continue;
            const stateBitmap = new Uint8Array(32);
            for (let i = 0; i < 32; i++) stateBitmap[i] = await this.view.getUint8(blockOffset + 32 + i);
            for (let entry = 0; entry < MAX_ENTRY_COUNT; entry++) {
                const itemState = this.getNVSItemState(stateBitmap, entry);
                if (itemState !== 2) continue;
                const entryOffset = blockOffset + 64 + entry * 32;
                if (entryOffset + 32 > this.buffer.length) break;
                const itemNsIndex = await this.view.getUint8(entryOffset);
                const datatype = await this.view.getUint8(entryOffset + 1);
                const span = await this.view.getUint8(entryOffset + 2);
                const itemKey = await this.readString(entryOffset + 8, 16);
                if (itemNsIndex === 0 && datatype !== 0xFF && datatype !== 0x00) {
                    const namespaceIndex = await this.view.getUint8(entryOffset + 24);
                    if (itemKey === namespace) nsIndex = namespaceIndex;
                    entry += span - 1;
                    continue;
                }
                if (nsIndex === itemNsIndex && itemKey === key) {
                    return { blockOffset, entryIndex: entry, entryOffset, span };
                }
                entry += span - 1;
            }
        }
        return null;
    }
}

// Expose NVSParser globally
window.NVSParser = NVSParser;
