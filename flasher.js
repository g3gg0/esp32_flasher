/* Command defines */
const FLASH_BEGIN = 0x02;
const FLASH_DATA = 0x03;
const FLASH_END = 0x04;
const MEM_BEGIN = 0x05;
const MEM_END = 0x06;
const MEM_DATA = 0x07;
const SYNC = 0x08;
const WRITE_REG = 0x09;
const READ_REG = 0x0a;
const SPI_SET_PARAMS = 0x0b;
const SPI_ATTACH = 0x0d;
const CHANGE_BAUDRATE = 0x0f;
const FLASH_DEFL_BEGIN = 0x10;
const FLASH_DEFL_DATA = 0x11;
const FLASH_DEFL_END = 0x12;
const SPI_FLASH_MD5 = 0x13;
const GET_SECURITY_INFO = 0x14;
const ERASE_FLASH = 0xd0;
const ERASE_REGION = 0xd1;
const READ_FLASH = 0xd2;
const RUN_USER_CODE = 0xd3;


class SlipLayer {
    constructor() {
        this.buffer = [];
        this.escaping = false;
    }

    encode(packet) {
        const SLIP_END = 0xC0;
        const SLIP_ESC = 0xDB;
        const SLIP_ESC_END = 0xDC;
        const SLIP_ESC_ESC = 0xDD;

        let slipFrame = [SLIP_END];

        for (let byte of packet) {
            if (byte === SLIP_END) {
                slipFrame.push(SLIP_ESC, SLIP_ESC_END);
            } else if (byte === SLIP_ESC) {
                slipFrame.push(SLIP_ESC, SLIP_ESC_ESC);
            } else {
                slipFrame.push(byte);
            }
        }

        slipFrame.push(SLIP_END);
        return new Uint8Array(slipFrame);
    }

    decode(value) {
        const SLIP_END = 0xC0;
        const SLIP_ESC = 0xDB;
        const SLIP_ESC_END = 0xDC;
        const SLIP_ESC_ESC = 0xDD;

        let outputPackets = [];

        for (let byte of value) {
            if (byte === SLIP_END) {
                if (this.buffer.length > 0) {
                    outputPackets.push(new Uint8Array(this.buffer));
                    this.buffer = [];
                }
            } else if (this.escaping) {
                if (byte === SLIP_ESC_END) {
                    this.buffer.push(0xC0);
                } else if (byte === SLIP_ESC_ESC) {
                    this.buffer.push(0xDB);
                }
                this.escaping = false;
            } else if (byte === SLIP_ESC) {
                this.escaping = true;
            } else {
                this.buffer.push(byte);
            }
        }

        return outputPackets;
    }
}

class ESPFlasher {

    constructor() {
        this.port = null;
        this.currentAddress = 0x0000;

        this.current_chip = "none";
        this.devMode = false;
        this.stubLoaded = false;
        this.responseHandlers = new Map();
        this.chip_magic_addr = 0x40001000;
        this.chip_descriptions = new ChipDescriptions().chip_descriptions;

        this.buffer = [];
        this.escaping = false;
        this.slipLayer = new SlipLayer();

        this.logDebug = () => { };
        this.logError = () => { };
        this.reader = null;
    }

    async openPort() {
        return new Promise(async (resolve, reject) => {

            /* Request a port and open a connection */
            try {
                this.port = await navigator.serial.requestPort();
                await this.port.open({ baudRate: 921600 });
            } catch (error) {
                reject(error);
                return;
            }

            // Register for device lost
            navigator.serial.addEventListener('disconnect', (event) => {
                if (event.target === this.port) {
                    this.logError(`The device was disconnected`);
                    this.disconnect();
                }
            });

            // Register for port closing
            this.port.addEventListener('close', () => {
                this.logError('Serial port closed');
                this.disconnect();
            });

            resolve();

            /* Set up reading from the port */
            this.reader = this.port.readable.getReader();

            try {
                while (true) {
                    const { value, done } = await this.reader.read();
                    if (done) {
                        break;
                    }
                    if (value) {
                        const packets = this.slipLayer.decode(value);
                        for (let packet of packets) {
                            await this.processPacket(packet);
                        }
                    }
                }
            } catch (err) {
                // Handle cancellation
            } finally {
                if (this.reader) {
                    this.reader.releaseLock();
                    this.reader = null;
                }
            }
        });
    }

    async readReg(addr) {
        return this.executeCommand(this.buildCommandPacketU32(READ_REG, addr),
            async (resolve, reject, responsePacket) => {
                if (responsePacket) {
                    resolve(responsePacket.value);
                } else {
                    reject('Failed to read register');
                }
            });
    }


    async isStubLoader() {
        return this.executeCommand(this.buildCommandPacketU32(READ_REG, this.chip_magic_addr),
            async (resolve, reject, responsePacket) => {
                if (responsePacket && responsePacket.data) {
                    if (responsePacket.data.length == 2) {
                        resolve(true);
                    }
                    if (responsePacket.data.length == 4) {
                        resolve(false);
                    }
                    reject('Unexpected length');
                } else {
                    reject('Failed to read register');
                }
            });
    }

    async executeCommand(packet, callback, default_callback, timeout = 500, hasTimeoutCbr = null) {
        if (!this.port || !this.port.writable) {
            throw new Error("Port is not writable.");
        }

        var pkt = this.parsePacket(packet.payload);
        this.dumpPacket(pkt);

        const responsePromise = new Promise((resolve, reject) => {

            this.responseHandlers.clear();
            this.responseHandlers.set(packet.command, async (response) => {
                if (callback) {
                    return callback(resolve, reject, response);
                }
            });

            if (default_callback) {
                this.responseHandlers.set(-1, async (response) => {
                    return default_callback(resolve, reject, response);
                });
            }

            setTimeout(() => {
                if (hasTimeoutCbr) {
                    if (hasTimeoutCbr()) {
                        reject(new Error(`Timeout in command ${packet.command}`));
                    }
                } else {
                    reject(new Error(`Timeout after ${timeout} ms waiting for response to command ${packet.command}`));
                }
            }, timeout);
        });

        // Send the packet
        const writer = this.port.writable.getWriter();
        const slipFrame = this.slipLayer.encode(packet.payload);
        await writer.write(slipFrame);
        writer.releaseLock();

        return responsePromise;
    }

    async disconnect() {
        navigator.serial.removeEventListener('disconnect', this.disconnect);

        if (this.reader) {
            try {
                await this.reader.cancel();
            } catch (error) {
                this.logError('Error cancelling reader:', error);
            }
        }

        if (this.port) {
            try {
                this.port.removeEventListener('close', this.disconnect);
                await this.port.close();
            } catch (error) {
                this.logError('Error during disconnect:', error);
            }
            this.port = null;
        }

        this.disconnected && this.disconnected();
    }


