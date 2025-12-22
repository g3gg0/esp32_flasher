// ESP32 Firmware Parser JavaScript Implementation
// Based on the C implementation from esp32.c

/**
 * SparseImage - Abstraction layer for accessing binary data with caching
 * Acts like a Uint8Array but lazily loads data from a device/source through a callback
 * 
 * Use cases:
 * 1. Reading from slow devices (e.g., flash memory over serial)
 * 2. Working with large files where only portions are needed
 * 3. Caching frequently accessed regions
 * 
 * Example usage:
 * ```javascript
 * // Create a SparseImage with a read callback
 * const sparseImage = new SparseImage(1024 * 1024, (address, size) => {
 *     // This callback is called when data is not in cache
 *     // Read from your device here
 *     return deviceRead(address, size); // Should return Uint8Array
 * });
 * 
 * // Wrap in proxy for array-like access
 * const buffer = SparseImage._createProxy(sparseImage);
 * 
 * // Access like a normal Uint8Array - data is fetched automatically
 * const byte = buffer[0x1000];
 * const chunk = buffer.subarray(0x1000, 0x2000);
 * 
 * // Check cache statistics
 * console.log(sparseImage.getStats());
 * ```
 * 
 * Architecture:
 * - ReadBuffer: Array of {address, data} segments containing cached read data
 * - ReadData callback: Called to fetch missing data from device/source
 * - Automatic merging: Adjacent/overlapping segments are merged to optimize memory
 * 
 * Future enhancement:
 * - WriteBuffer: Parallel buffer for tracking writes before committing to device
 *   - Reads check WriteBuffer first, then ReadBuffer
 *   - Allows batching writes and deferred commit operations
 */
class SparseImage {
    constructor(size, readDataCallback = null, writeDataCallback = null, flushPrepareCallback = null, sectorSize = 0x1000) {
        this.size = size;
        this.readDataCallback = readDataCallback;
        this.writeDataCallback = writeDataCallback;
        this.flushPrepareCallback = flushPrepareCallback;
        this.sectorSize = sectorSize || 0x1000;
        this.readBuffer = []; // Array of {address, data} structures
        this.writeBuffer = []; // Array of {address, data} structures
        this.length = size;
        /* Lock to ensure _ensureData executes serially */
        this._ensureDataLock = Promise.resolve();
    }

    /**
     * Initialize from an existing ArrayBuffer/Uint8Array
     */
    static fromBuffer(arrayBuffer, sectorSize = 0x1000) {
        const buffer = arrayBuffer instanceof Uint8Array ? arrayBuffer : new Uint8Array(arrayBuffer);
        const sparseImage = new SparseImage(buffer.length, null, null, null, sectorSize);
        sparseImage.readBuffer.push({
            address: 0,
            data: buffer
        });
        return sparseImage;
    }

    /**
     * Find which buffer segment contains the given address
     */
    _findSegment(address, list = this.readBuffer) {
        for (const segment of list) {
            const endAddress = segment.address + segment.data.length;
            if (address >= segment.address && address < endAddress) {
                return segment;
            }
        }
        return null;
    }

    /**
     * Check if a range is fully covered by existing segments
     */
    _isRangeCovered(address, size, list = this.readBuffer) {
        let checkPos = address;
        const endAddress = address + size;

        while (checkPos < endAddress) {
            const segment = this._findSegment(checkPos, list);
            if (!segment) {
                return false;
            }
            checkPos = segment.address + segment.data.length;
        }
        return true;
    }

    /**
     * Check if a range is covered by either write or read buffers
     */
    _isRangeCoveredAny(address, size) {
        let checkPos = address;
        const endAddress = address + size;
        while (checkPos < endAddress) {
            const w = this._findSegment(checkPos, this.writeBuffer);
            if (w) {
                checkPos = Math.min(endAddress, w.address + w.data.length);
                continue;
            }
            const r = this._findSegment(checkPos, this.readBuffer);
            if (r) {
                checkPos = Math.min(endAddress, r.address + r.data.length);
                continue;
            }
            return false;
        }
        return true;
    }

    /**
     * Find the first gap within [address, address+size) not covered by write/read buffers.
     * Returns { start, size } or null if fully covered.
     */
    _findFirstGapRange(address, size) {
        const endAddress = address + size;
        let pos = address;
        while (pos < endAddress) {
            const w = this._findSegment(pos, this.writeBuffer);
            if (w) {
                pos = Math.min(endAddress, w.address + w.data.length);
                continue;
            }
            const r = this._findSegment(pos, this.readBuffer);
            if (r) {
                pos = Math.min(endAddress, r.address + r.data.length);
                continue;
            }
            /* pos is not covered: determine gap end at next segment start or endAddress */
            let nextStart = endAddress;
            for (const s of this.writeBuffer) {
                if (s.address > pos && s.address < nextStart) nextStart = s.address;
            }
            for (const s of this.readBuffer) {
                if (s.address > pos && s.address < nextStart) nextStart = s.address;
            }
            return { start: pos, size: nextStart - pos };
        }
        return null;
    }

    _mergeSegmentsGeneric(list) {
        if (list.length <= 1) return list;

        const indexed = list.map((segment, idx) => ({ ...segment, _idx: idx }));
        indexed.sort((a, b) => {
            if (a.address === b.address) {
                return a._idx - b._idx;
            }
            return a.address - b.address;
        });

        const merged = [];
        let current = indexed[0];

        for (let i = 1; i < indexed.length; i++) {
            const next = indexed[i];
            const currentEnd = current.address + current.data.length;

            if (next.address <= currentEnd) {
                const mergedEnd = Math.max(currentEnd, next.address + next.data.length);
                const mergedSize = mergedEnd - current.address;
                const mergedData = new Uint8Array(mergedSize);
                mergedData.set(current.data, 0);
                const nextOffset = next.address - current.address;
                mergedData.set(next.data, nextOffset);
                current = {
                    address: current.address,
                    data: mergedData
                };
            } else {
                merged.push({ address: current.address, data: current.data });
                current = next;
            }
        }
        merged.push({ address: current.address, data: current.data });
        return merged;
    }

    /**
     * Merge adjacent or overlapping segments in the readBuffer
     */
    _mergeSegments() {
        this.readBuffer = this._mergeSegmentsGeneric(this.readBuffer);
    }

    _mergeWriteSegments() {
        this.writeBuffer = this._mergeSegmentsGeneric(this.writeBuffer);
    }

    _effectiveByte(pos) {
        const w = this._findSegment(pos, this.writeBuffer);
        if (w) return w.data[pos - w.address] & 0xFF;
        const r = this._findSegment(pos, this.readBuffer);
        if (r) return r.data[pos - r.address] & 0xFF;
        return 0xFF;
    }

    _materializeRange(start, end) {
        const len = end - start;
        const out = new Uint8Array(len);
        out.fill(0xFF);

        for (const seg of this.readBuffer) {
            const s0 = seg.address;
            const s1 = seg.address + seg.data.length;
            const o0 = Math.max(start, s0);
            const o1 = Math.min(end, s1);
            if (o0 < o1) {
                const dstOff = o0 - start;
                const srcOff = o0 - s0;
                out.set(seg.data.subarray(srcOff, srcOff + (o1 - o0)), dstOff);
            }
        }

        for (const seg of this.writeBuffer) {
            const s0 = seg.address;
            const s1 = seg.address + seg.data.length;
            const o0 = Math.max(start, s0);
            const o1 = Math.min(end, s1);
            if (o0 < o1) {
                const dstOff = o0 - start;
                const srcOff = o0 - s0;
                out.set(seg.data.subarray(srcOff, srcOff + (o1 - o0)), dstOff);
            }
        }

        return out;
    }

    _materializeReadRange(start, end) {
        const len = end - start;
        const out = new Uint8Array(len);
        out.fill(0xFF);

        for (const seg of this.readBuffer) {
            const s0 = seg.address;
            const s1 = seg.address + seg.data.length;
            const o0 = Math.max(start, s0);
            const o1 = Math.min(end, s1);
            if (o0 < o1) {
                const dstOff = o0 - start;
                const srcOff = o0 - s0;
                out.set(seg.data.subarray(srcOff, srcOff + (o1 - o0)), dstOff);
            }
        }

        return out;
    }

    _addSegment(list, address, data) {
        list.push({ address, data });
        return this._mergeSegmentsGeneric(list);
    }

    /**
     * Read data from the sparse image, fetching from device if necessary
     */
    async _ensureData(address, size) {
        /* Acquire lock to ensure only one _ensureData executes at a time */
        return this._ensureDataLock = this._ensureDataLock.then(() =>
            this._ensureDataUnlocked(address, size)
        );
    }

    /**
     * Internal _ensureData implementation (unlocked)
     * @private
     */
    async _ensureDataUnlocked(address, size) {
        if (address < 0 || address >= this.size) {
            throw new RangeError(`Address ${address} out of bounds [0, ${this.size})`);
        }

        // Clamp size to available data
        size = Math.min(size, this.size - address);

        // If range is already covered by write or read cache, nothing to do
        if (this._isRangeCoveredAny(address, size)) return;

        // Fill gaps: either by read callback (preferred) or zero-fill if no callback
        let safety = 64;
        while (!this._isRangeCoveredAny(address, size) && safety-- > 0) {
            const gap = this._findFirstGapRange(address, size);
            if (!gap || gap.size <= 0) break;

            if (!this.readDataCallback) {
                /* No callback - create zero segment only for the uncovered gap */
                const data = new Uint8Array(gap.size);
                this.readBuffer = this._addSegment(this.readBuffer, gap.start, data);
                continue;
            }

            /* Call the callback; it may return more/less and with its own base address */
            const res = await this.readDataCallback(gap.start, gap.size);
            let a = null;
            let d = null;
            if (res instanceof Uint8Array) {
                a = gap.start;
                d = res;
            } else if (res && res.buffer instanceof ArrayBuffer && res.byteLength !== undefined) {
                /* Accept ArrayBufferView-like */
                a = gap.start;
                d = new Uint8Array(res.buffer, res.byteOffset || 0, res.byteLength);
            } else if (res && typeof res === 'object') {
                const rAddr = res.address !== undefined ? res.address : gap.start;
                const rData = res.data;
                if (rData instanceof Uint8Array) {
                    a = rAddr;
                    d = rData;
                } else if (rData && rData.buffer instanceof ArrayBuffer && rData.byteLength !== undefined) {
                    a = rAddr;
                    d = new Uint8Array(rData.buffer, rData.byteOffset || 0, rData.byteLength);
                }
            }

            if (d && d.length > 0) {
                this.readBuffer = this._addSegment(this.readBuffer, a, d);
                // loop will re-check coverage
            } else {
                // No progress possible from callback, avoid infinite loop
                break;
            }
        }
    }

