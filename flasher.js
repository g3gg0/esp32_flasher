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
                    logError(`The device was disconnected`);
                    this.disconnect();
                }
            });

            // Register for port closing
            this.port.addEventListener('close', () => {
                logError('Serial port closed');
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

    async executeCommand(packet, callback, default_callback, timeout = 500) {
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
                reject(new Error(`Timeout after ${timeout} ms waiting for response to command ${packet.command}`));
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
                    console.log("Final MEM_END ACK");
                },
                async (resolve, reject, rawData) => {
                    const decoder = new TextDecoder('utf-8');
                    const responseData = decoder.decode(rawData);

                    if (responseData == "OHAI") {
                        this.logDebug(`Stub loader executed successfully(received ${responseData})`);
                        this.stubLoaded = true;
                        resolve();
                    }
                });
        } catch (error) {
            this.logError("Failed to execute stub", "Is the device locked?");
            return false;
        }

        await this.executeCommand(this.buildCommandPacketU32(SPI_SET_PARAMS, 0, 0x800000, 64 * 1024, 4 * 1024, 256, 0xFFFF), async (resolve, reject, responsePacket) => {
            console.log("SPI_SET_PARAMS", responsePacket);
            resolve();
        });

        return true;
    }

    async writeFlash(address, data, progressCallback) {

        const MAX_PACKET_SIZE = 1024;
        const packets = Math.ceil(data.length / MAX_PACKET_SIZE);

        /* Send FLASH_BEGIN command with the total data size */
        await this.executeCommand(
            this.buildCommandPacketU32(FLASH_BEGIN, data.length, packets,
                Math.min(MAX_PACKET_SIZE, data.length),
                address, this.stubLoaded ? undefined : 0
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
                1000
            );
            if (progressCallback) {
                progressCallback(offset, data.length);
            }
        }
    }

    async readFlash(address, blockSize = 0x100) {
        let packet = 0;
        var data = {};

        if (blockSize > 0x1000) {
            blockSize = 0x1000;
        }

        return this.executeCommand(
            this.buildCommandPacketU32(READ_FLASH, address, blockSize, 0x1000, 1),
            async (resolve, reject, responsePacket) => {
                packet = 0;
            },
            async (resolve, reject, rawData) => {
                if (packet == 0) {
                    data = rawData;

                    /* Prepare response */
                    var resp = new Uint8Array(4);
                    resp[0] = (blockSize >> 0) & 0xFF;
                    resp[1] = (blockSize >> 8) & 0xFF;
                    resp[2] = (blockSize >> 16) & 0xFF;
                    resp[3] = (blockSize >> 24) & 0xFF;

                    /* Encode and write response */
                    const slipFrame = this.slipLayer.encode(resp);

                    const writer = this.port.writable.getWriter();
                    await writer.write(slipFrame);
                    await writer.releaseLock();
                } else if (packet == 1) {
                    resolve(data);
                }
                packet++;
            },
            1000
        );
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
}