    /**
     * Attempts to put the ESP device into bootloader mode using RTS/DTR signals.
     * Relies on the common DTR=EN, RTS=GPIO0 circuit. May not work on all boards.
     * @returns {Promise<boolean>} True if the sequence was sent, false if an error occurred (e.g., signals not supported).
     */
    async hardReset(bootloader = true) {
        if (!this.port) {
            this.logError("Port is not open. Cannot set signals.");
            return false;
        }

        this.logDebug("Automatic bootloader reset sequence...");

        try {
            await this.port.setSignals({
                dataTerminalReady: false,
                requestToSend: false,
            });
            await this.port.setSignals({
                dataTerminalReady: bootloader,
                requestToSend: true,
            });
            await this.port.setSignals({
                dataTerminalReady: false,
                requestToSend: bootloader,
            });
            await new Promise((resolve) => setTimeout(resolve, 100));

            return true;
        } catch (error) {
            this.logError(`Could not set signals for automatic reset: ${error}. Please ensure device is in bootloader mode manually.`);
            return false;
        }
    }


    base64ToByteArray(base64) {
        const binaryString = atob(base64);
        const byteArray = new Uint8Array(binaryString.length);
        for (let index = 0; index < binaryString.length; index++) {
            byteArray[index] = binaryString.charCodeAt(index);
        }
        return byteArray;
    }

    async downloadMem(address, payload) {
        var binary = this.base64ToByteArray(payload);

        await this.executeCommand(this.buildCommandPacketU32(MEM_BEGIN, binary.length, 1, binary.length, address),
            async (resolve, reject, responsePacket) => {
                resolve();
            });
        await this.executeCommand(this.buildCommandPacketU32(MEM_DATA, binary.length, 0, 0, 0, binary),
            async (resolve, reject, responsePacket) => {
                resolve();
            });
    }

    async sync() {
        const maxRetries = 10;
        const retryDelayMs = 100; // Delay between retries
        const syncTimeoutMs = 250; // Timeout for each individual sync attempt
        let synchronized = false;

        this.logDebug(`Attempting to synchronize (${maxRetries} attempts)...`);

        const syncData = new Uint8Array([0x07, 0x07, 0x12, 0x20, ...Array(32).fill(0x55)]);
        const syncPacket = this.buildCommandPacket(SYNC, syncData);

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            this.logDebug(`Sync attempt ${attempt}...`);
            try {
                await this.executeCommand(
                    syncPacket,
                    async (resolve, reject, responsePacket) => {
                        // The ROM bootloader responds to SYNC with 0x08 0x00 status - check value maybe?
                        // For now, just receiving *any* response to SYNC is considered success here.
                        // If the command times out, the catch block below handles it.
                        resolve(); // Signal success for this attempt
                    },
                    null, // No default callback needed here
                    syncTimeoutMs // Use a specific timeout for sync
                );

                // If executeCommand resolved without throwing/rejecting:
                this.logDebug(`Synchronized successfully on attempt ${attempt}.`);
                synchronized = true;
                break; // Exit the retry loop on success

            } catch (error) {
                this.logDebug(`Sync attempt ${attempt} failed: ${error.message}`);
                if (attempt === maxRetries) {
                    this.logError(`Failed to synchronize after ${maxRetries} attempts.`);
                    // Throw an error to indicate overall failure of the sync process
                    throw new Error(`Failed to synchronize with device after ${maxRetries} attempts.`);
                }
                // Wait before the next retry
                await new Promise(resolve => setTimeout(resolve, retryDelayMs));
            }
        }

        // This part only runs if synchronized was set to true
        if (!synchronized) {
            // This should technically not be reached if the error is thrown above,
            // but adding as a safeguard.
            throw new Error("Synchronization failed (unexpected state).");
        }

        // --- Chip Detection (Runs only after successful sync) ---
        this.logDebug("Reading chip magic value...");
        let currentValue;
        try {
            // Use a slightly longer timeout for register reads if needed
            currentValue = await this.readReg(this.chip_magic_addr);
        } catch (readError) {
            this.logError(`Failed to read magic value after sync: ${readError}`);
            throw new Error(`Successfully synced, but failed to read chip magic value: ${readError.message}`);
        }


        /* Function to check if the value matches any of the magic values */
        const isMagicValue = (stub, value) => {
            if (Array.isArray(stub.magic_value)) {
                return stub.magic_value.includes(value);
            } else {
                return stub.magic_value === value;
            }
        };

        let chipDetected = false;
        /* Iterate through each stub in the object */
        for (const desc in this.chip_descriptions) {
            if (this.chip_descriptions.hasOwnProperty(desc)) {
                const checkStub = this.chip_descriptions[desc];
                if (isMagicValue(checkStub, currentValue)) {
                    this.logDebug(`Detected Chip: ${desc} (Magic: 0x${currentValue.toString(16)})`);
                    this.current_chip = desc;
                    chipDetected = true;
                    break; // Found the chip
                }
            }
        }

        if (!chipDetected) {
            this.logError(`Synced, but chip magic value 0x${currentValue.toString(16)} is unknown.`);
            this.current_chip = "unknown"; // Mark as unknown
            // Depending on requirements, you might want to throw an error here
            // throw new Error(`Synced, but failed to identify chip type (Magic: 0x${currentValue.toString(16)}).`);
        }