    write(address, data) {
        if (address < 0 || address >= this.size) {
            throw new RangeError(`Address ${address} out of bounds [0, ${this.size})`);
        }
        const normalized = data instanceof Uint8Array ? data : new Uint8Array(data);
        const start = address;
        const end = Math.min(address + normalized.length, this.size);
        if (end <= start) return;

        const fmtRanges = (list) => list.map(s => `[0x${s.address.toString(16)}-0x${(s.address + s.data.length).toString(16)})`).join(', ');
        const preRanges = fmtRanges(this.writeBuffer);
        console.log('SparseImage.write start', { address: start, length: normalized.length, preRanges });

        /* Determine which sectors are touched by this write */
        const touched = new Set();
        for (let pos = start; pos < end; pos = Math.min(end, Math.floor(pos / this.sectorSize + 1) * this.sectorSize)) {
            const sectorStart = Math.floor(pos / this.sectorSize) * this.sectorSize;
            touched.add(sectorStart);
        }

        const newWrite = [];

        /* Preserve existing write data for sectors not touched by this write */
        for (const seg of this.writeBuffer) {
            const segStart = seg.address;
            const segEnd = seg.address + seg.data.length;
            let pos = segStart;
            while (pos < segEnd) {
                const sectorStart = Math.floor(pos / this.sectorSize) * this.sectorSize;
                const sectorEnd = Math.min(sectorStart + this.sectorSize, this.size);
                const sliceStart = Math.max(segStart, sectorStart);
                const sliceEnd = Math.min(segEnd, sectorEnd);
                const len = sliceEnd - sliceStart;
                if (!touched.has(sectorStart) && len > 0) {
                    const offset = sliceStart - segStart;
                    const slice = seg.data.slice(offset, offset + len);
                    newWrite.push({ address: sliceStart, data: slice });
                }
                pos = sectorEnd;
            }
        }

        /* Build sector-aligned buffers for touched sectors */
        for (const sectorStart of touched) {
            const sectorEnd = Math.min(sectorStart + this.sectorSize, this.size);
            const sectorBuf = this._materializeRange(sectorStart, sectorEnd);

            /* Overlay incoming data where it intersects this sector */
            const writeStart = Math.max(start, sectorStart);
            const writeEnd = Math.min(end, sectorEnd);
            for (let pos = writeStart; pos < writeEnd; pos++) {
                const desired = normalized[pos - start] & 0xFF;
                const cur = sectorBuf[pos - sectorStart] & 0xFF;
                if (desired !== cur) {
                    sectorBuf[pos - sectorStart] = desired;
                }
            }

            /* Drop sector if it matches read cache (no pending changes) */
            const baseline = this._materializeReadRange(sectorStart, sectorEnd);
            let identical = baseline.length === sectorBuf.length;
            if (identical) {
                for (let i = 0; i < sectorBuf.length; i++) {
                    if (sectorBuf[i] !== baseline[i]) {
                        identical = false;
                        break;
                    }
                }
            }
            if (!identical) {
                newWrite.push({ address: sectorStart, data: sectorBuf });
            }
        }

        this.writeBuffer = this._mergeSegmentsGeneric(newWrite);

        const postRanges = fmtRanges(this.writeBuffer);
        console.log('SparseImage.write done', { address: start, length: normalized.length, preRanges, postRanges });
    }

    fill(value, start = 0, end = this.size) {
        if (start < 0 || start >= this.size) {
            throw new RangeError(`Address ${start} out of bounds [0, ${this.size})`);
        }
        end = Math.min(end, this.size);
        if (end <= start) return;

        const desired = value & 0xFF;
        const len = end - start;
        const buf = new Uint8Array(len);
        buf.fill(desired);
        console.log('SparseImage.fill', { start, end, len, desired });
        this.write(start, buf);
    }

    async flush() {
        if (!this.writeBuffer.length) return;

        // Consolidate write segments first (touching/overlapping writes coalesce)
        this._mergeWriteSegments();

        /* Call prepare callback if provided */
        if (this.flushPrepareCallback) {
            await this.flushPrepareCallback(this);
        }

        // Flush to backing store if provided
        if (this.writeDataCallback) {
            // Deterministic order: ascending address
            const toWrite = [...this.writeBuffer].sort((a, b) => a.address - b.address);
            for (const segment of toWrite) {
                await this.writeDataCallback(segment.address, segment.data);
            }
        }

        // Merge read+write with explicit priority: write data overrides read data
        this.readBuffer = this._mergeReadAndWriteWithPriority(this.readBuffer, this.writeBuffer);

        // Clear pending writes
        this.writeBuffer = [];
    }

    /**
     * Merge read and write buffers into a single read buffer, ensuring
     * write data has priority over read data in any overlap. Touching
     * segments are merged into a single continuous segment.
     */
    _mergeReadAndWriteWithPriority(readList, writeList) {
        if ((!readList || readList.length === 0) && (!writeList || writeList.length === 0)) {
            return [];
        }

        const annotated = [];
        if (readList && readList.length) {
            for (const s of readList) annotated.push({ address: s.address, data: s.data, _src: 'r' });
        }
        if (writeList && writeList.length) {
            for (const s of writeList) annotated.push({ address: s.address, data: s.data, _src: 'w' });
        }

        // Sort by address to form contiguous/touching groups
        annotated.sort((a, b) => a.address - b.address);

        const result = [];
        let group = [];
        let groupStart = null;
        let groupEnd = null;

        const flushGroup = () => {
            if (!group.length) return;
            const length = groupEnd - groupStart;
            const mergedData = new Uint8Array(length);

            // Overlay order: read first, then write (write overrides)
            for (const seg of group) {
                if (seg._src !== 'r') continue;
                const off = seg.address - groupStart;
                mergedData.set(seg.data, off);
            }
            for (const seg of group) {
                if (seg._src !== 'w') continue;
                const off = seg.address - groupStart;
                mergedData.set(seg.data, off);
            }

            result.push({ address: groupStart, data: mergedData });
            group = [];
            groupStart = null;
            groupEnd = null;
        };

        for (const seg of annotated) {
            const segStart = seg.address;
            const segEnd = seg.address + seg.data.length;
            if (groupStart === null) {
                // start new group
                groupStart = segStart;
                groupEnd = segEnd;
                group.push(seg);
                continue;
            }
            // Merge if overlapping or touching
            if (segStart <= groupEnd) {
                group.push(seg);
                if (segEnd > groupEnd) groupEnd = segEnd;
            } else {
                // Gap: finalize previous group
                flushGroup();
                // start new group
                groupStart = segStart;
                groupEnd = segEnd;
                group.push(seg);
            }
        }

        flushGroup();
        return result;
    }

    /**
     * Get a single byte at the given offset (Uint8Array-like interface)
     * NOTE: Assumes data is already loaded. Use async methods to ensure data first.
     */
    _get(index) {
        if (index < 0 || index >= this.size) {
            return undefined;
        }

        // Write buffer overrides read buffer
        const wseg = this._findSegment(index, this.writeBuffer);
        if (wseg) {
            return wseg.data[index - wseg.address];
        }

        const segment = this._findSegment(index, this.readBuffer);
        if (!segment) {
            return 0; // Return 0 for unread data
        }

        return segment.data[index - segment.address];
    }

    /**
     * Proxy handler to make SparseImage act like a Uint8Array
     */
    static _createProxy(sparseImage) {
        return new Proxy(sparseImage, {
            get(target, prop) {
                if (typeof prop === 'symbol') {
                    return target[prop];
                }
                // Handle numeric indices
                const index = Number(prop);
                if (Number.isInteger(index) && index >= 0) {
                    return target._get(index);
                }

                // Handle standard properties and methods
                if (prop in target) {
                    const value = target[prop];
                    return typeof value === 'function' ? value.bind(target) : value;
                }

                return undefined;
            },

            set(target, prop, value) {
                if (typeof prop === 'symbol') {
                    target[prop] = value;
                    return true;
                }
                const index = Number(prop);
                if (Number.isInteger(index) && index >= 0) {
                    const byte = Number(value) & 0xFF;
                    target.write(index, Uint8Array.of(byte));
                    return true;
                }

                target[prop] = value;
                return true;
            },

            has(target, prop) {
                if (typeof prop === 'symbol') {
                    return prop in target;
                }
                const index = Number(prop);
                if (Number.isInteger(index) && index >= 0 && index < target.size) {
                    return true;
                }
                return prop in target;
            }
        });
    }

    /**
     * Get a subarray (similar to Uint8Array.subarray)
     * SYNC version - assumes data is already loaded via prefetch/ensureData
     */
    subarray(start, end) {
        start = start || 0;
        end = end === undefined ? this.size : end;

        const size = end - start;

        const result = new Uint8Array(size);
        for (let pos = start, idx = 0; pos < end; pos++, idx++) {
            result[idx] = this._get(pos);
        }

        return result;
    }

    /**
     * Get a subarray asynchronously (ensures data is loaded first)
     */
    async subarray_async(start, end) {
        start = start || 0;
        end = end === undefined ? this.size : end;

        const size = end - start;

        // Ensure all data is loaded first
        await this._ensureData(start, size);

        const result = new Uint8Array(size);
        for (let pos = start, idx = 0; pos < end; pos++, idx++) {
            result[idx] = this._get(pos);
        }

        return result;
    }

    /**
     * Get a slice (creates a copy, similar to Uint8Array.slice)
     * SYNC version - assumes data is already loaded
     */
    slice(start, end) {
        return this.subarray(start, end);
    }

    /**
     * Get a slice asynchronously (ensures data is loaded first)
     */
    async slice_async(start, end) {
        return await this.subarray_async(start, end);
    }

    /**
     * Create a DataView for this SparseImage
     */
    createDataView() {
        return new SparseImageDataView(this);
    }

    /**
     * Get statistics about the sparse image
     */
    getStats() {
        let totalCached = 0;
        const segments = [];

        for (const segment of this.readBuffer) {
            totalCached += segment.data.length;
            segments.push({
                address: segment.address,
                size: segment.data.length,
                endAddress: segment.address + segment.data.length
            });
        }

        return {
            totalSize: this.size,
            cachedBytes: totalCached,
            cachedPercent: (totalCached / this.size * 100).toFixed(2),
            segmentCount: this.readBuffer.length,
            segments: segments
        };
    }

    /**
     * Clear all cached data
     */
    clearCache() {
        this.readBuffer = [];
    }

    /**
     * Pre-fetch a range of data
     */
    async prefetch(address, size) {
        return await this._ensureData(address, size);
    }
}


class FATParser {
    constructor(sparseImage) {
        if (!sparseImage) {
            throw new Error('FATParser requires a SparseImage');
        }
        this.sparseImage = sparseImage;
        this.buffer = SparseImage._createProxy(sparseImage);
        this.view = sparseImage.createDataView();
    }

    async parseWearLeveling(partition) {
        const WL_SECTOR_SIZE = 0x1000;
        const WL_STATE_RECORD_SIZE = 16;
        const WL_STATE_COPY_COUNT = 2;
        const offset = partition.offset;
        const length = partition.length;

        const totalSectors = Math.floor(length / WL_SECTOR_SIZE);
        const wlStateSize = 64 + WL_STATE_RECORD_SIZE * totalSectors;
        const wlStateSectors = Math.ceil(wlStateSize / WL_SECTOR_SIZE);
        const wlSectorsSize = (wlStateSectors * WL_SECTOR_SIZE * WL_STATE_COPY_COUNT) + WL_SECTOR_SIZE;
        const fatSectors = totalSectors - 1 - (WL_STATE_COPY_COUNT * wlStateSectors);

        const stateOffset = offset + length - wlSectorsSize;
        if (stateOffset + 64 > this.sparseImage.size) {
            return { error: 'Cannot read wear leveling state' };
        }

        const wlState = {
            pos: await this.view.getUint32(stateOffset, true),
            maxPos: await this.view.getUint32(stateOffset + 4, true),
            moveCount: await this.view.getUint32(stateOffset + 8, true),
            accessCount: await this.view.getUint32(stateOffset + 12, true),
            maxCount: await this.view.getUint32(stateOffset + 16, true),
            blockSize: await this.view.getUint32(stateOffset + 20, true),
            version: await this.view.getUint32(stateOffset + 24, true),
            deviceId: await this.view.getUint32(stateOffset + 28, true)
        };

        let totalRecords = 0;
        let recordOffset = stateOffset + 64;
        for (let i = 0; i < wlStateSize && recordOffset + WL_STATE_RECORD_SIZE <= this.sparseImage.size; i++) {
            let isEmpty = true;
            for (let j = 0; j < WL_STATE_RECORD_SIZE; j++) {
                if ((await this.view.getUint8(recordOffset + j)) !== 0xFF) {
                    isEmpty = false;
                    break;
                }
            }
            if (isEmpty) break;
            totalRecords++;
            recordOffset += WL_STATE_RECORD_SIZE;
        }

        return {
            wlState: wlState,
            totalSectors: totalSectors,
            wlSectorsSize: wlSectorsSize,
            fatSectors: fatSectors,
            totalRecords: totalRecords,
            dataOffset: offset,
            dataSize: length - wlSectorsSize
        };
    }

