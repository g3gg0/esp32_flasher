// FAT filesystem parser encapsulated as a standalone class
// Depends on SparseImage and SparseImageDataView from esp32-parser.js being loaded in the page

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
        if (stateOffset + 64 > this.buffer.length) {
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
        for (let i = 0; i < wlStateSize && recordOffset + WL_STATE_RECORD_SIZE <= this.buffer.length; i++) {
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
        if (bootSectorOffset + 512 > this.buffer.length) {
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
            if (entryOffset + 32 > this.buffer.length) break;
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

                if (clusterOffset + sectorsPerCluster * WL_SECTOR_SIZE <= this.buffer.length) {
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
            if (clusterOffset + bytesToRead <= this.buffer.length) {
                fileData.set(await this.buffer.slice_async(clusterOffset, clusterOffset + bytesToRead), bytesRead);
                bytesRead += bytesToRead;
            }
            if (bytesRead >= fileEntry.size) break;
        }

        return new Blob([fileData], { type: 'application/octet-stream' });
    }
}

// Expose FATParser globally
window.FATParser = FATParser;