        // If we reached here without throwing, sync and detection (or lack thereof) is complete.
        // The function implicitly returns a resolved promise.
    }

    async readMac() {

        // Read the MAC address registers
        var chip = this.chip_descriptions[this.current_chip];
        const register1 = await this.readReg(chip.mac_efuse_reg);
        const register2 = await this.readReg(chip.mac_efuse_reg + 4);

        if (!register1 || !register2) {
            return;
        }

        const lower = (register1 >>> 0);
        const higher = (register2 >>> 0) & 0xFFFF;

        // Construct MAC address from register values
        const macBytes = new Uint8Array(6);
        macBytes[0] = (higher >> 8) & 0xFF;
        macBytes[1] = higher & 0xFF;
        macBytes[2] = (lower >> 24) & 0xFF;
        macBytes[3] = (lower >> 16) & 0xFF;
        macBytes[4] = (lower >> 8) & 0xFF;
        macBytes[5] = lower & 0xFF;

        function toHex(byte) {
            const hexString = byte.toString(16);
            return hexString.length === 1 ? '0' + hexString : hexString;
        }
        const mac = Array.from(macBytes)
            .map(byte => toHex(byte))
            .join(':');

        return mac;
    }

    async testReliability(cbr) {

        var chip = this.chip_descriptions[this.current_chip];
        var reference = 0;

        try {
            reference = await this.executeCommand(this.buildCommandPacketU32(READ_REG, chip.mac_efuse_reg),
                async (resolve, reject, responsePacket) => {
                    if (responsePacket) {
                        resolve(responsePacket.value);
                    } else {
                        this.logError(`Test read failed`);
                        reject(`Test read failed`);
                    }
                });
        } catch (error) {
            this.logError(`Test read failed due to an error`, `${error.message}`);
            return false;
        }

        var duration = 1000;
        const endTime = Date.now() + duration;

        let totalReads = 0;
        let totalTime = 0;

        while (Date.now() < endTime) {
            try {
                const startTime = Date.now();

                var testread = await this.executeCommand(this.buildCommandPacketU32(READ_REG, chip.mac_efuse_reg),
                    async (resolve, reject, responsePacket) => {
                        if (responsePacket) {
                            resolve(responsePacket.value);
                        } else {
                            reject(`Test read failed`);
                        }
                    });

                const endTimeRead = Date.now();
                const readDuration = endTimeRead - startTime;

                totalTime += readDuration;
                totalReads++;

                /* Update the progress bar */
                const elapsed = Date.now() - (endTime - duration); // duration is the total time period (change to 30000 for 30 seconds)
                const progressPercentage = Math.min(100, (elapsed / duration) * 100); // Cap at 100%

                cbr && cbr(progressPercentage);

                /* Check if the read value differs from the reference */
                if (testread !== reference) {
                    this.logError(`Test read failed! Expected: 0x${reference.toString(16).padStart(8, '0')}, but got: 0x${testread.toString(16).padStart(8, '0')}`);
                    break;
                }
            } catch (error) {
                this.logError(`Test read failed due to an error`, `${error.message}`);
                return false;
            }
        }

        if (totalReads > 0) {
            const averageTime = totalTime / totalReads;
            this.logDebug(`Average read time: ${averageTime.toFixed(2)} ms over ${totalReads} reads.`);
        }

        return true;
    }

    async downloadStub() {

        var stub = this.chip_descriptions[this.current_chip].stub

        await this.downloadMem(stub.text_start, stub.text);
        await this.downloadMem(stub.data_start, stub.data);

        try {
            await this.executeCommand(this.buildCommandPacketU32(MEM_END, 0, stub.entry),
                async (resolve, reject, responsePacket) => {
                    this.logDebug("Final MEM_END ACK");
                },
                async (resolve, reject, rawData) => {
                    const decoder = new TextDecoder('utf-8');
                    const responseData = decoder.decode(rawData);

                    if (responseData == "OHAI") {
                        this.logDebug(`Stub loader executed successfully (received ${responseData})`);
                        this.stubLoaded = true;
                        resolve();
                    } else {
                        this.logError(`Unexpected stub response: ${responseData}`);
                        reject(`Unexpected response from stub: ${responseData}`);
                    }
                },
                3000 // Longer timeout for stub execution
            );
        } catch (error) {
            this.logError("Failed to execute stub", "Is the device locked?");
            return false;
        }

        try {
            await this.executeCommand(this.buildCommandPacketU32(SPI_SET_PARAMS, 0, 0x800000, 64 * 1024, 4 * 1024, 256, 0xFFFF), async (resolve, reject, responsePacket) => {
                this.logDebug("SPI_SET_PARAMS configured");
                resolve();
            });
        } catch (error) {
            this.logError("Failed to configure SPI parameters", error.message);
            return false;
        }

        return true;
    }

    async writeFlash(address, data, progressCallback) {
        const MAX_PACKET_SIZE = 0x1000;
        const packets = Math.ceil(data.length / MAX_PACKET_SIZE);

        /* Send FLASH_BEGIN command with the total data size
           according to https://docs.espressif.com/projects/esptool/en/latest/esp32s3/advanced-topics/serial-protocol.html
           the ROM bootloader is also able to flash. unfortunately there are some issues with it.
           it doesn't respond anymore. use with stub only!
        */
        await this.executeCommand(
            this.buildCommandPacketU32(FLASH_BEGIN, data.length, packets,
                Math.min(MAX_PACKET_SIZE, data.length),
                address
            ),
            async (resolve) => {
                resolve();
            }
        );

        /* Split data into chunks and send FLASH_DATA commands */
        var seq = 0;
        for (let offset = 0; offset < data.length; offset += MAX_PACKET_SIZE) {
            const chunk = data.slice(offset, offset + MAX_PACKET_SIZE);

            /* Four 32-bit words: data size, sequence number, 0, 0, then data. Uses Checksum. */
            await this.executeCommand(
                this.buildCommandPacketU32(FLASH_DATA, chunk.length, seq++, 0, 0, chunk),
                async (resolve) => {
                    resolve();
                },
                null,
                5000
            );

            if (progressCallback) {
                progressCallback(offset + chunk.length, data.length);
            }
        }
    }

    async readFlash(address, length = 0x1000, progressCallback) {

        const performRead = async (cbr) => {
            let sectorSize = 0x1000;

            if (sectorSize > length) {
                sectorSize = length;
            }
            const packets = length / sectorSize;
            let packet = 0;
            let ackMax = 8;
            var data = new Uint8Array(0);
            var lastDataTime = Date.now();

            return this.executeCommand(
                this.buildCommandPacketU32(READ_FLASH, address, length, sectorSize, ackMax),
                async () => {
                    packet = 0;
                },
                async (resolve, reject, rawData) => {
                    lastDataTime = Date.now();

                    if (data.length == length) {
                        if (rawData.length == 16) {
                            /* Calculate MD5 of received data */
                            const calculatedMD5 = this.calculateMD5(data);

                            /* Convert received MD5 bytes to hex string */
                            const receivedMD5 = Array.from(rawData)
                                .map(b => b.toString(16).padStart(2, '0'))
                                .join('');

                            /* Compare MD5 hashes */
                            if (calculatedMD5.toLowerCase() === receivedMD5.toLowerCase()) {
                                resolve(data);
                            } else {
                                const error = `MD5 mismatch! Expected: ${receivedMD5}, Got: ${calculatedMD5}`;
                                console.error(error);
                                reject(new Error(error));
                            }
                        } else {
                            const error = `Unknown response length for MD5! Expected: 16, Got: ${rawData.length}`;
                            console.error(error);
                            reject(new Error(error));
                        }
                    } else {
                        /* Append rawData to accumulated data */
                        const newData = new Uint8Array(data.length + rawData.length);
                        newData.set(data);
                        newData.set(rawData, data.length);
                        data = newData;

                        /* Call progress callback */
                        if (cbr) {
                            cbr(data.length, length);
                        }

                        /* Prepare response */
                        var resp = new Uint8Array(4);
                        resp[0] = (data.length >> 0) & 0xFF;
                        resp[1] = (data.length >> 8) & 0xFF;
                        resp[2] = (data.length >> 16) & 0xFF;
                        resp[3] = (data.length >> 24) & 0xFF;

                        /* Encode and write response */
                        const slipFrame = this.slipLayer.encode(resp);
                        const writer = this.port.writable.getWriter();
                        await writer.write(slipFrame);
                        writer.releaseLock();
                        packet++;
                    }
                },
                1000 * packets,
                /* Timeout condition: if the last raw data callback was more than a second ago */
                () => {
                    const timeSinceLastData = Date.now() - lastDataTime;
                    return timeSinceLastData > 1000;
                }
            );
        };

        return performRead(progressCallback);
    }

    async checksumFlash(address, length) {
        return this.executeCommand(
            this.buildCommandPacketU32(SPI_FLASH_MD5, address, length, 0, 0),
            async (resolve, reject, responsePacket) => {
                /* MD5 response is in the data field */
                if (responsePacket && responsePacket.data) {
                    /* Convert data bytes to hex string */
                    const md5 = Array.from(responsePacket.data.slice(0, 16))
                        .map(b => b.toString(16).padStart(2, '0'))
                        .join('');
                    resolve(md5);
                } else {
                    reject('No MD5 data received');
                }
            },
            async (resolve, reject, rawData) => {
                /* Handle raw data response if it comes this way */
                const decoder = new TextDecoder('utf-8');
                const md5String = decoder.decode(rawData);
                resolve(md5String.trim());
            },
            length / 1000 // Timeout based on length
        );
    }

    calculateMD5(data) {
        /* Create MD5 hash using the Md5 class */
        const md5 = new this.Md5();
        md5.update(data);
        return md5.hex();
    }

    async readFlashSafe(address, size, progressCallback) {
        const BLOCK_SIZE = 64 * 0x1000;

        try {
            /* Step 1: Read data in 4KB blocks */
            this.logDebug(`ReadFlashSafe: Reading ${size} bytes in ${BLOCK_SIZE}-byte blocks...`);
            const allData = new Uint8Array(size);
            let offset = 0;

            while (offset < size) {
                const readSize = Math.min(BLOCK_SIZE, size - offset);
                let cbr = (read, readBlockSize) => {
                    if (progressCallback) {
                        progressCallback(offset + read, size, 'reading');
                    }
                }
                const blockData = await this.readFlash(address + offset, readSize, cbr);

                /* Copy block to buffer */
                allData.set(blockData.slice(0, readSize), offset);
                offset += readSize;

                /* Call progress callback */
                if (progressCallback) {
                    progressCallback(offset, size, 'reading');
                }

                this.logDebug(`ReadFlashSafe: Read ${offset}/${size} bytes (${Math.round((offset / size) * 100)}%)`);
            }

            /* Step 2: Calculate MD5 of read data */
            if (progressCallback) {
                progressCallback(size, size, 'calc MD5 of input');
            }
            this.logDebug(`ReadFlashSafe: Calculating MD5 of read data...`);
            const actualMD5 = await this.calculateMD5(allData);
            this.logDebug(`Actual MD5: ${actualMD5}`);

            /* Step 3: Get expected MD5 from flash */
            if (progressCallback) {
                progressCallback(size, size, 'calc MD5 in-chip');
            }

            this.logDebug(`ReadFlashSafe: Calculating expected MD5 for ${size} bytes at 0x${address.toString(16).padStart(8, '0')}...`);
            const expectedMD5 = await this.checksumFlash(address, size);
            this.logDebug(`Expected MD5: ${expectedMD5}`);

            /* Step 4: Compare MD5 hashes */
            if (expectedMD5.toLowerCase() !== actualMD5.toLowerCase()) {
                this.logError(`ReadFlashSafe FAILED: MD5 mismatch!`);
                this.logError(`  Expected: ${expectedMD5}`);
                this.logError(`  Actual:   ${actualMD5}`);
                throw new Error(`MD5 verification failed: expected ${expectedMD5}, got ${actualMD5}`);
            }

            this.logDebug(`ReadFlashSafe: MD5 verification passed ✓`);
            return allData;

        } catch (error) {
            this.logError(`ReadFlashSafe failed: ${error.message}`);
            throw error;
        }
    }

    async writeFlashSafe(address, data, progressCallback) {
        try {
            /* Step 1: Write data to flash */
            this.logDebug(`WriteFlashSafe: Writing ${data.length} bytes to 0x${address.toString(16).padStart(8, '0')}...`);
            await this.writeFlash(address, data, (offset, total) => {
                if (progressCallback) {
                    progressCallback(offset, total, 'writing');
                }
            });
            this.logDebug(`WriteFlashSafe: Write complete`);

            /* Step 2: Calculate MD5 of input data */
            if (progressCallback) {
                progressCallback(data.length, data.length, 'calc MD5 of input');
            }
            this.logDebug(`WriteFlashSafe: Calculating MD5 of ${data.length} bytes to write...`);
            const expectedMD5 = this.calculateMD5(data);
            this.logDebug(`Input data MD5: ${expectedMD5}`);

            /* Step 3: Get MD5 from device */
            if (progressCallback) {
                progressCallback(data.length, data.length, 'calc MD5 in-chip');
            }
            this.logDebug(`WriteFlashSafe: Calculating MD5 on device for verification...`);
            const deviceMD5 = await this.checksumFlash(address, data.length);
            this.logDebug(`Device MD5: ${deviceMD5}`);

            /* Step 4: Compare MD5 hashes */
            if (expectedMD5.toLowerCase() !== deviceMD5.toLowerCase()) {
                this.logError(`WriteFlashSafe FAILED: MD5 mismatch!`);
                this.logError(`  Expected: ${expectedMD5}`);
                this.logError(`  Device:   ${deviceMD5}`);
                throw new Error(`MD5 verification failed after write: expected ${expectedMD5}, got ${deviceMD5}`);
            }

            this.logDebug(`WriteFlashSafe: MD5 verification passed ✓`);

            if (progressCallback) {
                progressCallback(data.length, data.length, expectedMD5, 'verified');
            }

            return { success: true, md5: expectedMD5 };

        } catch (error) {
            this.logError(`WriteFlashSafe failed: ${error.message}`);
            throw error;
        }
    }

    async blankCheck(cbr) {
        const startAddress = 0x000000;
        const endAddress = 0x800000;
        const blockSize = 0x200;

        let totalReads = 0;
        let totalTime = 0;
        let erasedBytesTotal = 0;
        let currentAddress = startAddress;

        while (currentAddress < endAddress) {

            try {
                const startTime = Date.now();
                var rawData = await this.readFlash(currentAddress, blockSize);
                const endTimeRead = Date.now();
                const readDuration = endTimeRead - startTime;

                var erasedBytes = 0;
                for (var pos = 0; pos < rawData.length; pos++) {
                    if (rawData[pos] == 0xFF) {
                        erasedBytes++;
                    }
                }

                currentAddress += rawData.length;
                erasedBytesTotal += erasedBytes;
                totalTime += readDuration;
                totalReads++;

                cbr && cbr(currentAddress, startAddress, endAddress, blockSize, erasedBytes, erasedBytesTotal);
            } catch (error) {
                this.logError(`Read failed due to an error`, `${error.message}`);
                this.disconnect();
                break;
            }
        }

        if (totalReads > 0) {
            const averageTime = totalTime / totalReads;
            this.logDebug(`Average read time: ${averageTime.toFixed(2)} ms over ${totalReads} reads.`);
        }
    }

    async writeReadTest(address, size, cbr) {
        try {
            /* Step 1: Read original data */
            this.logDebug(`Test: Reading original ${size} bytes from 0x${address.toString(16).padStart(8, '0')}...`);
            cbr && cbr('reading_original', 0, 3);
            const originalData = await this.readFlash(address, size);
            this.logDebug(`Original data read complete`);

            /* Hexdump original data (first 64 bytes) */
            const dumpSize = Math.min(64, size);
            this.logDebug(`Original data hexdump (first ${dumpSize} bytes):`);
            for (let i = 0; i < dumpSize; i += 16) {
                const chunk = originalData.slice(i, i + 16);
                const hex = Array.from(chunk).map(b => b.toString(16).padStart(2, '0')).join(' ');
                const ascii = Array.from(chunk).map(b => (b >= 32 && b < 127) ? String.fromCharCode(b) : '.').join('');
                this.logDebug(`  ${(address + i).toString(16).padStart(8, '0')}: ${hex.padEnd(47, ' ')} |${ascii}|`);
            }

            /* Step 2: Generate random data */
            this.logDebug(`Test: Generating ${size} bytes of random data...`);
            cbr && cbr('generating_random', 1, 3);
            const randomData = new Uint8Array(size);
            for (let i = 0; i < size; i++) {
                randomData[i] = Math.floor(Math.random() * 256);
            }
            this.logDebug(`Random data generated`);

            /* Hexdump random data (first 64 bytes) */
            this.logDebug(`Random data hexdump (first ${dumpSize} bytes):`);
            for (let i = 0; i < dumpSize; i += 16) {
                const chunk = randomData.slice(i, i + 16);
                const hex = Array.from(chunk).map(b => b.toString(16).padStart(2, '0')).join(' ');
                const ascii = Array.from(chunk).map(b => (b >= 32 && b < 127) ? String.fromCharCode(b) : '.').join('');
                this.logDebug(`  ${(address + i).toString(16).padStart(8, '0')}: ${hex.padEnd(47, ' ')} |${ascii}|`);
            }

            /* Step 3: Write random data to flash */
            this.logDebug(`Test: Writing ${size} bytes to flash at 0x${address.toString(16).padStart(8, '0')}...`);
            cbr && cbr('writing', 2, 3);
            await this.writeFlash(address, randomData, (offset, total) => {
                const percent = Math.round((offset / total) * 100);
                cbr && cbr('writing', 2, 3, percent);
            });
            this.logDebug(`Write complete`);

            /* Step 4: Read back the data */
            this.logDebug(`Test: Reading back ${size} bytes from 0x${address.toString(16).padStart(8, '0')}...`);
            cbr && cbr('reading_back', 3, 3);
            const readbackData = await this.readFlash(address, size);
            this.logDebug(`Readback complete`);

            /* Hexdump readback data (first 64 bytes) */
            this.logDebug(`Readback data hexdump (first ${dumpSize} bytes):`);
            for (let i = 0; i < dumpSize; i += 16) {
                const chunk = readbackData.slice(i, i + 16);
                const hex = Array.from(chunk).map(b => b.toString(16).padStart(2, '0')).join(' ');
                const ascii = Array.from(chunk).map(b => (b >= 32 && b < 127) ? String.fromCharCode(b) : '.').join('');
                this.logDebug(`  ${(address + i).toString(16).padStart(8, '0')}: ${hex.padEnd(47, ' ')} |${ascii}|`);
            }

            /* Step 5: Verify data matches */
            let errors = 0;
            let firstError = -1;
            for (let i = 0; i < size; i++) {
                if (randomData[i] !== readbackData[i]) {
                    if (firstError === -1) {
                        firstError = i;
                    }
                    errors++;
                }
            }

            const result = {
                success: errors === 0,
                errors: errors,
                firstError: firstError,
                address: address,
                size: size,
                originalData: originalData,
                randomData: randomData,
                readbackData: readbackData
            };

            if (errors === 0) {
                this.logDebug(`✓ Test PASSED: All ${size} bytes match!`);
            } else {
                this.logError(`✗ Test FAILED: ${errors} byte(s) mismatch!`);
                this.logError(`  First error at offset 0x${firstError.toString(16).padStart(4, '0')} (byte ${firstError})`);
                this.logError(`  Expected: 0x${randomData[firstError].toString(16).padStart(2, '0')}, Got: 0x${readbackData[firstError].toString(16).padStart(2, '0')}`);
            }

            cbr && cbr('complete', 3, 3, 100, result);
            return result;

        } catch (error) {
            this.logError(`Write/Read test failed: ${error.message}`);
            cbr && cbr('error', 0, 3, 0, { success: false, error: error.message });
            throw error;
        }
    }

    buildCommandPacketU32(command, ...values) {
        /* Calculate total length for data */
        let totalLength = 0;
        values.forEach(value => {
            if (typeof value === 'number') {
                totalLength += 4; // uint32 is 4 bytes
            } else if (value instanceof Uint8Array) {
                totalLength += value.length;
            }
        });

        /* Convert each uint32_t to little-endian bytes or append byte arrays */
        const data = new Uint8Array(totalLength);
        let offset = 0;
        values.forEach(value => {
            if (typeof value === 'number') {
                data[offset] = (value >> 0) & 0xFF;
                data[offset + 1] = (value >> 8) & 0xFF;
                data[offset + 2] = (value >> 16) & 0xFF;
                data[offset + 3] = (value >> 24) & 0xFF;
                offset += 4;
            } else if (value instanceof Uint8Array) {
                data.set(value, offset);
                offset += value.length;
            }
        });

        /* Call the original function with the constructed data */
        return this.buildCommandPacket(command, data);
    }

    buildCommandPacket(command, data) {
        /* Construct command packet */
        const direction = 0x00;
        const size = data.length;
        let checksum = 0;

        if (size > 32) {
            checksum = 0xEF;
            for (let index = 16; index < size; index++) {
                checksum ^= data[index];
            }
        }

        const packet = new Uint8Array(8 + size);
        packet[0] = direction;
        packet[1] = command;
        packet[2] = size & 0xff;
        packet[3] = (size >> 8) & 0xff;
        packet[4] = checksum & 0xff;
        packet[5] = (checksum >> 8) & 0xff;
        packet[6] = (checksum >> 16) & 0xff;
        packet[7] = (checksum >> 24) & 0xff;
        packet.set(data, 8);

        var ret = {};

        ret.command = command;
        ret.payload = packet;

        return ret;
    }

    dumpPacket(pkt) {

        if (!this.devMode) {
            return;
        }
        if (pkt.dir == 0) {
            console.log(`Command: `, pkt);
            console.log(`Command raw: ${Array.from(pkt.raw).map(byte => byte.toString(16).padStart(2, '0')).join(' ')}`);
        }
        if (pkt.dir == 1) {
            console.log(`Response: `, pkt);
            console.log(`Response raw: ${Array.from(pkt.raw).map(byte => byte.toString(16).padStart(2, '0')).join(' ')}`);
        }
    }

    parsePacket(packet) {
        var pkt = {};

        pkt.dir = packet[0];
        pkt.command = packet[1];
        pkt.size = packet[2] | (packet[3] << 8);
        pkt.value = (packet[4] | (packet[5] << 8) | (packet[6] << 16) | (packet[7] << 24)) >>> 0;

        if (pkt.dir > 2 || packet.length != 8 + pkt.size) {
            return null;
        }
        pkt.data = packet.slice(8, 8 + pkt.size);
        pkt.raw = packet;

        return pkt;
    }

    async processPacket(packet) {
        var pkt = this.parsePacket(packet);

        if (pkt && pkt.dir === 0x01) {

            this.dumpPacket(pkt);
            /* Call response handler if registered */
            if (this.responseHandlers.has(pkt.command)) {
                var handler = this.responseHandlers.get(pkt.command);
                await handler(pkt);
            }
        } else {
            //console.log(`Received raw SLIP: ${ Array.from(packet).map(byte => byte.toString(16).padStart(2, '0')).join(' ') }`);

            if (this.responseHandlers.has(-1)) {
                var handler = this.responseHandlers.get(-1);
                await handler(packet);
            }
        }
    }

    /* MD5 implementation - constants and helper functions */
    Md5 = (function () {
        const ARRAY_BUFFER = typeof ArrayBuffer !== 'undefined';
        const HEX_CHARS = '0123456789abcdef'.split('');
        const EXTRA = [128, 32768, 8388608, -2147483648];
        const SHIFT = [0, 8, 16, 24];
        const FINALIZE_ERROR = 'finalize already called';

        let blocks = [], buffer8;
        if (ARRAY_BUFFER) {
            const buffer = new ArrayBuffer(68);
            buffer8 = new Uint8Array(buffer);
            blocks = new Uint32Array(buffer);
        }

        function formatMessage(message) {
            if (typeof message === 'string') {
                return [message, true];
            }
            if (message instanceof ArrayBuffer) {
                return [new Uint8Array(message), false];
            }
            if (message.constructor === Uint8Array || message.constructor === Array) {
                return [message, false];
            }
            return [message, false];
        }

        /**
         * Md5 class
         * @class Md5
         * @description This is internal class.
         * @see {@link md5.create}
         */
        function Md5(sharedMemory) {
            if (sharedMemory) {
                blocks[0] = blocks[16] = blocks[1] = blocks[2] = blocks[3] =
                    blocks[4] = blocks[5] = blocks[6] = blocks[7] =
                    blocks[8] = blocks[9] = blocks[10] = blocks[11] =
                    blocks[12] = blocks[13] = blocks[14] = blocks[15] = 0;
                this.blocks = blocks;
                this.buffer8 = buffer8;
            } else {
                if (ARRAY_BUFFER) {
                    var buffer = new ArrayBuffer(68);
                    this.buffer8 = new Uint8Array(buffer);
                    this.blocks = new Uint32Array(buffer);
                } else {
                    this.blocks = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
                }
            }
            this.h0 = this.h1 = this.h2 = this.h3 = this.start = this.bytes = this.hBytes = 0;
            this.finalized = this.hashed = false;
            this.first = true;
        }

        /**
         * from https://www.npmjs.com/package/js-md5
         * @method update
         * @memberof Md5
         * @instance
         * @description Update hash
         * @param {String|Array|Uint8Array|ArrayBuffer} message message to hash
         * @returns {Md5} Md5 object.
         * @see {@link md5.update}
         */
        Md5.prototype.update = function (message) {
            if (this.finalized) {
                throw new Error(FINALIZE_ERROR);
            }

            var result = formatMessage(message);
            message = result[0];
            var isString = result[1];
            var code, index = 0, i, length = message.length, blocks = this.blocks;
            var buffer8 = this.buffer8;

            while (index < length) {
                if (this.hashed) {
                    this.hashed = false;
                    blocks[0] = blocks[16];
                    blocks[16] = blocks[1] = blocks[2] = blocks[3] =
                        blocks[4] = blocks[5] = blocks[6] = blocks[7] =
                        blocks[8] = blocks[9] = blocks[10] = blocks[11] =
                        blocks[12] = blocks[13] = blocks[14] = blocks[15] = 0;
                }

                if (isString) {
                    if (ARRAY_BUFFER) {
                        for (i = this.start; index < length && i < 64; ++index) {
                            code = message.charCodeAt(index);
                            if (code < 0x80) {
                                buffer8[i++] = code;
                            } else if (code < 0x800) {
                                buffer8[i++] = 0xc0 | (code >>> 6);
                                buffer8[i++] = 0x80 | (code & 0x3f);
                            } else if (code < 0xd800 || code >= 0xe000) {
                                buffer8[i++] = 0xe0 | (code >>> 12);
                                buffer8[i++] = 0x80 | ((code >>> 6) & 0x3f);
                                buffer8[i++] = 0x80 | (code & 0x3f);
                            } else {
                                code = 0x10000 + (((code & 0x3ff) << 10) | (message.charCodeAt(++index) & 0x3ff));
                                buffer8[i++] = 0xf0 | (code >>> 18);
                                buffer8[i++] = 0x80 | ((code >>> 12) & 0x3f);
                                buffer8[i++] = 0x80 | ((code >>> 6) & 0x3f);
                                buffer8[i++] = 0x80 | (code & 0x3f);
                            }
                        }
                    } else {
                        for (i = this.start; index < length && i < 64; ++index) {
                            code = message.charCodeAt(index);
                            if (code < 0x80) {
                                blocks[i >>> 2] |= code << SHIFT[i++ & 3];
                            } else if (code < 0x800) {
                                blocks[i >>> 2] |= (0xc0 | (code >>> 6)) << SHIFT[i++ & 3];
                                blocks[i >>> 2] |= (0x80 | (code & 0x3f)) << SHIFT[i++ & 3];
                            } else if (code < 0xd800 || code >= 0xe000) {
                                blocks[i >>> 2] |= (0xe0 | (code >>> 12)) << SHIFT[i++ & 3];
                                blocks[i >>> 2] |= (0x80 | ((code >>> 6) & 0x3f)) << SHIFT[i++ & 3];
                                blocks[i >>> 2] |= (0x80 | (code & 0x3f)) << SHIFT[i++ & 3];
                            } else {
                                code = 0x10000 + (((code & 0x3ff) << 10) | (message.charCodeAt(++index) & 0x3ff));
                                blocks[i >>> 2] |= (0xf0 | (code >>> 18)) << SHIFT[i++ & 3];
                                blocks[i >>> 2] |= (0x80 | ((code >>> 12) & 0x3f)) << SHIFT[i++ & 3];
                                blocks[i >>> 2] |= (0x80 | ((code >>> 6) & 0x3f)) << SHIFT[i++ & 3];
                                blocks[i >>> 2] |= (0x80 | (code & 0x3f)) << SHIFT[i++ & 3];
                            }
                        }
                    }
                } else {
                    if (ARRAY_BUFFER) {
                        for (i = this.start; index < length && i < 64; ++index) {
                            buffer8[i++] = message[index];
                        }
                    } else {
                        for (i = this.start; index < length && i < 64; ++index) {
                            blocks[i >>> 2] |= message[index] << SHIFT[i++ & 3];
                        }
                    }
                }
                this.lastByteIndex = i;
                this.bytes += i - this.start;
                if (i >= 64) {
                    this.start = i - 64;
                    this.hash();
                    this.hashed = true;
                } else {
                    this.start = i;
                }
            }
            if (this.bytes > 4294967295) {
                this.hBytes += this.bytes / 4294967296 << 0;
                this.bytes = this.bytes % 4294967296;
            }
            return this;
        };

        Md5.prototype.finalize = function () {
            if (this.finalized) {
                return;
            }
            this.finalized = true;
            var blocks = this.blocks, i = this.lastByteIndex;
            blocks[i >>> 2] |= EXTRA[i & 3];
            if (i >= 56) {
                if (!this.hashed) {
                    this.hash();
                }
                blocks[0] = blocks[16];
                blocks[16] = blocks[1] = blocks[2] = blocks[3] =
                    blocks[4] = blocks[5] = blocks[6] = blocks[7] =
                    blocks[8] = blocks[9] = blocks[10] = blocks[11] =
                    blocks[12] = blocks[13] = blocks[14] = blocks[15] = 0;
            }
            blocks[14] = this.bytes << 3;
            blocks[15] = this.hBytes << 3 | this.bytes >>> 29;
            this.hash();
        };

        Md5.prototype.hash = function () {
            var a, b, c, d, bc, da, blocks = this.blocks;

            if (this.first) {
                a = blocks[0] - 680876937;
                a = (a << 7 | a >>> 25) - 271733879 << 0;
                d = (-1732584194 ^ a & 2004318071) + blocks[1] - 117830708;
                d = (d << 12 | d >>> 20) + a << 0;
                c = (-271733879 ^ (d & (a ^ -271733879))) + blocks[2] - 1126478375;
                c = (c << 17 | c >>> 15) + d << 0;
                b = (a ^ (c & (d ^ a))) + blocks[3] - 1316259209;
                b = (b << 22 | b >>> 10) + c << 0;
            } else {
                a = this.h0;
                b = this.h1;
                c = this.h2;
                d = this.h3;
                a += (d ^ (b & (c ^ d))) + blocks[0] - 680876936;
                a = (a << 7 | a >>> 25) + b << 0;
                d += (c ^ (a & (b ^ c))) + blocks[1] - 389564586;
                d = (d << 12 | d >>> 20) + a << 0;
                c += (b ^ (d & (a ^ b))) + blocks[2] + 606105819;
                c = (c << 17 | c >>> 15) + d << 0;
                b += (a ^ (c & (d ^ a))) + blocks[3] - 1044525330;
                b = (b << 22 | b >>> 10) + c << 0;
            }

            a += (d ^ (b & (c ^ d))) + blocks[4] - 176418897;
            a = (a << 7 | a >>> 25) + b << 0;
            d += (c ^ (a & (b ^ c))) + blocks[5] + 1200080426;
            d = (d << 12 | d >>> 20) + a << 0;
            c += (b ^ (d & (a ^ b))) + blocks[6] - 1473231341;
            c = (c << 17 | c >>> 15) + d << 0;
            b += (a ^ (c & (d ^ a))) + blocks[7] - 45705983;
            b = (b << 22 | b >>> 10) + c << 0;
            a += (d ^ (b & (c ^ d))) + blocks[8] + 1770035416;
            a = (a << 7 | a >>> 25) + b << 0;
            d += (c ^ (a & (b ^ c))) + blocks[9] - 1958414417;
            d = (d << 12 | d >>> 20) + a << 0;
            c += (b ^ (d & (a ^ b))) + blocks[10] - 42063;
            c = (c << 17 | c >>> 15) + d << 0;
            b += (a ^ (c & (d ^ a))) + blocks[11] - 1990404162;
            b = (b << 22 | b >>> 10) + c << 0;
            a += (d ^ (b & (c ^ d))) + blocks[12] + 1804603682;
            a = (a << 7 | a >>> 25) + b << 0;
            d += (c ^ (a & (b ^ c))) + blocks[13] - 40341101;
            d = (d << 12 | d >>> 20) + a << 0;
            c += (b ^ (d & (a ^ b))) + blocks[14] - 1502002290;
            c = (c << 17 | c >>> 15) + d << 0;
            b += (a ^ (c & (d ^ a))) + blocks[15] + 1236535329;
            b = (b << 22 | b >>> 10) + c << 0;
            a += (c ^ (d & (b ^ c))) + blocks[1] - 165796510;
            a = (a << 5 | a >>> 27) + b << 0;
            d += (b ^ (c & (a ^ b))) + blocks[6] - 1069501632;
            d = (d << 9 | d >>> 23) + a << 0;
            c += (a ^ (b & (d ^ a))) + blocks[11] + 643717713;
            c = (c << 14 | c >>> 18) + d << 0;
            b += (d ^ (a & (c ^ d))) + blocks[0] - 373897302;
            b = (b << 20 | b >>> 12) + c << 0;
            a += (c ^ (d & (b ^ c))) + blocks[5] - 701558691;
            a = (a << 5 | a >>> 27) + b << 0;
            d += (b ^ (c & (a ^ b))) + blocks[10] + 38016083;
            d = (d << 9 | d >>> 23) + a << 0;
            c += (a ^ (b & (d ^ a))) + blocks[15] - 660478335;
            c = (c << 14 | c >>> 18) + d << 0;
            b += (d ^ (a & (c ^ d))) + blocks[4] - 405537848;
            b = (b << 20 | b >>> 12) + c << 0;
            a += (c ^ (d & (b ^ c))) + blocks[9] + 568446438;
            a = (a << 5 | a >>> 27) + b << 0;
            d += (b ^ (c & (a ^ b))) + blocks[14] - 1019803690;
            d = (d << 9 | d >>> 23) + a << 0;
            c += (a ^ (b & (d ^ a))) + blocks[3] - 187363961;
            c = (c << 14 | c >>> 18) + d << 0;
            b += (d ^ (a & (c ^ d))) + blocks[8] + 1163531501;
            b = (b << 20 | b >>> 12) + c << 0;
            a += (c ^ (d & (b ^ c))) + blocks[13] - 1444681467;
            a = (a << 5 | a >>> 27) + b << 0;
            d += (b ^ (c & (a ^ b))) + blocks[2] - 51403784;
            d = (d << 9 | d >>> 23) + a << 0;
            c += (a ^ (b & (d ^ a))) + blocks[7] + 1735328473;
            c = (c << 14 | c >>> 18) + d << 0;
            b += (d ^ (a & (c ^ d))) + blocks[12] - 1926607734;
            b = (b << 20 | b >>> 12) + c << 0;
            bc = b ^ c;
            a += (bc ^ d) + blocks[5] - 378558;
            a = (a << 4 | a >>> 28) + b << 0;
            d += (bc ^ a) + blocks[8] - 2022574463;
            d = (d << 11 | d >>> 21) + a << 0;
            da = d ^ a;
            c += (da ^ b) + blocks[11] + 1839030562;
            c = (c << 16 | c >>> 16) + d << 0;
            b += (da ^ c) + blocks[14] - 35309556;
            b = (b << 23 | b >>> 9) + c << 0;
            bc = b ^ c;
            a += (bc ^ d) + blocks[1] - 1530992060;
            a = (a << 4 | a >>> 28) + b << 0;
            d += (bc ^ a) + blocks[4] + 1272893353;
            d = (d << 11 | d >>> 21) + a << 0;
            da = d ^ a;
            c += (da ^ b) + blocks[7] - 155497632;
            c = (c << 16 | c >>> 16) + d << 0;
            b += (da ^ c) + blocks[10] - 1094730640;
            b = (b << 23 | b >>> 9) + c << 0;
            bc = b ^ c;
            a += (bc ^ d) + blocks[13] + 681279174;
            a = (a << 4 | a >>> 28) + b << 0;
            d += (bc ^ a) + blocks[0] - 358537222;
            d = (d << 11 | d >>> 21) + a << 0;
            da = d ^ a;
            c += (da ^ b) + blocks[3] - 722521979;
            c = (c << 16 | c >>> 16) + d << 0;
            b += (da ^ c) + blocks[6] + 76029189;
            b = (b << 23 | b >>> 9) + c << 0;
            bc = b ^ c;
            a += (bc ^ d) + blocks[9] - 640364487;
            a = (a << 4 | a >>> 28) + b << 0;
            d += (bc ^ a) + blocks[12] - 421815835;
            d = (d << 11 | d >>> 21) + a << 0;
            da = d ^ a;
            c += (da ^ b) + blocks[15] + 530742520;
            c = (c << 16 | c >>> 16) + d << 0;
            b += (da ^ c) + blocks[2] - 995338651;
            b = (b << 23 | b >>> 9) + c << 0;
            a += (c ^ (b | ~d)) + blocks[0] - 198630844;
            a = (a << 6 | a >>> 26) + b << 0;
            d += (b ^ (a | ~c)) + blocks[7] + 1126891415;
            d = (d << 10 | d >>> 22) + a << 0;
            c += (a ^ (d | ~b)) + blocks[14] - 1416354905;
            c = (c << 15 | c >>> 17) + d << 0;
            b += (d ^ (c | ~a)) + blocks[5] - 57434055;
            b = (b << 21 | b >>> 11) + c << 0;
            a += (c ^ (b | ~d)) + blocks[12] + 1700485571;
            a = (a << 6 | a >>> 26) + b << 0;
            d += (b ^ (a | ~c)) + blocks[3] - 1894986606;
            d = (d << 10 | d >>> 22) + a << 0;
            c += (a ^ (d | ~b)) + blocks[10] - 1051523;
            c = (c << 15 | c >>> 17) + d << 0;
            b += (d ^ (c | ~a)) + blocks[1] - 2054922799;
            b = (b << 21 | b >>> 11) + c << 0;
            a += (c ^ (b | ~d)) + blocks[8] + 1873313359;
            a = (a << 6 | a >>> 26) + b << 0;
            d += (b ^ (a | ~c)) + blocks[15] - 30611744;
            d = (d << 10 | d >>> 22) + a << 0;
            c += (a ^ (d | ~b)) + blocks[6] - 1560198380;
            c = (c << 15 | c >>> 17) + d << 0;
            b += (d ^ (c | ~a)) + blocks[13] + 1309151649;
            b = (b << 21 | b >>> 11) + c << 0;
            a += (c ^ (b | ~d)) + blocks[4] - 145523070;
            a = (a << 6 | a >>> 26) + b << 0;
            d += (b ^ (a | ~c)) + blocks[11] - 1120210379;
            d = (d << 10 | d >>> 22) + a << 0;
            c += (a ^ (d | ~b)) + blocks[2] + 718787259;
            c = (c << 15 | c >>> 17) + d << 0;
            b += (d ^ (c | ~a)) + blocks[9] - 343485551;
            b = (b << 21 | b >>> 11) + c << 0;

            if (this.first) {
                this.h0 = a + 1732584193 << 0;
                this.h1 = b - 271733879 << 0;
                this.h2 = c - 1732584194 << 0;
                this.h3 = d + 271733878 << 0;
                this.first = false;
            } else {
                this.h0 = this.h0 + a << 0;
                this.h1 = this.h1 + b << 0;
                this.h2 = this.h2 + c << 0;
                this.h3 = this.h3 + d << 0;
            }
        };
        /**
         * @method hex
         * @memberof Md5
         * @instance
         * @description Output hash as hex string
         * @returns {String} Hex string
         * @see {@link md5.hex}
         * @example
         * hash.hex();
         */
        Md5.prototype.hex = function () {
            this.finalize();

            var h0 = this.h0, h1 = this.h1, h2 = this.h2, h3 = this.h3;

            return HEX_CHARS[(h0 >>> 4) & 0x0F] + HEX_CHARS[h0 & 0x0F] +
                HEX_CHARS[(h0 >>> 12) & 0x0F] + HEX_CHARS[(h0 >>> 8) & 0x0F] +
                HEX_CHARS[(h0 >>> 20) & 0x0F] + HEX_CHARS[(h0 >>> 16) & 0x0F] +
                HEX_CHARS[(h0 >>> 28) & 0x0F] + HEX_CHARS[(h0 >>> 24) & 0x0F] +
                HEX_CHARS[(h1 >>> 4) & 0x0F] + HEX_CHARS[h1 & 0x0F] +
                HEX_CHARS[(h1 >>> 12) & 0x0F] + HEX_CHARS[(h1 >>> 8) & 0x0F] +
                HEX_CHARS[(h1 >>> 20) & 0x0F] + HEX_CHARS[(h1 >>> 16) & 0x0F] +
                HEX_CHARS[(h1 >>> 28) & 0x0F] + HEX_CHARS[(h1 >>> 24) & 0x0F] +
                HEX_CHARS[(h2 >>> 4) & 0x0F] + HEX_CHARS[h2 & 0x0F] +
                HEX_CHARS[(h2 >>> 12) & 0x0F] + HEX_CHARS[(h2 >>> 8) & 0x0F] +
                HEX_CHARS[(h2 >>> 20) & 0x0F] + HEX_CHARS[(h2 >>> 16) & 0x0F] +
                HEX_CHARS[(h2 >>> 28) & 0x0F] + HEX_CHARS[(h2 >>> 24) & 0x0F] +
                HEX_CHARS[(h3 >>> 4) & 0x0F] + HEX_CHARS[h3 & 0x0F] +
                HEX_CHARS[(h3 >>> 12) & 0x0F] + HEX_CHARS[(h3 >>> 8) & 0x0F] +
                HEX_CHARS[(h3 >>> 20) & 0x0F] + HEX_CHARS[(h3 >>> 16) & 0x0F] +
                HEX_CHARS[(h3 >>> 28) & 0x0F] + HEX_CHARS[(h3 >>> 24) & 0x0F];
        };


        return Md5;
    })();


}