    wlTranslateSector(wlInfo, sector) {
        let translated = (sector + wlInfo.wlState.moveCount) % wlInfo.fatSectors;
        if (translated >= wlInfo.totalRecords) {
            translated += 1;
        }
        return translated;
    }

    async parse(partition) {
        const WL_SECTOR_SIZE = 0x1000;
        const wlInfo = await this.parseWearLeveling(partition);
        if (wlInfo.error) {
            return { error: wlInfo.error };
        }

        const sector0Physical = this.wlTranslateSector(wlInfo, 0);
        const bootSectorOffset = partition.offset + sector0Physical * WL_SECTOR_SIZE;
        if (bootSectorOffset + 512 > this.sparseImage.size) {
            return { error: 'Cannot read FAT boot sector' };
        }

        const bootSig = await this.view.getUint16(bootSectorOffset + 510, true);
        if (bootSig !== 0xAA55) {
            return { error: `Invalid boot sector signature: 0x${bootSig.toString(16).toUpperCase()} (expected 0xAA55)` };
        }

        const bytesPerSector = await this.view.getUint16(bootSectorOffset + 11, true);
        const sectorsPerCluster = await this.view.getUint8(bootSectorOffset + 13);
        const reservedSectors = await this.view.getUint16(bootSectorOffset + 14, true);
        const numFATs = await this.view.getUint8(bootSectorOffset + 16);
        const rootEntryCount = await this.view.getUint16(bootSectorOffset + 17, true);
        const totalSectors16 = await this.view.getUint16(bootSectorOffset + 19, true);
        const sectorsPerFAT = await this.view.getUint16(bootSectorOffset + 22, true);
        const totalSectors32 = await this.view.getUint32(bootSectorOffset + 32, true);

        if (bytesPerSector === 0 || sectorsPerCluster === 0 || numFATs === 0) {
            return { error: 'Invalid FAT boot sector parameters' };
        }

        const totalSectors = totalSectors16 || totalSectors32;
        const rootDirSectors = Math.ceil((rootEntryCount * 32) / bytesPerSector);
        const firstDataSector = reservedSectors + (numFATs * sectorsPerFAT) + rootDirSectors;
        const dataSectors = totalSectors - firstDataSector;
        const totalClusters = Math.floor(dataSectors / sectorsPerCluster);

        let fatType;
        if (totalClusters < 4085) fatType = 'FAT12';
        else if (totalClusters < 65525) fatType = 'FAT16';
        else fatType = 'FAT32';

        let volumeLabel = '';
        for (let i = 0; i < 11; i++) {
            const c = await this.view.getUint8(bootSectorOffset + 43 + i);
            if (c === 0 || c === 0x20) break;
            volumeLabel += String.fromCharCode(c);
        }

        const rootDirOffset = partition.offset +
            this.wlTranslateSector(wlInfo, reservedSectors + numFATs * sectorsPerFAT) * WL_SECTOR_SIZE;

        const files = await this.parseDirectory(partition, wlInfo, rootDirOffset, rootEntryCount,
            bytesPerSector, sectorsPerCluster, reservedSectors, numFATs, sectorsPerFAT, '', true);

        return {
            fatType: fatType,
            volumeLabel: volumeLabel || '(no label)',
            bytesPerSector: bytesPerSector,
            sectorsPerCluster: sectorsPerCluster,
            reservedSectors: reservedSectors,
            numFATs: numFATs,
            sectorsPerFAT: sectorsPerFAT,
            totalSectors: totalSectors,
            totalClusters: totalClusters,
            files: files,
            wearLeveling: wlInfo
        };
    }

    async parseDirectory(partition, wlInfo, dirOffset, maxEntries, bytesPerSector, sectorsPerCluster,
        reservedSectors, numFATs, sectorsPerFAT, parentPath, isRoot = false) {
        const WL_SECTOR_SIZE = 0x1000;
        const files = [];
        const firstDataSector = reservedSectors + numFATs * sectorsPerFAT +
            Math.ceil((maxEntries || 512) * 32 / bytesPerSector);

        const maxIter = isRoot ? maxEntries : 512;

        for (let i = 0; i < maxIter; i++) {
            const entryOffset = dirOffset + i * 32;
            if (entryOffset + 32 > this.sparseImage.size) break;
            const firstByte = await this.view.getUint8(entryOffset);
            if (firstByte === 0x00) break;
            if (firstByte === 0xE5 || firstByte === 0x05) continue;
            const attr = await this.view.getUint8(entryOffset + 11);
            if (attr === 0x0F) continue;
            if (attr & 0x08) continue;

            let name = '';
            for (let j = 0; j < 8; j++) {
                const c = await this.view.getUint8(entryOffset + j);
                if (c !== 0x20 && c >= 0x20 && c <= 0x7E) name += String.fromCharCode(c);
            }
            let ext = '';
            for (let j = 0; j < 3; j++) {
                const c = await this.view.getUint8(entryOffset + 8 + j);
                if (c !== 0x20 && c >= 0x20 && c <= 0x7E) ext += String.fromCharCode(c);
            }
            if (name.length === 0 || name === '.' || name === '..') continue;
            if (ext) name += '.' + ext;

            const size = await this.view.getUint32(entryOffset + 28, true);
            const cluster = await this.view.getUint16(entryOffset + 26, true);

            const attributes = [];
            if (attr & 0x01) attributes.push('Read-only');
            if (attr & 0x02) attributes.push('Hidden');
            if (attr & 0x04) attributes.push('System');
            if (attr & 0x08) attributes.push('Volume');
            if (attr & 0x10) attributes.push('Directory');
            if (attr & 0x20) attributes.push('Archive');

            const date = await this.view.getUint16(entryOffset + 24, true);
            const time = await this.view.getUint16(entryOffset + 22, true);
            const year = ((date >> 9) & 0x7F) + 1980;
            const month = (date >> 5) & 0x0F;
            const day = date & 0x1F;
            const hour = (time >> 11) & 0x1F;
            const minute = (time >> 5) & 0x3F;
            const second = (time & 0x1F) * 2;

            const isDirectory = !!(attr & 0x10);
            const fullPath = parentPath ? `${parentPath}/${name}` : name;

            const fileEntry = {
                name: name,
                path: fullPath,
                size: size,
                cluster: cluster,
                attributes: attributes,
                isDirectory: isDirectory,
                date: `${year}-${month.toString().padStart(2, '0')}-${day.toString().padStart(2, '0')}`,
                time: `${hour.toString().padStart(2, '0')}:${minute.toString().padStart(2, '0')}:${second.toString().padStart(2, '0')}`
            };

            files.push(fileEntry);

            if (isDirectory && cluster >= 2 && cluster < 0xFFF0) {
                const clusterSector = firstDataSector + (cluster - 2) * sectorsPerCluster;
                const clusterOffset = partition.offset +
                    this.wlTranslateSector(wlInfo, clusterSector) * WL_SECTOR_SIZE;

                if (clusterOffset + sectorsPerCluster * WL_SECTOR_SIZE <= this.sparseImage.size) {
                    const subFiles = await this.parseDirectory(partition, wlInfo, clusterOffset, null,
                        bytesPerSector, sectorsPerCluster, reservedSectors, numFATs, sectorsPerFAT, fullPath, false);
                    fileEntry.children = subFiles;
                }
            }
        }

        return files;
    }

    async readFATEntry(partition, wlInfo, fatOffset, cluster, fatType) {
        const WL_SECTOR_SIZE = 0x1000;
        if (fatType === 'FAT12') {
            const entryOffset = fatOffset + Math.floor(cluster * 1.5);
            const sector = Math.floor(entryOffset / WL_SECTOR_SIZE);
            const sectorOffset = partition.offset + this.wlTranslateSector(wlInfo, sector) * WL_SECTOR_SIZE;
            const byteOffset = entryOffset % WL_SECTOR_SIZE;
            const val = await this.view.getUint16(sectorOffset + byteOffset, true);
            if (cluster & 1) {
                return val >> 4;
            } else {
                return val & 0x0FFF;
            }
        } else if (fatType === 'FAT16') {
            const entryOffset = fatOffset + cluster * 2;
            const sector = Math.floor(entryOffset / WL_SECTOR_SIZE);
            const sectorOffset = partition.offset + this.wlTranslateSector(wlInfo, sector) * WL_SECTOR_SIZE;
            const byteOffset = entryOffset % WL_SECTOR_SIZE;
            return await this.view.getUint16(sectorOffset + byteOffset, true);
        } else {
            const entryOffset = fatOffset + cluster * 4;
            const sector = Math.floor(entryOffset / WL_SECTOR_SIZE);
            const sectorOffset = partition.offset + this.wlTranslateSector(wlInfo, sector) * WL_SECTOR_SIZE;
            const byteOffset = entryOffset % WL_SECTOR_SIZE;
            return (await this.view.getUint32(sectorOffset + byteOffset, true)) & 0x0FFFFFFF;
        }
    }

    async extractFile(partition, fatInfo, fileEntry) {
        const WL_SECTOR_SIZE = 0x1000;
        const wlInfo = fatInfo.wearLeveling;
        const bytesPerCluster = fatInfo.bytesPerSector * fatInfo.sectorsPerCluster;
        const fatOffset = fatInfo.reservedSectors * WL_SECTOR_SIZE;
        const firstDataSector = fatInfo.reservedSectors + fatInfo.numFATs * fatInfo.sectorsPerFAT +
            Math.ceil(512 * 32 / fatInfo.bytesPerSector);

        const clusters = [];
        let currentCluster = fileEntry.cluster;
        const maxClusters = Math.ceil(fileEntry.size / bytesPerCluster) + 10;

        while (currentCluster >= 2 && currentCluster < 0xFFF0 && clusters.length < maxClusters) {
            clusters.push(currentCluster);
            currentCluster = await this.readFATEntry(partition, wlInfo, fatOffset, currentCluster, fatInfo.fatType);
        }

        const fileData = new Uint8Array(fileEntry.size);
        let bytesRead = 0;

        for (const cluster of clusters) {
            const clusterSector = firstDataSector + (cluster - 2) * fatInfo.sectorsPerCluster;
            const clusterOffset = partition.offset +
                this.wlTranslateSector(wlInfo, clusterSector) * WL_SECTOR_SIZE;

            const bytesToRead = Math.min(bytesPerCluster, fileEntry.size - bytesRead);
            if (clusterOffset + bytesToRead <= this.sparseImage.size) {
                fileData.set(await this.buffer.slice_async(clusterOffset, clusterOffset + bytesToRead), bytesRead);
                bytesRead += bytesToRead;
            }
            if (bytesRead >= fileEntry.size) break;
        }

        return new Blob([fileData], { type: 'application/octet-stream' });
    }
}



class SpiffsParser {
    constructor(sparseImage) {
        if (!sparseImage) {
            throw new Error('SpiffsParser requires a SparseImage');
        }
        this.sparseImage = sparseImage;
        this.buffer = SparseImage._createProxy(sparseImage);
        this.view = sparseImage.createDataView();
    }

    async parse(partition) {
        const offset = partition.offset;
        const size = partition.length;

        console.log(`[SPIFFS] Parsing partition at offset 0x${offset.toString(16)}, size ${size} bytes`);

        const defaultBlockSize = 4096;
        const headerData = await this.buffer.slice_async(offset, offset + Math.min(defaultBlockSize, size));
        const view = new DataView(headerData.buffer, headerData.byteOffset);

        let magic = 0;
        let pageSize = 256;
        let blockSizeActual = 4096;
        let validHeader = false;

        console.log(`[SPIFFS] Scanning for magic number...`);
        for (let i = 0; i < Math.min(512, headerData.length - 4); i += 4) {
            try {
                const testMagic = view.getUint32(i, true);
                if (testMagic === 0x20160902) {
                    magic = testMagic;
                    validHeader = true;
                    console.log(`[SPIFFS] Found magic at offset 0x${i.toString(16)}`);
                    if (i + 16 <= headerData.length) {
                        const cfgPhysSize = view.getUint32(i + 4, true);
                        const cfgLogBlockSize = view.getUint32(i + 8, true);
                        const cfgLogPageSize = view.getUint32(i + 12, true);
                        console.log(`[SPIFFS] Config: phys=${cfgPhysSize}, blockSize=${cfgLogBlockSize}, pageSize=${cfgLogPageSize}`);
                        if (cfgLogBlockSize > 0 && cfgLogBlockSize <= 65536 &&
                            cfgLogPageSize > 0 && cfgLogPageSize <= 2048) {
                            blockSizeActual = cfgLogBlockSize;
                            pageSize = cfgLogPageSize;
                        }
                    }
                    break;
                }
            } catch (e) {
                continue;
            }
        }

        if (!validHeader) {
            console.log(`[SPIFFS] No magic found, trying pattern detection...`);
            validHeader = await this.detectByPattern(headerData);
            console.log(`[SPIFFS] Pattern detection result: ${validHeader}`);
        }

        const files = [];
        const pagesPerBlock = Math.floor(blockSizeActual / pageSize);
        console.log(`[SPIFFS] Config: blockSize=${blockSizeActual}, pageSize=${pageSize}, pagesPerBlock=${pagesPerBlock}`);
        console.log(`[SPIFFS] Scanning ${Math.floor(size / blockSizeActual)} blocks...`);

        for (let blockIdx = 0; blockIdx < Math.floor(size / blockSizeActual); blockIdx++) {
            const blockOffset = offset + blockIdx * blockSizeActual;
            console.log(`[SPIFFS] ===== Block ${blockIdx}: offset 0x${blockOffset.toString(16)} =====`);
            const blockData = await this.buffer.slice_async(blockOffset, blockOffset + Math.min(blockSizeActual, size - blockIdx * blockSizeActual));

            for (let pageIdx = 0; pageIdx < pagesPerBlock; pageIdx++) {
                const pageStart = pageIdx * pageSize;
                if (pageStart + pageSize > blockData.length) break;

                const objId = blockData[pageStart] | (blockData[pageStart + 1] << 8);
                const span = blockData[pageStart + 2] | (blockData[pageStart + 3] << 8);
                const flags = blockData[pageStart + 4];

                if (objId === 0xFFFF || objId === 0x0000) continue;

                let fileSize = 0;
                let type = 0;
                let nameStr = '[NO NAME]';
                const isIndexHeader = (span === 0);

                if (isIndexHeader) {
                    if (pageStart + 12 <= blockData.length) {
                        fileSize = (blockData[pageStart + 8] |
                            (blockData[pageStart + 9] << 8) |
                            (blockData[pageStart + 10] << 16) |
                            (blockData[pageStart + 11] << 24)) >>> 0;
                    }
                    type = blockData[pageStart + 12];
                    const nameStartIdx = pageStart + 13;
                    if (nameStartIdx < blockData.length) {
                        let nameBytes = [];
                        for (let i = nameStartIdx; i < Math.min(nameStartIdx + 256, pageStart + pageSize); i++) {
                            if (blockData[i] === 0 || blockData[i] === 0xFF) break;
                            if (blockData[i] >= 32 && blockData[i] < 127) nameBytes.push(blockData[i]); else break;
                        }
                        if (nameBytes.length > 0) nameStr = String.fromCharCode(...nameBytes);
                    }
                }

                const isDeleted = (flags & 0x80) === 0;
                console.log(`[SPIFFS] ===== Page at Block ${blockIdx}, Page ${pageIdx} (offset 0x${pageStart.toString(16)}) =====`);
                console.log(`[SPIFFS]   Offset 0-1: obj_id = 0x${objId.toString(16).padStart(4, '0')}`);
                console.log(`[SPIFFS]   Offset 2-3: span_ix = ${span} (0x${span.toString(16).padStart(4, '0')})`);
                console.log(`[SPIFFS]   Offset 4:   flags = 0x${flags.toString(16).padStart(2, '0')} ${isDeleted ? '[DELETED]' : '[VALID]'}`);

                if (isIndexHeader) {
                    const sizeIsUndefined = fileSize === 0xFFFFFFFF;
                    const sizeLog = sizeIsUndefined ? 'undefined (0xFFFFFFFF)' : `${fileSize} bytes (0x${fileSize.toString(16)})`;
                    console.log(`[SPIFFS]   Offset 8-11: size = ${sizeLog}`);
                    console.log(`[SPIFFS]   Offset 12:   type = ${type} (${type === 0x01 ? 'FILE' : type === 0x02 ? 'DIR' : 'UNKNOWN'})`);
                    console.log(`[SPIFFS]   Offset 13+:  name = "${nameStr}"`);

                    if ((type === 0x01 || type === 0x02) && nameStr !== '[NO NAME]' && nameStr.startsWith('/')) {
                        const displayName = isDeleted ? `${nameStr} (deleted)` : nameStr;
                        files.push({
                            name: displayName,
                            objId: objId,
                            size: fileSize > 0 && fileSize < 0xFFFFFFFF ? fileSize : 0,
                            blockIdx: blockIdx,
                            pageIdx: pageIdx,
                            type: type,
                            span: span,
                            flags: flags,
                            deleted: isDeleted
                        });
                        console.log(`[SPIFFS] ✓ Added to file list: "${displayName}" (deleted=${isDeleted})`);
                    } else {
                        console.log(`[SPIFFS] ⊘ Skipped: not a valid file (type=${type}, name="${nameStr}")`);
                    }
                } else {
                    console.log(`[SPIFFS]   (Data page, span_ix=${span})`);
                }
            }
        }

        console.log(`[SPIFFS] Parsing complete. Found ${files.length} files.`);
        return {
            valid: validHeader || files.length > 0,
            magic: magic,
            blockSize: blockSizeActual,
            pageSize: pageSize,
            totalSize: size,
            files: files,
            filesCount: files.length
        };
    }

    async detectByPattern(data) {
        let foundPattern = false;
        for (let i = 0; i < Math.min(2048, data.length - 64); i += 256) {
            const b0 = data[i];
            const b1 = data[i + 1];
            const flags = data[i + 2];
            const objId = b0 | (b1 << 8);
            if (objId !== 0xFFFF && objId !== 0x0000 && flags !== 0xFF) {
                for (let j = i + 12; j < i + 64 && j < data.length; j++) {
                    if (data[j] === 0x2F) {
                        console.log(`[SPIFFS] Pattern detected at offset 0x${i.toString(16)}: objId=0x${objId.toString(16)}, flags=0x${flags.toString(16)}`);
                        foundPattern = true;
                        break;
                    }
                }
                if (foundPattern) break;
            }
        }
        return foundPattern;
    }

    async readFile(partition, file, spiffsInfo) {
        const offset = partition.offset;
        const blockSize = spiffsInfo.blockSize;
        const pageSize = spiffsInfo.pageSize;
        const pagesPerBlock = Math.floor(blockSize / pageSize);
        const fileSize = file.size >>> 0;

        console.log(`[SPIFFS] ========== Reading file "${file.name}" ==========`);
        console.log(`[SPIFFS] objId(header)=0x${file.objId.toString(16)}, size=${fileSize} bytes`);
        console.log(`[SPIFFS] Header page: block=${file.blockIdx}, page=${file.pageIdx}`);

        if (!fileSize) {
            console.log(`[SPIFFS] File size is 0, returning empty array`);
            return new Uint8Array(0);
        }

        const IX_FLAG_MASK = 0x8000;
        const dataObjId = (file.objId & ~IX_FLAG_MASK) & 0xFFFF;

        const totalBlocks = Math.floor(spiffsInfo.totalSize / blockSize) || Math.floor(partition.length / blockSize);
        const dataHeaderLen = 5;
        const dataPerPage = pageSize - dataHeaderLen;

        const spixToAddr = new Map();
        let pagesFound = 0;
        console.log(`[SPIFFS] Scanning for data pages: target obj_id=0x${dataObjId.toString(16)}`);

        for (let blk = 0; blk < totalBlocks; blk++) {
            const blockBase = offset + blk * blockSize;
            const blockData = await this.buffer.slice_async(blockBase, blockBase + blockSize);
            for (let pg = 0; pg < pagesPerBlock; pg++) {
                const pageOffInBlock = pg * pageSize;
                if (pageOffInBlock + dataHeaderLen > blockData.length) break;
                const objId = blockData[pageOffInBlock] | (blockData[pageOffInBlock + 1] << 8);
                const span = blockData[pageOffInBlock + 2] | (blockData[pageOffInBlock + 3] << 8);
                const flags = blockData[pageOffInBlock + 4];
                if (objId === 0xFFFF || objId === 0x0000) continue;
                const isDeleted = (flags & 0x80) === 0;
                if (isDeleted) continue;
                if (objId === dataObjId) {
                    const paddr = blockBase + pageOffInBlock;
                    if (!spixToAddr.has(span)) {
                        spixToAddr.set(span, paddr);
                        pagesFound++;
                        if (pagesFound <= 8) {
                            console.log(`[SPIFFS]   Data page: blk=${blk}, pg=${pg}, span_ix=${span}, paddr=0x${paddr.toString(16)}`);
                        }
                    }
                }
            }
        }

        console.log(`[SPIFFS] Found ${pagesFound} data pages for obj_id=0x${dataObjId.toString(16)} (data_per_page=${dataPerPage})`);
        if (pagesFound === 0) {
            const headerOffset = offset + file.blockIdx * blockSize + file.pageIdx * pageSize;
            const naiveContent = headerOffset + pageSize;
            console.warn(`[SPIFFS] WARNING: No data pages found via scan. Falling back to next-page heuristic at 0x${naiveContent.toString(16)}`);
            const fileData = await this.buffer.slice_async(naiveContent, naiveContent + fileSize);
            console.log(`[SPIFFS] Fallback read first 32 bytes: ${Array.from(fileData.slice(0, 32)).map(b => b.toString(16).padStart(2, '0')).join(' ')}`);
            return fileData;
        }

        const out = new Uint8Array(fileSize);
        let curOff = 0;
        let logPreview = [];
        while (curOff < fileSize) {
            const spix = Math.floor(curOff / dataPerPage);
            const pageOff = curOff % dataPerPage;
            const lenToRead = Math.min(fileSize - curOff, dataPerPage - pageOff);
            if (!spixToAddr.has(spix)) {
                console.warn(`[SPIFFS] Missing data page for span_ix=${spix}, filling with 0xFF for ${lenToRead} bytes`);
                out.fill(0xFF, curOff, curOff + lenToRead);
                curOff += lenToRead;
                continue;
            }
            const paddr = spixToAddr.get(spix);
            const dataStart = paddr + dataHeaderLen + pageOff;
            const dataEnd = dataStart + lenToRead;
            const chunk = await this.buffer.slice_async(dataStart, dataEnd);
            out.set(chunk, curOff);
            if (logPreview.length < 4) {
                logPreview.push({ spix, paddr: dataStart, len: lenToRead });
            }
            curOff += lenToRead;
        }

        console.log(`[SPIFFS] Read complete: ${out.length} bytes`);
        if (logPreview.length) {
            for (const e of logPreview) {
                console.log(`[SPIFFS]   Read spix=${e.spix} at 0x${e.paddr.toString(16)} len=${e.len}`);
            }
        }
        console.log(`[SPIFFS] First 32 bytes (hex): ${Array.from(out.slice(0, 32)).map(b => b.toString(16).padStart(2, '0')).join(' ')}`);
        return out;
    }
}

class OTADataParser {
    constructor(sparseImage) {
        if (!sparseImage) {
            throw new Error('OTADataParser requires a SparseImage');
        }
        this.sparseImage = sparseImage;
        
        // CRC32 lookup table for esp_rom_crc32_le
        this.crc32_le_table = new Uint32Array([
            0x00000000, 0x77073096, 0xee0e612c, 0x990951ba, 0x076dc419, 0x706af48f, 0xe963a535, 0x9e6495a3,
            0x0edb8832, 0x79dcb8a4, 0xe0d5e91e, 0x97d2d988, 0x09b64c2b, 0x7eb17cbd, 0xe7b82d07, 0x90bf1d91,
            0x1db71064, 0x6ab020f2, 0xf3b97148, 0x84be41de, 0x1adad47d, 0x6ddde4eb, 0xf4d4b551, 0x83d385c7,
            0x136c9856, 0x646ba8c0, 0xfd62f97a, 0x8a65c9ec, 0x14015c4f, 0x63066cd9, 0xfa0f3d63, 0x8d080df5,
            0x3b6e20c8, 0x4c69105e, 0xd56041e4, 0xa2677172, 0x3c03e4d1, 0x4b04d447, 0xd20d85fd, 0xa50ab56b,
            0x35b5a8fa, 0x42b2986c, 0xdbbbc9d6, 0xacbcf940, 0x32d86ce3, 0x45df5c75, 0xdcd60dcf, 0xabd13d59,
            0x26d930ac, 0x51de003a, 0xc8d75180, 0xbfd06116, 0x21b4f4b5, 0x56b3c423, 0xcfba9599, 0xb8bda50f,
            0x2802b89e, 0x5f058808, 0xc60cd9b2, 0xb10be924, 0x2f6f7c87, 0x58684c11, 0xc1611dab, 0xb6662d3d,
            0x76dc4190, 0x01db7106, 0x98d220bc, 0xefd5102a, 0x71b18589, 0x06b6b51f, 0x9fbfe4a5, 0xe8b8d433,
            0x7807c9a2, 0x0f00f934, 0x9609a88e, 0xe10e9818, 0x7f6a0dbb, 0x086d3d2d, 0x91646c97, 0xe6635c01,
            0x6b6b51f4, 0x1c6c6162, 0x856530d8, 0xf262004e, 0x6c0695ed, 0x1b01a57b, 0x8208f4c1, 0xf50fc457,
            0x65b0d9c6, 0x12b7e950, 0x8bbeb8ea, 0xfcb9887c, 0x62dd1ddf, 0x15da2d49, 0x8cd37cf3, 0xfbd44c65,
            0x4db26158, 0x3ab551ce, 0xa3bc0074, 0xd4bb30e2, 0x4adfa541, 0x3dd895d7, 0xa4d1c46d, 0xd3d6f4fb,
            0x4369e96a, 0x346ed9fc, 0xad678846, 0xda60b8d0, 0x44042d73, 0x33031de5, 0xaa0a4c5f, 0xdd0d7cc9,
            0x5005713c, 0x270241aa, 0xbe0b1010, 0xc90c2086, 0x5768b525, 0x206f85b3, 0xb966d409, 0xce61e49f,
            0x5edef90e, 0x29d9c998, 0xb0d09822, 0xc7d7a8b4, 0x59b33d17, 0x2eb40d81, 0xb7bd5c3b, 0xc0ba6cad,

            0xedb88320, 0x9abfb3b6, 0x03b6e20c, 0x74b1d29a, 0xead54739, 0x9dd277af, 0x04db2615, 0x73dc1683,
            0xe3630b12, 0x94643b84, 0x0d6d6a3e, 0x7a6a5aa8, 0xe40ecf0b, 0x9309ff9d, 0x0a00ae27, 0x7d079eb1,
            0xf00f9344, 0x8708a3d2, 0x1e01f268, 0x6906c2fe, 0xf762575d, 0x806567cb, 0x196c3671, 0x6e6b06e7,
            0xfed41b76, 0x89d32be0, 0x10da7a5a, 0x67dd4acc, 0xf9b9df6f, 0x8ebeeff9, 0x17b7be43, 0x60b08ed5,
            0xd6d6a3e8, 0xa1d1937e, 0x38d8c2c4, 0x4fdff252, 0xd1bb67f1, 0xa6bc5767, 0x3fb506dd, 0x48b2364b,
            0xd80d2bda, 0xaf0a1b4c, 0x36034af6, 0x41047a60, 0xdf60efc3, 0xa867df55, 0x316e8eef, 0x4669be79,
            0xcb61b38c, 0xbc66831a, 0x256fd2a0, 0x5268e236, 0xcc0c7795, 0xbb0b4703, 0x220216b9, 0x5505262f,
            0xc5ba3bbe, 0xb2bd0b28, 0x2bb45a92, 0x5cb36a04, 0xc2d7ffa7, 0xb5d0cf31, 0x2cd99e8b, 0x5bdeae1d,
            0x9b64c2b0, 0xec63f226, 0x756aa39c, 0x026d930a, 0x9c0906a9, 0xeb0e363f, 0x72076785, 0x05005713,
            0x95bf4a82, 0xe2b87a14, 0x7bb12bae, 0x0cb61b38, 0x92d28e9b, 0xe5d5be0d, 0x7cdcefb7, 0x0bdbdf21,
            0x86d3d2d4, 0xf1d4e242, 0x68ddb3f8, 0x1fda836e, 0x81be16cd, 0xf6b9265b, 0x6fb077e1, 0x18b74777,
            0x88085ae6, 0xff0f6a70, 0x66063bca, 0x11010b5c, 0x8f659eff, 0xf862ae69, 0x616bffd3, 0x166ccf45,
            0xa00ae278, 0xd70dd2ee, 0x4e048354, 0x3903b3c2, 0xa7672661, 0xd06016f7, 0x4969474d, 0x3e6e77db,
            0xaed16a4a, 0xd9d65adc, 0x40df0b66, 0x37d83bf0, 0xa9bcae53, 0xdebb9ec5, 0x47b2cf7f, 0x30b5ffe9,
            0xbdbdf21c, 0xcabac28a, 0x53b39330, 0x24b4a3a6, 0xbad03605, 0xcdd70693, 0x54de5729, 0x23d967bf,
            0xb3667a2e, 0xc4614ab8, 0x5d681b02, 0x2a6f2b94, 0xb40bbe37, 0xc30c8ea1, 0x5a05df1b, 0x2d02ef8d
        ]);
    }
    

    async parse(partition) {
        const OTA_DATA_SIZE = 0x1000;  // 4096 bytes (one sector)
        const data = await this.sparseImage.subarray_async(partition.offset, partition.offset + (OTA_DATA_SIZE * 2));
        
        // ESP32 IDF uses two sectors to store information about which partition is running
        // They are defined as the OTA data partition, two esp_ota_select_entry_t structures
        // are saved in the two sectors, named otadata[0] (first sector) and otadata[1] (second sector)
        // 
        // If otadata[0].ota_seq == otadata[1].ota_seq == 0xFFFFFFFF, OTA info partition is in init status
        // So it will boot factory application (if there is), otherwise boot ota[0]
        // 
        // If both ota_seq != 0, it will choose max seq, and calculate (max_seq - 1) % max_ota_app_number
        // to determine which OTA partition to boot (subtype mask 0x0F)
        
        // OTA image states
        const ESP_OTA_IMG_NEW = 0x0;
        const ESP_OTA_IMG_PENDING_VERIFY = 0x1;
        const ESP_OTA_IMG_VALID = 0x2;
        const ESP_OTA_IMG_INVALID = 0x3;
        const ESP_OTA_IMG_ABORTED = 0x4;
        const ESP_OTA_IMG_UNDEFINED = 0xFFFFFFFF;
        
        const entries = [];
        for (let i = 0; i < 2; i++) {
            const offset = i * OTA_DATA_SIZE;
            const view = new DataView(data.buffer, data.byteOffset + offset, OTA_DATA_SIZE);
            
            const seq = view.getUint32(0, true);
            const otaState = view.getUint32(24, true);  // Read as uint32
            const crc = view.getUint32(28, true);
            
            // CRC32 is calculated over first 4 bytes (sequence number) using esp_rom_crc32_le(UINT32_MAX, &ota_seq, 4)
            const dataForCRC = new Uint8Array(data.buffer, data.byteOffset + offset, 4);
            const calculatedCRC = this.calculateCRC32(dataForCRC);
            const crcValid = crc === calculatedCRC;
            
            // Entry is invalid if: seq == 0xFFFFFFFF OR ota_state == INVALID OR ota_state == ABORTED
            const isInvalid = seq === 0xFFFFFFFF || otaState === ESP_OTA_IMG_INVALID || otaState === ESP_OTA_IMG_ABORTED;
            
            // Entry is valid if: NOT invalid AND CRC matches
            const isValid = !isInvalid && crcValid;
            
            entries.push({
                index: i,
                sequence: seq,
                otaState: otaState,
                otaStateName: this.getOTAStateName(otaState),
                crc: crc,
                calculatedCRC: calculatedCRC,
                crcValid: crcValid,
                isValid: isValid,
                isEmpty: seq === 0xFFFFFFFF
            });
        }

        // Determine which entry is active using bootloader_common_get_active_otadata logic
        // Both must be valid, then choose highest sequence
        let activeEntry = null;
        if (entries[0].isValid && entries[1].isValid) {
            activeEntry = entries[0].sequence > entries[1].sequence ? 0 : 1;
        } else if (entries[0].isValid) {
            activeEntry = 0;
        } else if (entries[1].isValid) {
            activeEntry = 1;
        }

        return {
            entries: entries,
            activeEntry: activeEntry
        };
    }

    getOTAStateName(state) {
        const states = {
            0x0: 'NEW',
            0x1: 'PENDING_VERIFY',
            0x2: 'VALID',
            0x3: 'INVALID',
            0x4: 'ABORTED',
            0xFFFFFFFF: 'UNDEFINED'
        };
        return states[state] || `Unknown (0x${state.toString(16)})`;
    }

    // CRC32 using esp_rom_crc32_le() algorithm with lookup table
    // Matches ROM implementation: esp_rom_crc32_le(UINT32_MAX, &ota_seq, 4)
    calculateCRC32(data) {
        let crc = 0;  // Input 0xFFFFFFFF gets inverted to 0
        for (let i = 0; i < data.length; i++) {
            crc = this.crc32_le_table[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
        }
        return (~crc) >>> 0;  // Invert and return
    }
}

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
        if (offset + 32 > this.sparseImage.size) {
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
                    if (strSize > 0 && strSize < 4096 && offset + 32 + strSize <= this.sparseImage.size) {
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
                    if (blobSize > 0 && blobSize < 4096 && offset + 32 + blobSize <= this.sparseImage.size) {
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

        //console.log(`[NVS Parse] Starting NVS parse for partition at offset 0x${partition.offset.toString(16)}, length 0x${partition.length.toString(16)}`);

        for (let sectorOffset = 0; sectorOffset < partition.length; sectorOffset += NVS_SECTOR_SIZE) {
            const blockOffset = partition.offset + sectorOffset;
            if (blockOffset + 64 > this.sparseImage.size) break;

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
                //console.log(`[NVS Parse] Page at 0x${blockOffset.toString(16)}: UNINIT, skipping`);
                continue;
            } else if (state === NVS_PAGE_STATE.ACTIVE) {
                stateName = 'ACTIVE';
            } else if (state === NVS_PAGE_STATE.FULL) {
                stateName = 'FULL';
            } else if (state === NVS_PAGE_STATE.FREEING) {
                stateName = 'FREEING';
            } else if (state === NVS_PAGE_STATE.CORRUPT) {
                stateName = 'CORRUPT';
                //console.log(`[NVS Parse] Page at 0x${blockOffset.toString(16)}: CORRUPT, skipping`);
                continue;
            }

            //console.log(`[NVS Parse] Page at 0x${blockOffset.toString(16)}: state=${stateName}, seq=${seq}, version=${version}`);

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
                //console.log(`[NVS Parse]   Entry ${entry}: state=${itemState} (0=ERASED, 2=WRITTEN, 3=EMPTY)`);
                if (itemState !== 2) continue;

                const entryOffset = blockOffset + 64 + entry * 32;
                if (entryOffset + 32 > this.sparseImage.size) break;

                const nsIndex = await this.view.getUint8(entryOffset);
                const datatype = await this.view.getUint8(entryOffset + 1);
                const span = await this.view.getUint8(entryOffset + 2);

                //console.log(`[NVS Parse]     nsIndex=${nsIndex}, datatype=0x${datatype.toString(16)}, span=${span}`);

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
                    //console.log(`[NVS Parse]     Parsed item: nsIndex=${item.nsIndex}, key="${item.key}", type=${item.typeName}, value=${JSON.stringify(item.value)}`);
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

        //console.log(`[NVS Parse] Parse complete: ${pages.length} pages, ${pages.reduce((sum, p) => sum + p.items.length, 0)} total items`);
        return pages;
    }

    /**
     * Build a map of namespace names to their indices
     * Returns: { name: index, ... }
     */
    async buildNamespaceMap(partition) {
        const NVS_SECTOR_SIZE = 4096;
        const MAX_ENTRY_COUNT = 126;
        const namespaceMap = {};

        for (let sectorOffset = 0; sectorOffset < partition.length; sectorOffset += NVS_SECTOR_SIZE) {
            const blockOffset = partition.offset + sectorOffset;
            if (blockOffset + 64 > this.sparseImage.size) break;
            const state = await this.view.getUint32(blockOffset, true);
            if (state === 0xFFFFFFFF || state === 0xFFFFFFF0) continue;

            const stateBitmap = new Uint8Array(32);
            for (let i = 0; i < 32; i++) stateBitmap[i] = await this.view.getUint8(blockOffset + 32 + i);

            for (let entry = 0; entry < MAX_ENTRY_COUNT; entry++) {
                const itemState = this.getNVSItemState(stateBitmap, entry);
                if (itemState !== 2) continue;

                const entryOffset = blockOffset + 64 + entry * 32;
                if (entryOffset + 32 > this.sparseImage.size) break;

                const itemNsIndex = await this.view.getUint8(entryOffset);
                const datatype = await this.view.getUint8(entryOffset + 1);
                const span = await this.view.getUint8(entryOffset + 2);

                if (itemNsIndex === 0 && datatype !== 0xFF && datatype !== 0x00) {
                    const itemKey = await this.readString(entryOffset + 8, 16);
                    const namespaceIndex = await this.view.getUint8(entryOffset + 24);
                    if (itemKey && namespaceIndex < 255) {
                        namespaceMap[itemKey] = namespaceIndex;
                    }
                }

                entry += span - 1;
            }
        }

        return namespaceMap;
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
            if (blockOffset + 64 > this.sparseImage.size) break;

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
                if (entryOffset + 32 > this.sparseImage.size) break;

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
            if (blockOffset + 64 > this.sparseImage.size) break;
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

        console.log(`[NVS Delete] Starting delete for ${namespace}.${key}`);
        
        // Build namespace map first
        const namespaceMap = await this.buildNamespaceMap(partition);
        console.log(`[NVS Delete] Namespace map:`, namespaceMap);
        
        const nsIndex = namespaceMap[namespace];
        if (nsIndex === undefined) {
            console.log(`[NVS Delete] Namespace "${namespace}" not found in map`);
            throw new Error(`NVS namespace ${namespace} not found`);
        }
        console.log(`[NVS Delete] Target namespace "${namespace}" has index ${nsIndex}`);

        for (let sectorOffset = 0; sectorOffset < partition.length; sectorOffset += NVS_SECTOR_SIZE) {
            const blockOffset = partition.offset + sectorOffset;
            if (blockOffset + 64 > this.sparseImage.size) break;
            const state = await this.view.getUint32(blockOffset, true);
            if (state === 0xFFFFFFFF || state === 0xFFFFFFF0) continue;

            const stateName =
                state === 0xFFFFFFFF ? 'UNINIT' :
                state === 0xFFFFFFFE ? 'ACTIVE' :
                state === 0xFFFFFFFC ? 'FULL' :
                state === 0xFFFFFFF8 ? 'FREEING' :
                state === 0xFFFFFFF0 ? 'CORRUPT' : `UNKNOWN(0x${state.toString(16)})`;
            console.log(`[NVS Delete] Scanning page at 0x${blockOffset.toString(16)} state=${stateName}`);

            const stateBitmap = new Uint8Array(32);
            for (let i = 0; i < 32; i++) stateBitmap[i] = await this.view.getUint8(blockOffset + 32 + i);

            for (let entry = 0; entry < MAX_ENTRY_COUNT; entry++) {
                const itemState = this.getNVSItemState(stateBitmap, entry);
                if (itemState !== 2) continue;

                const entryOffset = blockOffset + 64 + entry * 32;
                if (entryOffset + 32 > this.sparseImage.size) break;

                const itemNsIndex = await this.view.getUint8(entryOffset);
                const datatype = await this.view.getUint8(entryOffset + 1);
                const span = await this.view.getUint8(entryOffset + 2);
                const itemKey = await this.readString(entryOffset + 8, 16);

                console.log(`[NVS Delete]   Entry ${entry}: ns=${itemNsIndex}, type=0x${datatype.toString(16)}, span=${span}, key="${itemKey}"`);

                // Skip namespace definitions
                if (itemNsIndex === 0) {
                    entry += span - 1;
                    continue;
                }

                if (itemNsIndex === nsIndex && itemKey === key) {
                    console.log(`[NVS Delete]   Found target item at entry ${entry}, offset 0x${entryOffset.toString(16)}, span=${span}. Erasing...`);
                    for (let slice = 0; slice < span; slice++) {
                        const sliceOffset = entryOffset + slice * 32;
                        const erasedEntry = new Uint8Array(32);
                        erasedEntry.fill(0xFF);
                        this.sparseImage.write(sliceOffset, erasedEntry);
                        this.setNVSItemState(stateBitmap, entry + slice, 3);
                    }
                    this.sparseImage.write(blockOffset + 32, stateBitmap);
                    console.log(`[NVS Delete]   Erase complete and state bitmap updated for page at 0x${blockOffset.toString(16)}`);
                    return;
                }

                entry += span - 1;
            }
        }

        console.log(`[NVS Delete] Item ${namespace}.${key} not found (nsIndex=${nsIndex})`);
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
            if (blockOffset + 64 > this.sparseImage.size) break;
            const state = await this.view.getUint32(blockOffset, true);
            if (state === 0xFFFFFFFF || state === 0xFFFFFFF0) continue;

            const stateBitmap = new Uint8Array(32);
            for (let i = 0; i < 32; i++) stateBitmap[i] = await this.view.getUint8(blockOffset + 32 + i);

            for (let entry = 0; entry < MAX_ENTRY_COUNT; entry++) {
                const itemState = this.getNVSItemState(stateBitmap, entry);
                if (itemState !== 2) continue;

                const entryOffset = blockOffset + 64 + entry * 32;
                if (entryOffset + 32 > this.sparseImage.size) break;

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
            if (blockOffset + 64 > this.sparseImage.size) break;
            const state = await this.view.getUint32(blockOffset, true);
            if (state === 0xFFFFFFFF || state === 0xFFFFFFF0) continue;
            const stateBitmap = new Uint8Array(32);
            for (let i = 0; i < 32; i++) stateBitmap[i] = await this.view.getUint8(blockOffset + 32 + i);
            for (let entry = 0; entry < MAX_ENTRY_COUNT; entry++) {
                const itemState = this.getNVSItemState(stateBitmap, entry);
                if (itemState !== 2) continue;
                const entryOffset = blockOffset + 64 + entry * 32;
                if (entryOffset + 32 > this.sparseImage.size) break;
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


/**
 * DataView-like wrapper for SparseImage
 */
class SparseImageDataView {
    constructor(sparseImage) {
        this.sparseImage = sparseImage;
        this.byteLength = sparseImage.size;
    }

    async _ensureData(offset, size) {
        await this.sparseImage._ensureData(offset, size);
    }

    async getUint8(offset) {
        await this._ensureData(offset, 1);
        return this.sparseImage._get(offset);
    }

    async getInt8(offset) {
        const val = await this.getUint8(offset);
        return val > 127 ? val - 256 : val;
    }

    async getUint16(offset, littleEndian = false) {
        await this._ensureData(offset, 2);
        const b0 = this.sparseImage._get(offset);
        const b1 = this.sparseImage._get(offset + 1);
        return littleEndian ? (b1 << 8) | b0 : (b0 << 8) | b1;
    }

    async getInt16(offset, littleEndian = false) {
        const val = await this.getUint16(offset, littleEndian);
        return val > 32767 ? val - 65536 : val;
    }

    async getUint32(offset, littleEndian = false) {
        await this._ensureData(offset, 4);
        const b0 = this.sparseImage._get(offset);
        const b1 = this.sparseImage._get(offset + 1);
        const b2 = this.sparseImage._get(offset + 2);
        const b3 = this.sparseImage._get(offset + 3);
        return (littleEndian
            ? (b3 << 24) | (b2 << 16) | (b1 << 8) | b0
            : (b0 << 24) | (b1 << 16) | (b2 << 8) | b3) >>> 0; /* Force unsigned 32-bit */
    }

    async getInt32(offset, littleEndian = false) {
        return await this.getUint32(offset, littleEndian) | 0;
    }

    async getBigUint64(offset, littleEndian = false) {
        await this._ensureData(offset, 8);
        if (littleEndian) {
            const low = await this.getUint32(offset, true);
            const high = await this.getUint32(offset + 4, true);
            return (BigInt(high) << 32n) | BigInt(low);
        } else {
            const high = await this.getUint32(offset, false);
            const low = await this.getUint32(offset + 4, false);
            return (BigInt(high) << 32n) | BigInt(low);
        }
    }

    async getBigInt64(offset, littleEndian = false) {
        return await this.getBigUint64(offset, littleEndian);
    }
}

class ESP32Parser {
    constructor(input, readDataCallback = null, writeDataCallback = null, sizeHint = null) {
        // Cases:
        // 1) input is SparseImage
        // 2) input is Uint8Array/ArrayBuffer (eager data)
        // 3) input is number (size) with readDataCallback (and optional writeDataCallback)
        // 4) input is null/undefined but readDataCallback provided with sizeHint

        if (input instanceof SparseImage) {
            this.sparseImage = input;
            this.buffer = SparseImage._createProxy(input);
            this.view = input.createDataView();
        } else if (input instanceof Uint8Array || input instanceof ArrayBuffer) {
            // Eager buffer path, backward compatible
            const si = SparseImage.fromBuffer(input);
            this.sparseImage = si;
            this.buffer = SparseImage._createProxy(si);
            this.view = si.createDataView();
        } else if (typeof input === 'number') {
            // Size provided directly
            const size = input;
            const si = new SparseImage(size, readDataCallback, writeDataCallback);
            this.sparseImage = si;
            this.buffer = SparseImage._createProxy(si);
            this.view = si.createDataView();
        } else if ((input === null || input === undefined) && readDataCallback) {
            // Lazy-only path needs a size hint
            const size = sizeHint ?? 0;
            const si = new SparseImage(size, readDataCallback, writeDataCallback);
            this.sparseImage = si;
            this.buffer = SparseImage._createProxy(si);
            this.view = si.createDataView();
        } else {
            throw new Error('Invalid constructor arguments for ESP32Parser. Provide Uint8Array/ArrayBuffer, SparseImage, or size with readDataCallback.');
        }

        this.partitions = [];
        this.nvsData = [];
    }

    // Helper functions
    static bytesToHex(bytes, separator = '') {
        return Array.from(bytes)
            .map(b => b.toString(16).padStart(2, '0').toUpperCase())
            .join(separator);
    }

    static crc32Byte(crc, d) {
        // Process exactly 8 bits of the byte, matching esp32.c behavior
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
            crc = ESP32Parser.crc32Byte(crc, data[offset + i]);
        }
        return (~crc) >>> 0;
    }

    static crc32Header(data, offset = 0) {
        const buf = new Uint8Array(0x20 - 4);
        buf.set(data.subarray(offset, offset + 4), 0);
        buf.set(data.subarray(offset + 8, offset + 8 + 0x18), 4);
        return ESP32Parser.crc32(buf, 0, 0x1C);
    }

    // Calculate SHA256 hash using Web Crypto API
    static async calculateSHA256(data) {
        const hashBuffer = await crypto.subtle.digest('SHA-256', data);
        return new Uint8Array(hashBuffer);
    }

    // Calculate SHA1 hash using Web Crypto API
    static async calculateSHA1(data) {
        const hashBuffer = await crypto.subtle.digest('SHA-1', data);
        return new Uint8Array(hashBuffer);
    }

    // Quick check if partition has valid ESP32 image magic
    async hasValidImageMagic(partition) {
        if (partition.offset >= this.sparseImage.size) {
            return false;
        }

        const magic = await this.view.getUint8(partition.offset);
        return magic === 0xE9;
    }

    // Parse partition table
    async parsePartitions(offset = 0x9000) {
        const partitions = [];
        let currentOffset = offset;
        let num = 0;

        this.partitionTableOffset = offset;

        while (currentOffset + 32 <= this.sparseImage.size) {
            const magic = await this.view.getUint16(currentOffset, true);

            if (magic !== 0x50AA) {
                break;
            }

            const partition = {
                num: num,
                magic: magic,
                type: await this.view.getUint8(currentOffset + 2),
                subType: await this.view.getUint8(currentOffset + 3),
                offset: await this.view.getUint32(currentOffset + 4, true),
                length: await this.view.getUint32(currentOffset + 8, true),
                label: await this.readString(currentOffset + 12, 16),
                reserved: await this.view.getUint32(currentOffset + 28, true)
            };

            partition.typeName = this.getPartitionTypeName(partition.type, partition.subType);
            partitions.push(partition);

            currentOffset += 32;
            num++;
        }

        this.partitions = partitions;
        return partitions;
    }

    // Compute SHA-1 of a partition
    async computePartitionSHA1(partition) {
        const start = partition.offset;
        const end = Math.min(this.sparseImage.size, partition.offset + partition.length);
        if (start >= this.sparseImage.size || start >= end) {
            return null;
        }
        const view = await this.sparseImage.subarray_async(start, end);
        const hash = await ESP32Parser.calculateSHA1(view);
        return ESP32Parser.bytesToHex(hash);
    }

    // Detect partition table offset: start after bootloader end, skip 0xFF, pick next data at 4K boundary
    // Try to parse partition entries to validate, continue seeking until 0x00100000 if valid table found
    async detectPartitionTableOffset(bootImage) {
        const sector = 0x1000;
        const start = bootImage?.endOffset ?? 0;
        const searchLimit = Math.min(0x00010000, this.sparseImage.size);
        const len = this.sparseImage.size;
        let ptr = start;
        let bestCandidate = null;
        let bestPartitionCount = 0;

        console.log(`Detecting partition table offset starting from 0x${start.toString(16)}`);
        console.log(`Buffer length: 0x${len.toString(16)}, search limit: 0x${searchLimit.toString(16)}`);

        while (!bestCandidate && ptr < searchLimit) {
            // Skip 0xFF bytes and check for 4K boundary alignment
            if ((await this.view.getUint8(ptr)) !== 0xFF && (ptr % sector === 0)) {
                // Try to parse partition entries at this offset
                const validCount = await this.validatePartitionTable(ptr);

                if (validCount > 0) {
                    console.log(`Found valid partition table at 0x${ptr.toString(16)} with ${validCount} entries`);

                    // Keep track of best candidate (most partitions)
                    if (validCount > bestPartitionCount) {
                        bestCandidate = ptr;
                        bestPartitionCount = validCount;
                    }
                }
            }
            ptr++;
        }

        if (bestCandidate !== null) {
            this.partitionTableOffset = bestCandidate;
            console.log(`Selected partition table offset at 0x${bestCandidate.toString(16)} with ${bestPartitionCount} entries`);
            return bestCandidate;
        }

        console.log(`No partition table detected`);
        return null;
    }

    // Validate partition table at given offset by trying to parse entries
    async validatePartitionTable(offset) {
        let validCount = 0;
        let currentOffset = offset;
        const maxPartitions = 32; // Reasonable limit

        for (let i = 0; i < maxPartitions; i++) {
            if (currentOffset + 32 > this.sparseImage.size) {
                break;
            }

            const magic = await this.view.getUint16(currentOffset, true);

            // End of partition table
            if (magic !== 0x50AA) {
                break;
            }

            const type = await this.view.getUint8(currentOffset + 2);
            const subType = await this.view.getUint8(currentOffset + 3);
            const partOffset = await this.view.getUint32(currentOffset + 4, true);
            const partLength = await this.view.getUint32(currentOffset + 8, true);

            // Validate partition entry sanity
            // Type should be 0 (APP) or 1 (DATA) typically
            if (type > 0xFE) {
                break; // Invalid type
            }

            // Offset should be reasonable (within flash)
            if (partOffset > 0x10000000) {
                break; // Offset too large
            }

            // Length should be non-zero and reasonable
            if (partLength === 0 || partLength > 0x10000000) {
                break;
            }

            // Read label and check for valid characters
            let validLabel = true;
            for (let j = 0; j < 16; j++) {
                const labelByte = await this.view.getUint8(currentOffset + 12 + j);
                if (labelByte === 0) {
                    break; // Null terminator is fine
                }
                // Check if character is printable ASCII or high bit set
                if (labelByte < 0x20 || (labelByte > 0x7E && labelByte < 0x80)) {
                    validLabel = false;
                    break;
                }
            }

            if (!validLabel) {
                break;
            }

            validCount++;
            currentOffset += 32;
        }

        return validCount;
    }

    getPartitionTypeName(type, subType) {
        const types = {
            0: 'APP',
            1: 'DATA'
        };

        const appSubTypes = {
            0x00: 'factory',
            0x10: 'ota_0',
            0x11: 'ota_1',
            0x12: 'ota_2',
            0x13: 'ota_3',
            0x14: 'ota_4',
            0x15: 'ota_5',
            0x16: 'ota_6',
            0x17: 'ota_7',
            0x20: 'test'
        };

        const dataSubTypes = {
            0x00: 'ota',
            0x01: 'phy',
            0x02: 'nvs',
            0x03: 'coredump',
            0x04: 'nvs_keys',
            0x05: 'efuse',
            0x80: 'esphttpd',
            0x81: 'fat',
            0x82: 'spiffs'
        };

        let typeName = types[type] || 'UNKNOWN';
        let subTypeName = '';

        if (type === 0) {
            subTypeName = appSubTypes[subType] || `unknown_${subType.toString(16)}`;
        } else if (type === 1) {
            subTypeName = dataSubTypes[subType] || `unknown_${subType.toString(16)}`;
        }

        return `${typeName} (${subTypeName})`;
    }

    async readString(offset, maxLength) {
        let result = '';
        for (let i = 0; i < maxLength; i++) {
            const byte = await this.view.getUint8(offset + i);
            if (byte === 0) break;
            // Only include printable ASCII characters (32-126)
            if (byte >= 32 && byte <= 126) {
                result += String.fromCharCode(byte);
            } else if (byte !== 0) {
                // Non-printable character found - might be corrupt data
                return result; // Return what we have so far
            }
        }
        return result;
    }

    // Parse NVS (Non-Volatile Storage) — delegated to NVSParser class
    async parseNVS(partition) {
        if (!this.sparseImage) {
            throw new Error('ESP32Parser has no SparseImage for NVS parsing');
        }
        if (!this._nvsParser) {
            this._nvsParser = new NVSParser(this.sparseImage);
        }
        return await this._nvsParser.parse(partition);
    }

    // Parse OTA data partition — delegated to OTADataParser class
    async parseOTAData(partition) {
        if (!this.sparseImage) {
            throw new Error('ESP32Parser has no SparseImage for OTA data parsing');
        }
        if (!this._otaDataParser) {
            this._otaDataParser = new OTADataParser(this.sparseImage);
        }
        return await this._otaDataParser.parse(partition);
    }

    // NVS helpers are now encapsulated in NVSParser

    // Get chip name from chip ID
    getChipName(chipId) {
        const chipNames = {
            0x0000: 'ESP32',
            0x0002: 'ESP32-S2',
            0x0005: 'ESP32-C3',
            0x0009: 'ESP32-S3',
            0x000C: 'ESP32-C2',
            0x000D: 'ESP32-C6',
            0x0010: 'ESP32-H2',
            0x0012: 'ESP32-P4',
            0x0017: 'ESP32-C5',
            0x0014: 'ESP32-C61',
            0x0019: 'ESP32-H21',
            0x001C: 'ESP32-H4',
            0x0020: 'ESP32-S31',
            0xFFFF: 'Invalid'
        };
        return chipNames[chipId] || `Unknown (0x${chipId.toString(16).toUpperCase().padStart(4, '0')})`;
    }

    // Get SPI flash mode name
    getSpiModeName(mode) {
        const modes = {
            0: 'QIO',
            1: 'QOUT',
            2: 'DIO',
            3: 'DOUT'
        };
        return modes[mode] || `Unknown (${mode})`;
    }

    // Get SPI flash speed
    getSpiSpeedName(speed) {
        const speeds = {
            0: '40MHz',
            1: '26MHz',
            2: '20MHz',
            0xF: '80MHz'
        };
        return speeds[speed] || `${speed}`;
    }

    // Get SPI flash size
    getSpiSizeName(size) {
        const sizes = {
            0: '1MB',
            1: '2MB',
            2: '4MB',
            3: '8MB',
            4: '16MB',
            5: '32MB',
            6: '64MB',
            7: '128MB'
        };
        return sizes[size] || `Unknown (${size})`;
    }

    // Parse firmware image
    async parseImage(offset, length) {
        if (offset + 24 > this.sparseImage.size) {
            return { error: 'Offset out of bounds' };
        }

        const magic = await this.view.getUint8(offset);
        if (magic !== 0xE9) {
            return { error: 'Invalid magic number', magic: magic };
        }

        const segmentCount = await this.view.getUint8(offset + 1);
        const spiMode = await this.view.getUint8(offset + 2);
        const flashInfoByte = await this.view.getUint8(offset + 3);
        const spiSpeed = flashInfoByte & 0x0F;  // Lower 4 bits
        const spiSize = (flashInfoByte >> 4) & 0x0F;  // Upper 4 bits
        const entryAddr = await this.view.getUint32(offset + 4, true);

        // Extended header (24 bytes total)
        const wpPin = await this.view.getUint8(offset + 8);
        const spiPinDrv = [
            await this.view.getUint8(offset + 9),
            await this.view.getUint8(offset + 10),
            await this.view.getUint8(offset + 11)
        ];
        const chipId = await this.view.getUint16(offset + 12, true);
        const minChipRev = await this.view.getUint8(offset + 14);
        const minChipRevFull = await this.view.getUint16(offset + 15, true);
        const maxChipRevFull = await this.view.getUint16(offset + 17, true);
        const reserved = [
            await this.view.getUint8(offset + 19),
            await this.view.getUint8(offset + 20),
            await this.view.getUint8(offset + 21),
            await this.view.getUint8(offset + 22)
        ];
        const hashAppended = await this.view.getUint8(offset + 23);

        const image = {
            offset: offset,
            magic: magic,
            segmentCount: segmentCount,
            spiMode: spiMode,
            spiModeName: this.getSpiModeName(spiMode),
            spiSpeed: spiSpeed,
            spiSpeedName: this.getSpiSpeedName(spiSpeed),
            spiSize: spiSize,
            spiSizeName: this.getSpiSizeName(spiSize),
            entryAddr: entryAddr,
            wpPin: wpPin,
            wpPinDisabled: wpPin === 0xEE,
            spiPinDrv: spiPinDrv,
            chipId: chipId,
            chipName: this.getChipName(chipId),
            minChipRev: minChipRev,
            minChipRevFull: minChipRevFull,
            minChipRevMajor: Math.floor(minChipRevFull / 100),
            minChipRevMinor: minChipRevFull % 100,
            maxChipRevFull: maxChipRevFull,
            maxChipRevMajor: Math.floor(maxChipRevFull / 100),
            maxChipRevMinor: maxChipRevFull % 100,
            reserved: reserved,
            hashAppended: hashAppended,
            hasHash: hashAppended === 1,
            segmentList: []
        };

        let currentOffset = offset + 24;

        // Parse segments
        for (let i = 0; i < segmentCount; i++) {
            if (currentOffset + 8 > this.sparseImage.size) break;

            const loadAddress = await this.view.getUint32(currentOffset, true);
            const segLength = await this.view.getUint32(currentOffset + 4, true);

            image.segmentList.push({
                loadAddress: loadAddress,
                length: segLength,
                offset: currentOffset + 8
            });

            currentOffset += 8 + segLength;
        }

        // Pad until checksum sits at offset % 16 == 15 (esptool layout)
        while ((currentOffset % 16) !== 15) {
            currentOffset++;
        }

        const checksumOffset = currentOffset;
        if (currentOffset < this.sparseImage.size) {
            image.checksum = await this.view.getUint8(currentOffset);
            currentOffset++;

            // Always record hash region (header through checksum) for debugging/calculation
            image.sha256DataStart = offset;
            image.sha256DataEnd = checksumOffset + 1;

            if (image.hasHash && currentOffset + 32 <= this.sparseImage.size) {
                const hash = new Uint8Array(32);
                for (let i = 0; i < 32; i++) {
                    hash[i] = await this.view.getUint8(currentOffset + i);
                }
                image.sha256 = ESP32Parser.bytesToHex(hash);
                image.sha256Offset = currentOffset;
                currentOffset += 32;
            }
        }

        image.endOffset = currentOffset;

        // Try to find and parse app description
        image.appDesc = await this.parseAppDescription(image);

        return image;
    }

    // Parse application description (esp_app_desc_t)
    async parseAppDescription(image) {
        const ESP_APP_DESC_MAGIC_WORD = 0xABCD5432;

        if (image.segmentList.length === 0) {
            console.warn(`AppDesc: no segments present for image at 0x${(image.offset ?? 0).toString(16)}`);
            return null;
        }

        const parseAt = async (offset) => {
            const appDesc = {
                found: true,
                offset: offset,
                magicWord: ESP_APP_DESC_MAGIC_WORD,
                secureVersion: await this.view.getUint32(offset + 4, true),
                version: (await this.readString(offset + 16, 32)).trim(),
                projectName: (await this.readString(offset + 48, 32)).trim(),
                time: (await this.readString(offset + 80, 16)).trim(),
                date: (await this.readString(offset + 96, 16)).trim(),
                idfVer: (await this.readString(offset + 112, 32)).trim(),
                appElfSha256: null
            };

            if (offset + 144 + 32 <= this.sparseImage.size) {
                const sha256 = new Uint8Array(32);
                for (let i = 0; i < 32; i++) {
                    sha256[i] = await this.view.getUint8(offset + 144 + i);
                }
                appDesc.appElfSha256 = ESP32Parser.bytesToHex(sha256);
            }

            return appDesc;
        };

        /* Fixed offset: header (24) + first segment header (8) */
        const descOffset = (image.offset ?? 0) + 24 + 8;
        if (descOffset + 256 > this.sparseImage.size || descOffset < 0) {
            console.warn(
                `AppDesc: fixed offset 0x${descOffset.toString(16)} out of bounds (buffer length 0x${this.sparseImage.size.toString(16)})`
            );
            return null;
        }

        const magic = await this.view.getUint32(descOffset, true);
        if (magic !== ESP_APP_DESC_MAGIC_WORD) {
            let peek = null;
            try {
                const end = Math.min(descOffset + 16, this.sparseImage.size);
                peek = await this.buffer.slice_async(descOffset, end);
            } catch (err) {
                console.warn(`AppDesc: error reading peek bytes at 0x${descOffset.toString(16)}: ${err.message}`);
            }

            const peekHex = peek ? ESP32Parser.bytesToHex(peek) : 'n/a';
            console.warn(
                `AppDesc: magic mismatch at 0x${descOffset.toString(16)} (got 0x${magic.toString(16)}, expected 0x${ESP_APP_DESC_MAGIC_WORD.toString(16)}), first bytes ${peekHex}`
            );
            return null;
        }

        try {
            return await parseAt(descOffset);
        } catch (error) {
            console.warn('Error parsing app description at fixed offset:', error);
            return null;
        }
    }

    // Validate image SHA256 hash
    async validateImageSHA256(image) {
        if (image.sha256 === undefined || image.sha256 === null ||
            image.sha256DataStart === undefined || image.sha256DataEnd === undefined) {
            return { valid: false, reason: 'No hash data available' };
        }

        try {
            console.log(`Image SHA256 region: start=0x${image.sha256DataStart.toString(16)}, end=0x${image.sha256DataEnd.toString(16)}, length=${image.sha256DataEnd - image.sha256DataStart}`);
            const dataToHash = await this.sparseImage.slice_async(image.sha256DataStart, image.sha256DataEnd);
            const calculatedHash = await ESP32Parser.calculateSHA256(dataToHash);
            const calculatedHashHex = ESP32Parser.bytesToHex(calculatedHash);

            const valid = calculatedHashHex === image.sha256;

            return {
                valid: valid,
                calculated: calculatedHashHex,
                expected: image.sha256,
                reason: valid ? 'Hash matches' : 'Hash mismatch'
            };
        } catch (error) {
            return { valid: false, reason: 'Error calculating hash: ' + error.message };
        }
    }

    // Validate app ELF SHA256 (stored in app description)
    async validateAppElfSHA256(image) {
        if (!image.appDesc || !image.appDesc.appElfSha256) {
            return { valid: false, reason: 'No app ELF hash available' };
        }

        // We can't validate the ELF hash without the original ELF file
        // This hash is for reference only
        return {
            valid: null,
            reason: 'ELF file not available for validation',
            hash: image.appDesc.appElfSha256
        };
    }

    // FAT: delegate to FATParser
    async parseWearLeveling(partition) {
        if (!this._fatParser) {
            this._fatParser = new FATParser(this.sparseImage);
        }
        return await this._fatParser.parseWearLeveling(partition);
    }

    // Translate sector through wear leveling
    wlTranslateSector(wlInfo, sector) {
        if (!this._fatParser) {
            this._fatParser = new FATParser(this.sparseImage);
        }
        return this._fatParser.wlTranslateSector(wlInfo, sector);
    }

    // Parse FAT filesystem with wear leveling
    async parseFATFilesystem(partition) {
        if (!this._fatParser) {
            this._fatParser = new FATParser(this.sparseImage);
        }
        return await this._fatParser.parse(partition);
    }

    // Parse a FAT directory (root or subdirectory)
    // Internal FAT directory parsing moved to FATParser

    // Get partition by label
    getPartition(label) {
        return this.partitions.find(p => p.label === label);
    }

    // Read FAT table entry
    async readFATEntry(partition, wlInfo, fatOffset, cluster, fatType) {
        if (!this._fatParser) {
            this._fatParser = new FATParser(this.sparseImage);
        }
        return await this._fatParser.readFATEntry(partition, wlInfo, fatOffset, cluster, fatType);
    }

    // Extract FAT file data
    async extractFATFile(partition, fatInfo, fileEntry) {
        if (!this._fatParser) {
            this._fatParser = new FATParser(this.sparseImage);
        }
        return await this._fatParser.extractFile(partition, fatInfo, fileEntry);
    }

    /**
     * Delete an NVS item by namespace and key
     */
    async deleteNVSItem(partition, namespace, key) {
        if (!this._nvsParser) {
            this._nvsParser = new NVSParser(this.sparseImage);
        }
        return await this._nvsParser.deleteItem(partition, namespace, key);
    }

    /**
     * Set NVS item state in bitmap
     */


    /**
     * Add a new NVS item
     */
    async addNVSNamespace(partition, namespaceName) {
        if (!this._nvsParser) {
            this._nvsParser = new NVSParser(this.sparseImage);
        }
        return await this._nvsParser.addNamespace(partition, namespaceName);
    }

    async addNVSItem(partition, namespace, key, type, value) {
        if (!this._nvsParser) {
            this._nvsParser = new NVSParser(this.sparseImage);
        }
        return await this._nvsParser.addItem(partition, namespace, key, type, value);
    }

    /**
     * Update an existing NVS item by namespace/key
     */
    async updateNVSItem(partition, namespace, key, type, value) {
        if (!this._nvsParser) {
            this._nvsParser = new NVSParser(this.sparseImage);
        }
        return await this._nvsParser.updateItem(partition, namespace, key, type, value);

        // Calculate and set header CRC for first entry
        const headerCrc = ESP32Parser.crc32Header(entries[0]);
        new DataView(entries[0].buffer).setUint32(4, headerCrc, true);

        return {
            span: entry[2],
            entries: entries
        };
    }

    // Export methods
    async exportPartitionData(partition) {
        const data = await this.buffer.slice_async(partition.offset, partition.offset + partition.length);
        return new Blob([data], { type: 'application/octet-stream' });
    }

    /**
     * Parse SPIFFS partition
     * SPIFFS (SPI Flash File System) is a file system for embedded devices
     */
    async parseSPIFFS(partition) {
        if (!this._spiffsParser) {
            this._spiffsParser = new SpiffsParser(this.sparseImage);
        }
        return await this._spiffsParser.parse(partition);
    }

    /**
     * Read file data from SPIFFS partition
     */
    async readSPIFFSFile(partition, file, spiffsInfo) {
        if (!this._spiffsParser) {
            this._spiffsParser = new SpiffsParser(this.sparseImage);
        }
        return await this._spiffsParser.readFile(partition, file, spiffsInfo);
    }
}

// Export for use in HTML
if (typeof module !== 'undefined' && module.exports) {
    module.exports = ESP32Parser;
    module.exports.SparseImage = SparseImage;
}
