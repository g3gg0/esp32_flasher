/**
 * ESP32 Bootloader Command Codes
 * Commands for communication with ESP32 ROM bootloader and stub loader
 */
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

/**
 * IMPORTANT: For browser usage, chips.js must be loaded BEFORE flasher.js
 * 
 * This will make ChipDescriptions available globally for flasher.js to use.
 * For Node.js, flasher.js will automatically require('./chips.js')
 */

/* Resolve ChipDescriptions for both browser and Node environments */
const ChipDescriptionsClass = typeof ChipDescriptions !== 'undefined'
    ? ChipDescriptions
    : (typeof require !== 'undefined' ? require('./chips.js') : null);

/* ESP32 Reset Reason Codes (from ESP-IDF esp_system.h) */
const RESET_REASON_MAP = {
    0: { name: 'NO_MEAN', desc: 'No reset reason' },
    1: { name: 'POWERON_RESET', desc: 'Vbat power on reset' },
    3: { name: 'RTC_SW_SYS_RESET', desc: 'Software reset digital core' },
    5: { name: 'DEEPSLEEP_RESET', desc: 'Deep Sleep reset digital core' },
    7: { name: 'TG0WDT_SYS_RESET', desc: 'Timer Group0 Watch dog reset digital core' },
    8: { name: 'TG1WDT_SYS_RESET', desc: 'Timer Group1 Watch dog reset digital core' },
    9: { name: 'RTCWDT_SYS_RESET', desc: 'RTC Watch dog Reset digital core' },
    10: { name: 'INTRUSION_RESET', desc: 'Intrusion tested to reset CPU' },
    11: { name: 'TG0WDT_CPU_RESET', desc: 'Timer Group0 reset CPU' },
    12: { name: 'RTC_SW_CPU_RESET', desc: 'Software reset CPU' },
    13: { name: 'RTCWDT_CPU_RESET', desc: 'RTC Watch dog Reset CPU' },
    15: { name: 'RTCWDT_BROWN_OUT_RESET', desc: 'Reset when the vdd voltage is not stable' },
    16: { name: 'RTCWDT_RTC_RESET', desc: 'RTC Watch dog reset digital core and rtc module' },
    17: { name: 'TG1WDT_CPU_RESET', desc: 'Timer Group1 reset CPU' },
    18: { name: 'SUPER_WDT_RESET', desc: 'Super watchdog reset digital core and rtc module' },
    19: { name: 'GLITCH_RTC_RESET', desc: 'Glitch reset digital core and rtc module' },
    20: { name: 'EFUSE_RESET', desc: 'eFuse reset digital core' },
    21: { name: 'USB_UART_CHIP_RESET', desc: 'USB UART reset digital core' },
    22: { name: 'USB_JTAG_CHIP_RESET', desc: 'USB JTAG reset digital core' },
    23: { name: 'POWER_GLITCH_RESET', desc: 'Power glitch reset digital core and rtc module' }
};

const CHIP_ID_MAP = {
    0x0000: 'esp32',
    0x0002: 'esp32s2',
    0x0005: 'esp32c3',
    0x0009: 'esp32s3',
    0x000C: 'esp32c2',
    0x000D: 'esp32c6',
    0x0010: 'esp32h2',
    0x0012: 'esp32p4',
    0x0017: 'esp32c5',
    0x0014: 'esp32c61',
    0x0019: 'esp32h21',
    0x001C: 'esp32h4',
    0x0020: 'esp32s31',
    0xFFFF: 'Invalid'
};

/**
 * SLIP Protocol Layer Handler
 * Implements Serial Line IP (RFC 1055) encoding/decoding for packet framing
 */
class SlipLayer {
    /**
     * Initialize SLIP layer with empty buffer
     */
    constructor() {
        this.buffer = [];
        this.escaping = false;
        this.logPackets = false;
        this.logDebug = (...args) => { };
        this.logError = (...args) => { };
    }

    /**
     * Log SLIP layer data with color coding
     * @param {Uint8Array} data - Data to log
     * @param {string} type - 'ENCODE' or 'DECODE'
     * @param {string} label - Description label
     */
    logSlipData(data, type, label) {
        if (!this.logPackets) return;

        this._preSyncState = 'idle';
        const isEncode = type === 'ENCODE'; const color = isEncode ? 'color: #FFC107; font-weight: bold' : 'color: #9C27B0; font-weight: bold';
        const symbol = isEncode ? '▶' : '◀';

        const maxBytes = 128;
        const truncated = data.length > maxBytes;

        let hexStr = '';
        let asciiStr = '';
        let lines = [];

        const formatBytes = (startIdx, endIdx) => {
            for (let i = startIdx; i < endIdx; i++) {
                const byte = data[i];
                hexStr += byte.toString(16).padStart(2, '0').toUpperCase() + ' ';
                asciiStr += (byte >= 32 && byte <= 126) ? String.fromCharCode(byte) : '.';

                if ((i + 1) % 16 === 0 || i === endIdx - 1) {
                    const hexPadding = ' '.repeat(Math.max(0, (16 - (i % 16) - 1) * 3));
                    lines.push(`    ${hexStr}${hexPadding} | ${asciiStr}`);
                    hexStr = '';
                    asciiStr = '';
                }
            }
        };

        if (truncated) {
            formatBytes(0, 64);
            const lastSectionStart = Math.floor((data.length - 64) / 16) * 16;
            const skipped = lastSectionStart - 64;
            lines.push(`    ... (${skipped} bytes omitted) ...`);
            formatBytes(lastSectionStart, data.length);
        } else {
            formatBytes(0, data.length);
        }

        const truncMsg = truncated ? ` (showing partially)` : '';
        this.logDebug(`${symbol} SLIP ${type} ${label} [${data.length} bytes]${truncMsg}`, {lines: lines});
    }

    /**
     * Encode data using SLIP framing
     * Wraps packet with SLIP_END delimiters and escapes special bytes
     * @param {Uint8Array} packet - Raw packet data
     * @returns {Uint8Array} SLIP-framed packet with delimiters
     */
    encode(packet) {
        const SLIP_END = 0xC0;
        const SLIP_ESC = 0xDB;
        const SLIP_ESC_END = 0xDC;
        const SLIP_ESC_ESC = 0xDD;

        this.logSlipData(packet, 'ENCODE', 'Payload before framing');

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
        const result = new Uint8Array(slipFrame);

        return result;
    }

    /**
     * Decode SLIP-framed packet stream
     * Extracts complete packets from framed data, handling escape sequences
     * @param {Uint8Array|ArrayLike} value - SLIP-encoded bytes
     * @returns {Uint8Array[]} Array of decoded complete packets
     */
    decode(value) {
        const SLIP_END = 0xC0;
        const SLIP_ESC = 0xDB;
        const SLIP_ESC_END = 0xDC;
        const SLIP_ESC_ESC = 0xDD;

        let outputPackets = [];

        for (let byte of value) {
            if (byte === SLIP_END) {
                if (this.buffer.length > 0) {
                    const packet = new Uint8Array(this.buffer);
                    outputPackets.push(packet);
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

        if (this.logPackets) {
            // Log decoded packets
            for (let i = 0; i < outputPackets.length; i++) {
                const label = outputPackets.length > 1 ? `Decoded packet ${i + 1}/${outputPackets.length}` : 'Decoded packet';
                this.logSlipData(outputPackets[i], 'DECODE', label);
            }
        }

        return outputPackets;
    }
}

/**
 * WebUSBSerial - Web Serial API-like wrapper for WebUSB
 * Provides a familiar interface for serial communication over USB
 */
class WebUSBSerial {
    constructor() {
        this.device = null;
        this.interfaceNumber = null;
        this.endpointIn = null;
        this.endpointOut = null;
        this.controlInterface = null;
        this.readableStream = null;
        this.writableStream = null;
        this._reader = null;
        this._writer = null;
        this._readLoopRunning = false;
        this._usbDisconnectHandler = null;
        this._eventListeners = {
            'close': [],
            'disconnect': []
        };
        this.logger = null; /* optional {info, error} callbacks for UI logging */
        this.maxTransferSize = 0x10000;
    }

    /**
     * Request USB device (mimics navigator.serial.requestPort())
     * @returns {Promise<WebUSBSerial>} This instance
     */
    static async requestPort() {
        const filters = [
            { vendorId: 0x303A }, // Espressif
            { vendorId: 0x0403 }, // FTDI
            { vendorId: 0x1A86 }, // CH340
            { vendorId: 0x10C4 }, // CP210x
            { vendorId: 0x067B }  // PL2303
        ];

        const device = await navigator.usb.requestDevice({ filters });
        const port = new WebUSBSerial();
        port.device = device;
        return port;
    }

    /**
     * Open the USB device (mimics port.open())
     * @param {Object} options - {baudRate: number}
     * @returns {Promise<void>}
     */
    async open(options = {}) {
        if (!this.device) {
            throw new Error('No device selected');
        }

        /* If already open (e.g., prior attempt), close to avoid stale claims */
        if (this.device.opened) {
            try { await this.device.close(); } catch (e) { }
        }

        /* Best-effort reset before attempting to open (helps if host kept a stale claim) */
        try { if (this.device.reset) { await this.device.reset(); } } catch (e) { }

        const attemptOpenAndClaim = async () => {
            await this.device.open();
            try {
                /* Ensure configuration 1 is selected; some hosts keep a different active config */
                const currentCfg = this.device.configuration ? this.device.configuration.configurationValue : null;
                if (!currentCfg || currentCfg !== 1) {
                    await this.device.selectConfiguration(1);
                }
            } catch (e) { /* ignore config select errors */ }

            const config = this.device.configuration;

            /* Try to claim CDC control interface FIRST on Android/CH34x to unblock data iface claim */
            const preControlIface = config.interfaces.find(i => i.alternates && i.alternates[0] && i.alternates[0].interfaceClass === 0x02);
            if (preControlIface) {
                try {
                    await this.device.claimInterface(preControlIface.interfaceNumber);
                    /* Ensure alt setting 0 is active */
                    try { await this.device.selectAlternateInterface(preControlIface.interfaceNumber, 0); } catch (e) { }
                    this.controlInterface = preControlIface.interfaceNumber;
                    this.logMessage(`[WebUSB] Pre-claimed CDC control iface ${preControlIface.interfaceNumber}`);
                } catch (e) {
                    this.logError(`[WebUSB] Could not pre-claim CDC control iface ${preControlIface.interfaceNumber}: ${e && e.message ? e.message : e}`);
                }
            }

            /* Collect all bulk IN/OUT interfaces and try preferred ones first (CDC > vendor > other)
               Rationale: Espressif composite devices expose CDC data on iface 1 (class 0x0A) and JTAG/debug on vendor iface 2.
               Selecting CDC first avoids landing on a non-UART function that won't speak the ROM bootloader. */
            const candidates = [];
            for (const iface of config.interfaces) {
                const alt = iface.alternates[0];
                let hasIn = false, hasOut = false;
                for (const ep of alt.endpoints) {
                    if (ep.type === 'bulk' && ep.direction === 'in') hasIn = true;
                    if (ep.type === 'bulk' && ep.direction === 'out') hasOut = true;
                }
                if (hasIn && hasOut) {
                    let score = 2; /* default */
                    if (alt.interfaceClass === 0x0a) score = 0; /* CDC data first */
                    else if (alt.interfaceClass === 0xff) score = 1; /* vendor-specific next */
                    candidates.push({ iface, score });
                }
            }

            if (!candidates.length) {
                await this._dumpDeviceDetails('No suitable USB interface found');
                throw new Error('No suitable USB interface found');
            }

            candidates.sort((a, b) => a.score - b.score);
            let lastErr = null;
            for (const cand of candidates) {
                try {
                    /* Ensure alt setting 0 before claiming */
                    try { await this.device.selectAlternateInterface(cand.iface.interfaceNumber, 0); } catch (e) { }
                    await this.device.claimInterface(cand.iface.interfaceNumber);
                    this.interfaceNumber = cand.iface.interfaceNumber;

                    /* Get endpoints */
                    const alt = cand.iface.alternates[0];
                    for (const ep of alt.endpoints) {
                        if (ep.type === 'bulk' && ep.direction === 'in') {
                            this.endpointIn = ep.endpointNumber;
                        } else if (ep.type === 'bulk' && ep.direction === 'out') {
                            this.endpointOut = ep.endpointNumber;
                        }
                    }
                    /* Adopt endpoint packet size as transfer length (Android prefers max-packet) */
                    try {
                        const inEp = alt.endpoints.find(ep => ep.type === 'bulk' && ep.direction === 'in');
                        if (inEp && inEp.packetSize) {
                            this.maxTransferSize = Math.min(inEp.packetSize, 64);
                        }
                    } catch (e) { }
                    this.logMessage(`[WebUSB] Claimed iface ${cand.iface.interfaceNumber} (class=${alt.interfaceClass}) with IN=${this.endpointIn} OUT=${this.endpointOut}`);
                    return config;
                } catch (claimErr) {
                    lastErr = claimErr;
                    this.logError(`[WebUSB] claim failed on iface ${cand.iface.interfaceNumber} (class=${cand.iface.alternates[0].interfaceClass}): ${claimErr && claimErr.message ? claimErr.message : claimErr}`);
                }
            }

            await this._dumpDeviceDetails('All candidate interfaces failed to claim', lastErr);
            this.logMessage('[WebUSB] If you are on Windows and see repeat claim failures, ensure the interface is bound to WinUSB (e.g., via Zadig) and close any app using it.');
            throw lastErr || new Error('Unable to claim any USB interface');
        };

        let config;
        try {
            config = await attemptOpenAndClaim();
        } catch (err) {
            console.warn('[WebUSBSerial-flasher] open/claim failed:', err.message);
            await this._dumpDeviceDetails('open/claim failed (first attempt)', err);
            /* Retry once after a best-effort device reset/close to clear stale claims (common on Android) */
            console.warn('[WebUSBSerial-flasher] claimInterface failed, retrying after reset/close:', err.message);
            try { if (this.device.reset) { await this.device.reset(); } } catch (e) { }
            try { await this.device.close(); } catch (e) { }
            try {
                config = await attemptOpenAndClaim();
            } catch (err2) {
                await this._dumpDeviceDetails('claimInterface failed (retry)', err2);
                throw new Error(`Unable to claim USB interface. This can happen if another app has the device open or Android retained a stale claim. Unplug/replug the device, close other apps, and retry. Original: ${err2.message}`);
            }
        }

        /* Control iface may already be claimed in attemptOpenAndClaim; avoid double-claim */
        if (this.controlInterface == null) {
            const controlIface = config.interfaces.find(i =>
                i.alternates[0].interfaceClass === 0x02 &&
                i.interfaceNumber !== this.interfaceNumber
            );

            if (controlIface) {
                try {
                    await this.device.claimInterface(controlIface.interfaceNumber);
                    try { await this.device.selectAlternateInterface(controlIface.interfaceNumber, 0); } catch (e) { }
                    this.controlInterface = controlIface.interfaceNumber;
                } catch (e) {
                    /* Use data interface for control if claim fails */
                    this.controlInterface = this.interfaceNumber;
                }
            } else {
                this.controlInterface = this.interfaceNumber;
            }
        }

        // Set line coding
        const baudRate = options.baudRate || 115200;
        try {
            const lineCoding = new Uint8Array([
                baudRate & 0xFF,
                (baudRate >> 8) & 0xFF,
                (baudRate >> 16) & 0xFF,
                (baudRate >> 24) & 0xFF,
                0x00, // 1 stop bit
                0x00, // No parity
                0x08  // 8 data bits
            ]);

            await this.device.controlTransferOut({
                requestType: 'class',
                recipient: 'interface',
                request: 0x20, // SET_LINE_CODING
                value: 0,
                index: this.controlInterface
            }, lineCoding);
        } catch (e) {
            console.warn('Could not set line coding:', e.message);
        }

        // Assert DTR/RTS
        try {
            await this.device.controlTransferOut({
                requestType: 'class',
                recipient: 'interface',
                request: 0x22, // SET_CONTROL_LINE_STATE
                value: 0x03, // DTR=1, RTS=1
                index: this.controlInterface
            });
        } catch (e) {
            console.warn('Could not set control lines:', e.message);
        }

        // Create streams
        this._createStreams();

        // Setup disconnect handler
        this.logDebug('[WebUSBSerial-flasher] Setting up USB disconnect handler');
        this._usbDisconnectHandler = (event) => {
            this.logDebug('[WebUSBSerial-flasher] USB disconnect event fired, device:', event.device.productId);
            if (event.device === this.device) {
                this.logDebug('[WebUSBSerial-flasher] Device matches, firing close event');
                // Fire 'close' event to mimic Web Serial behavior
                this._fireEvent('close');
                this._cleanup();
            } else {
                this.logDebug('[WebUSBSerial-flasher] Device mismatch - different device disconnected');
            }
        };
        navigator.usb.addEventListener('disconnect', this._usbDisconnectHandler);
        this.logDebug('[WebUSBSerial-flasher] Disconnect handler registered with navigator.usb');
    }

    /**
     * Close the device (mimics port.close())
     * @returns {Promise<void>}
     */
    async close() {
        this._cleanup();
        if (this.device) {
            try {
                if (this.interfaceNumber !== null) {
                    await this.device.releaseInterface(this.interfaceNumber);
                }
                if (this.controlInterface !== null && this.controlInterface !== this.interfaceNumber) {
                    await this.device.releaseInterface(this.controlInterface);
                }
                await this.device.close();
            } catch (e) {
                // Ignore errors if device already disconnected
                if (!e.message || !e.message.includes('disconnected')) {
                    console.warn('Error closing device:', e.message || e);
                }
            }
            this.device = null;
        }
    }

    /* Dump detailed device info for diagnostics */
    async _dumpDeviceDetails(label, err) {
        try {
            if (!this.device) {
                this.logMessage(`[WebUSB] ${label}: no device set`);
                return;
            }
            const d = this.device;
            const lines = [];
            lines.push(`[WebUSB] ${label}: ${err && err.message ? err.message : err || ''}`);
            lines.push(`[WebUSB] Basic: opened=${d.opened} vid=0x${(d.vendorId || 0).toString(16).padStart(4, '0')} pid=0x${(d.productId || 0).toString(16).padStart(4, '0')}`);
            lines.push(`[WebUSB] Strings: product="${d.productName || 'n/a'}" manufacturer="${d.manufacturerName || 'n/a'}" serial="${d.serialNumber || 'n/a'}"`);
            const cfg = d.configuration;
            if (!cfg) {
                lines.push('[WebUSB] No active configuration');
                this.logMessage(lines.join('\n'));
                return;
            }
            lines.push(`[WebUSB] Active config: value=${cfg.configurationValue} interfaces=${cfg.interfaces.length}`);
            for (const iface of cfg.interfaces) {
                const alt = iface.alternates[0];
                lines.push(`[WebUSB]  iface ${iface.interfaceNumber}: class=${alt.interfaceClass} subclass=${alt.interfaceSubclass} proto=${alt.interfaceProtocol} eps=${alt.endpoints.length}`);
                for (const ep of alt.endpoints) {
                    lines.push(`[WebUSB]    ep ${ep.endpointNumber}: dir=${ep.direction} type=${ep.type} packetSize=${ep.packetSize}`);
                }
            }
            this.logMessage(lines.join('\n'));
        } catch (dumpErr) {
            this.logError(`[WebUSB] Failed to dump device details: ${dumpErr && dumpErr.message ? dumpErr.message : dumpErr}`);
        }
    }

    /**
     * Get device info (mimics port.getInfo())
     * @returns {Object} {usbVendorId, usbProductId}
     */
    getInfo() {
        if (!this.device) {
            return {};
        }
        return {
            usbVendorId: this.device.vendorId,
            usbProductId: this.device.productId
        };
    }

    /**
     * Set DTR/RTS signals (mimics port.setSignals())
     * @param {Object} signals - {dataTerminalReady, requestToSend}
     * @returns {Promise<void>}
     */
    async setSignals(signals) {
        if (!this.device) {
            throw new Error('Device not open');
        }

        var value = 0;
        value |= signals.dataTerminalReady ? 1 : 0;
        value |= signals.requestToSend ? 2 : 0;

        return this.device.controlTransferOut({
            requestType: 'class',
            recipient: 'interface',
            request: 0x22, /* CDC_SET_CONTROL_LINE_STATE */
            value: value,
            index: this.controlInterface
        });
    }

    /**
     * Get readable stream
     */
    get readable() {
        return this.readableStream;
    }

    /**
     * Get writable stream
     */
    get writable() {
        return this.writableStream;
    }

    /**
     * Create ReadableStream and WritableStream
     * @private
     */
    _createStreams() {
        // ReadableStream for incoming data
        this.readableStream = new ReadableStream({
            start: async (controller) => {
                this._readLoopRunning = true;

                try {
                    while (this._readLoopRunning && this.device) {
                        try {
                            /* Request one max-packet worth; large sizes can stall on some Android stacks */
                            const result = await this.device.transferIn(this.endpointIn, this.maxTransferSize);

                            if (result.status === 'ok') {
                                controller.enqueue(new Uint8Array(result.data.buffer, result.data.byteOffset, result.data.byteLength));
                                continue;
                            } else if (result.status === 'stall') {
                                await this.device.clearHalt('in', this.endpointIn);
                                await new Promise(r => setTimeout(r, 1));
                                continue;
                            } else {
                                console.warn('USB transferIn returned status:', result.status);
                            }
                            /* No data or zero-length transfer: immediately loop */
                            await new Promise(r => setTimeout(r, 1));
                        } catch (error) {
                            if (error.message && (error.message.includes('device unavailable') ||
                                error.message.includes('device has been lost') ||
                                error.message.includes('device was disconnected') ||
                                error.message.includes('No device selected'))) {
                                break;
                            }
                            if (error.message && (error.message.includes('transfer was cancelled') ||
                                error.message.includes('transfer error has occurred'))) {
                                continue;
                            }
                            /* Log other errors but continue */
                            console.warn('USB read error:', error.message);
                        }
                    }
                } catch (error) {
                    controller.error(error);
                } finally {
                    controller.close();
                }
            },
            cancel: () => {
                console.log('[WebUSBSerial-flasher] Read loop canceled');
                this._readLoopRunning = false;
            }
        });

        // WritableStream for outgoing data
        this.writableStream = new WritableStream({
            write: async (chunk) => {
                if (!this.device) {
                    throw new Error('Device not open');
                }
                await this.device.transferOut(this.endpointOut, chunk);
            }
        });
    }

    /**
     * Cleanup resources
     * @private
     */
    _cleanup() {
        console.log('[WebUSBSerial-flasher] Cleanup called');
        this._readLoopRunning = false;
        if (this._usbDisconnectHandler) {
            navigator.usb.removeEventListener('disconnect', this._usbDisconnectHandler);
            this._usbDisconnectHandler = null;
            console.log('[WebUSBSerial-flasher] Disconnect handler unregistered');
        }
    }

    /**
     * Fire event to all registered listeners
     * @private
     */
    _fireEvent(type) {
        const listeners = this._eventListeners[type] || [];
        console.log(`[WebUSBSerial-flasher] Firing '${type}' event to ${listeners.length} listener(s)`);
        listeners.forEach(listener => {
            try {
                listener();
            } catch (e) {
                console.error(`Error in ${type} event listener:`, e);
            }
        });
    }

    /**
     * Add event listener (mimics addEventListener for 'close' and 'disconnect')
     * @param {string} type - Event type
     * @param {Function} listener - Event handler
     */
    addEventListener(type, listener) {
        if (this._eventListeners[type]) {
            this._eventListeners[type].push(listener);
            console.log(`[WebUSBSerial-flasher] addEventListener('${type}') - now have ${this._eventListeners[type].length} listener(s)`);
        } else {
            console.log(`[WebUSBSerial-flasher] addEventListener('${type}') - unknown event type`);
        }
    }

    /**
     * Remove event listener
     * @param {string} type - Event type
     * @param {Function} listener - Event handler
     */
    removeEventListener(type, listener) {
        if (this._eventListeners[type]) {
            const index = this._eventListeners[type].indexOf(listener);
            if (index !== -1) {
                this._eventListeners[type].splice(index, 1);
            }
        }
    }
}

/**
 * ESP32 Bootloader Communication Handler
 * Manages serial communication with ESP32 devices using bootloader protocol
 * Supports reading/writing flash, downloading code to RAM, and firmware verification
 * @class ESPFlasher
 */
class ESPFlasher {

    /**
     * Initialize ESP32 flasher instance
     * Creates new instance with default configuration and empty state
     */
    constructor(options = {}) {
        this.devMode = options.devMode || false;
        this.logDebug = options.logDebug || ((...args) => { });
        this.logError = options.logError || ((...args) => { });
        this.logWarning = options.logWarning || ((...args) => { });
        this.logMessage = options.logMessage || ((...args) => { });
        this.logPackets = options.logPackets || false;

        /*
        Technical Limitation:
            Web Serial cannot change the baud rate without reopening the port, which may reset the device.
            Therefore, this tool keeps a single baud rate from start to end.
            ESP32 ROM prints its reset messages at 115200 baud.
            
            When using a USB-UART adapter with RX/TX wiring:
            - Use 115200 to see ROM reset messages (slower link), or
            - Use a higher baud (e.g., 921600) for speed but you will not see reset messages.

            This does not apply to native USB/JTAG interfaces of course.

            Normal ESP32 needs 115200 or 250000 for any operation.
        */
        this.initialBaudRate = options.initialBaudRate || 921600;

        /* Flash read tuning */
        this.readFlashBlockSize = options.readFlashBlockSize || 0x1000;
        this.readFlashMaxInFlight = options.readFlashMaxInFlight || 32;

        this.chip_magic_addr = 0x40001000;
        this.chip_descriptions = new ChipDescriptionsClass().chip_descriptions;
        this.port = null;
        this.currentAddress = 0x0000;
        this.current_chip = "none";
        this.stubLoaded = false;
        this.responseHandlers = new Map();
        this.buffer = [];
        this.escaping = false;
        this.slipLayer = new SlipLayer();
        this.synced = false;
        this.consoleBuffer = '';
        this._preSyncState = 'idle';
        this.reader = null;
        this.dtrState = true;
        this.rtsState = true;

        /* Command execution lock to prevent concurrent command execution */
        this._commandLock = Promise.resolve();

        /* Persistent writer + queued writes to avoid WritableStream lock contention */
        this._activeWriter = null;
        this._writeChain = Promise.resolve();
    }

    /**
     * Ensure a single persistent WritableStreamDefaultWriter exists
     * @private
     */
    async _ensureWriter() {
        if (!this.port || !this.port.writable) {
            throw new Error('Port is not writable.');
        }
        if (!this._activeWriter) {
            this._activeWriter = this.port.writable.getWriter();
        }
        return this._activeWriter;
    }

    /**
     * Queue a write on the persistent writer to serialize all writes
     * @private
     */
    async _writeFrame(frame) {
        this._writeChain = this._writeChain.then(async () => {
            const writer = await this._ensureWriter();
            this.logSerialData(frame, true);
            await writer.write(frame);
        });
        return this._writeChain;
    }

    /**
     * Release the persistent writer if held
     * @private
     */
    _releaseWriter() {
        if (this._activeWriter) {
            try { this._activeWriter.releaseLock(); } catch (e) { }
            this._activeWriter = null;
        }
    }

    /**
     * Format bytes as colored hex dump for console
     * @param {Uint8Array} data - Data to format
     * @param {string} isTx - 'TX' or 'RX'
     * @param {number} maxBytes - Maximum bytes to show (default: 256)
     */
    logSerialData(data, isTx, maxBytes = 128) {
        if (!this.logPackets) return;

        const arrow = isTx ? '→' : '←';

        const truncated = data.length > maxBytes;

        // Format hex string with spaces every 2 bytes and newline every 16 bytes
        let hexStr = '';
        let asciiStr = '';
        let lines = [];

        const formatBytes = (startIdx, endIdx) => {
            for (let i = startIdx; i < endIdx; i++) {
                const byte = data[i];
                hexStr += byte.toString(16).padStart(2, '0').toUpperCase() + ' ';
                asciiStr += (byte >= 32 && byte <= 126) ? String.fromCharCode(byte) : '.';

                if ((i + 1) % 16 === 0 || i === endIdx - 1) {
                    // Pad hex string to align ASCII
                    const hexPadding = ' '.repeat(Math.max(0, (16 - (i % 16) - 1) * 3));
                    lines.push(`  ${hexStr}${hexPadding} | ${asciiStr}`);
                    hexStr = '';
                    asciiStr = '';
                }
            }
        };

        if (truncated) {
            formatBytes(0, 64);
            const lastSectionStart = Math.floor((data.length - 64) / 16) * 16;
            const skipped = lastSectionStart - 64;
            lines.push(`  ... (${skipped} bytes omitted) ...`);
            formatBytes(lastSectionStart, data.length);
        } else {
            formatBytes(0, data.length);
        }

        const truncMsg = truncated ? ` (showing partially)` : '';
        this.logDebug(`${arrow} RAW [${data.length} bytes]${truncMsg}`, {lines: lines});
    }

    /**
     * Open serial port and start reading packets
     * @async
     * @returns {Promise<void>}
     * @throws {Error} If port request fails
     */
    async openPort() {
        /* Require Web Serial API (available in Chrome/Edge) */
        if (typeof navigator === 'undefined' || !navigator.serial) {
            throw new Error('Web Serial API not available. Please use Chrome or Edge.');
        }

        const port = await navigator.serial.requestPort();
        return this.openPortWithPort(port);
    }

    /**
     * Open a provided serial port (Web Serial or WebUSB)
     * @async
     * @param {SerialPort|WebUSBSerial} port - Port instance to open
     * @returns {Promise<void>}
     * @throws {Error} If connection fails
     */
    async openPortWithPort(port) {
        return new Promise(async (resolve, reject) => {

            /* Open the port */
            try {
                this.port = port;

                /* If WebUSBSerial, provide logger callbacks so low-level dumps reach UI log */
                if (this.port instanceof WebUSBSerial) {
                    this.port.logger = {
                        info: (msg) => { this.logDebug && this.logDebug(msg); },
                        error: (msg) => { this.logError && this.logError(msg); }
                    };
                }

                await this.port.open({ baudRate: this.initialBaudRate });

                /* Get and log VID/PID information */
                const portInfo = this.port.getInfo();
                if (portInfo.usbVendorId !== undefined && portInfo.usbProductId !== undefined) {
                    const vid = portInfo.usbVendorId;
                    const pid = portInfo.usbProductId;
                    this.logDebug(`Device: VID=0x${vid.toString(16).padStart(4, '0').toUpperCase()}, PID=0x${pid.toString(16).padStart(4, '0').toUpperCase()}`);

                    /* Check for Espressif USB JTAG device */
                    if (vid === 0x303A) {
                        this.logDebug('Detected Espressif USB JTAG device - high baud rates supported, bootloader messages will be visible');
                        this.isEspressifUsbJtag = true;
                    } else {
                        this.isEspressifUsbJtag = false;
                    }
                } else {
                    this.logDebug('Device: VID/PID information not available (may not be a USB device)');
                    this.isEspressifUsbJtag = false;
                }
            } catch (error) {
                reject(error);
                return;
            }


            // Register for device lost (Web Serial API)
            if (navigator.serial) {
                navigator.serial.addEventListener('disconnect', (event) => {
                    if (event.target === this.port) {
                        this.logError(`The device was disconnected`);
                        this.disconnect();
                    }
                });
            }

            // Register for port closing
            if (this.port.addEventListener) {
                this.port.addEventListener('close', () => {
                    if (!this._disconnecting) {
                        this.logError('Device disconnected unexpectedly');
                    }
                });
            }

            resolve();

            /* Set up reading from the port */
            this.reader = this.port.readable.getReader();

            this.startRxLoop();
        });
    }

    async startRxLoop() {
        try {
            while (true) {
                if (typeof performance !== 'undefined' && performance.mark && performance.measure) {
                    performance.mark('esp32_flasher_receive_start');
                }
                const { value, done } = await this.reader.read();
                if (typeof performance !== 'undefined' && performance.mark && performance.measure) {
                    performance.mark('esp32_flasher_receive_end');
                    try {
                        performance.measure('esp32_flasher_receive', 'esp32_flasher_receive_start', 'esp32_flasher_receive_end');
                    } catch (measureErr) {
                    }
                }
                if (done) {
                    this.logDebug('Reader has been canceled');
                    break;
                }
                if (value) {
                    this.logSerialData(value, false);
                    this.parseResetMessages(value);
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
    }

    /**
     * Reopen the existing serial port with a new baud rate
     * Closes the current reader and port, then opens the same port at `baudRate`
     * and restarts the RX loop without re-requesting the device.
     * @async
     * @param {number} baudRate - New baud rate to use
     * @returns {Promise<void>}
     * @throws {Error} If port is not selected/openable
     */
    async reopenPort(baudRate) {
        if (!this.port) {
            throw new Error('No port selected. Call openPort() first to choose a device.');
        }

        /* Stop existing reader if any */
        if (this.reader) {
            try {
                await this.reader.cancel();
            } catch (error) {
                /* Ignore cancellation errors */
            }
            try {
                this.reader.releaseLock();
            } catch (e) {
                /* Ignore release errors */
            }
            this.reader = null;
        }

        /* Wait for pending writes and release writer before closing */
        try {
            await this._writeChain;
        } catch (e) { /* Ignore pending write errors on reopen */ }
        this._releaseWriter();

        /* Close and reopen the same port with new baud */
        try {
            await this.port.close();
        } catch (error) {
            /* Ignore close errors, we will try to open regardless */
        }

        const newBaud = baudRate || this.initialBaudRate;
        await this.port.open({ baudRate: newBaud });

        /* Restart RX loop (do not re-register global listeners to avoid duplicates) */
        this.reader = this.port.readable.getReader();

        this.startRxLoop();
    }

    parseResetMessages(data) {
        /*
        ESP32
            ets Jun  8 2016 00:22:57

            rst:0x1 (POWERON_RESET),boot:0x1 (DOWNLOAD_BOOT(UART0/UART1/SDIO_FEI_REO_V2))
            waiting for download
           
        ESP32-S3 (normal)     
            ESP-ROM:esp32s3-20210327
            Build:Mar 27 2021
            rst:0x1 (POWERON),boot:0x0 (DOWNLOAD(USB/UART0))
            waiting for download

        ESP32-C3 (secure)
            ESP-ROM:esp32c3-api1-20210207
            Build:Feb  7 2021
            rst:0x15 (USB_UART_CHIP_RESET),boot:0x5 (DOWNLOAD(USB/UART0/1))
            Saved PC:0x4004d1f8
            wait uart download(secure mode)

        ESP32-C3 (normal)
            ESP-ROM:esp32c3-api1-20210207
            Build:Feb  7 2021
            rst:0x15 (USB_UART_CHIP_RESET),boot:0x7 (DOWNLOAD(USB/UART0/1))
            Saved PC:0x4004c0d4
            waiting for download

        */


        /* Only care about pre-sync console chatter */
        if (!data || !data.length) {
            return;
        }

        /* Accumulate printable ASCII and newlines */
        let chunk = '';
        for (let i = 0; i < data.length; i++) {
            const b = data[i];
            if (b === 10 || b === 13) {
                chunk += '\n';
            } else if (b >= 32 && b <= 126) {
                chunk += String.fromCharCode(b);
            }
        }

        if (!chunk.length) {
            return;
        }

        this.consoleBuffer = (this.consoleBuffer || '') + chunk;

        let newlineIdx = this.consoleBuffer.indexOf('\n');
        while (newlineIdx !== -1) {
            const line = this.consoleBuffer.slice(0, newlineIdx).trim();
            this.consoleBuffer = this.consoleBuffer.slice(newlineIdx + 1);
            if (line.length) {
                // Only print device messages if not yet synced
                if (!this.synced) {
                    this.logDebug(`[Device] ${line}`);
                }

                const lower = line.toLowerCase();
                const rstBootMatch = line.match(/rst:0x([0-9a-f]+)/i);
                const bootMatch = line.match(/boot:0x([0-9a-f]+)/i);

                if (rstBootMatch && bootMatch) {
                    const rst = parseInt(rstBootMatch[1], 16);
                    const boot = parseInt(bootMatch[1], 16);
                    const rstInfo = RESET_REASON_MAP[rst] || { name: 'UNKNOWN', desc: `Unknown reset reason 0x${rst.toString(16)}` };
                    this.deviceStateCallback && this.deviceStateCallback('reboot', { rst, rstName: rstInfo.name, rstDesc: rstInfo.desc, boot });
                    /* Enable mode detection after reboot line */
                    this._preSyncState = 'seen_reboot';
                }

                /* State machine: after reboot line, accept one mode line */
                if (this._preSyncState === 'seen_reboot') {
                    if (lower.includes('(secure mode)')) {
                        this.deviceStateCallback && this.deviceStateCallback('secure');
                        this._preSyncState = 'idle';
                    } else if (lower.includes('waiting for download') || lower.includes('wait uart download')) {
                        this.deviceStateCallback && this.deviceStateCallback('download');
                        this._preSyncState = 'idle';
                    }
                }

            }
            newlineIdx = this.consoleBuffer.indexOf('\n');
        }
    }

    /**
     * Read 32-bit value from chip register
     * @async
     * @param {number} addr - Register address
     * @returns {Promise<number>} Register value
     */
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


    /**
     * Detect if stub loader is running on device
     * @async
     * @returns {Promise<boolean>} True if stub loader active, false if ROM bootloader
     * @throws {Error} If detection fails
     * @description Distinguishes stub loader from ROM bootloader by magic address response size
     */
    async isStubLoader() {
        if (this.current_chip === 'esp8266') {
            return this.stubLoaded;
        }

        this.stubLoaded = this.executeCommand(this.buildCommandPacketU32(READ_REG, this.chip_magic_addr),
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

        return this.stubLoaded;
    }

    /**
     * Execute command on device
     * @async
     * @param {Object} packet - Command packet from buildCommandPacket
     * @param {Function} packetResponseCbr - Response handler(resolve, reject, responsePacket)
     * @param {Function} [rawDataCbr] - Raw data handler
     * @param {number} [timeout=500] - Timeout in milliseconds
     * @param {Function} [checkTimeoutCbr] - Optional timeout check returning boolean
     * @returns {Promise<*>} Result from callback
     * @throws {Error} On timeout or command failure
     */
    async executeCommand(packet, packetResponseCbr, rawDataCbr, timeout = 500, checkTimeoutCbr = null) {
        /*
         Serialize command execution properly:
         - Do NOT create the command promise before acquiring the logical lock.
           Creating it early can start the async work and contend for the writable stream.
         - Instead, chain the creation to the existing lock so only one writer is active.
        */
        const run = () => this._executeCommandUnlocked(packet, packetResponseCbr, rawDataCbr, timeout, checkTimeoutCbr);
        this._commandLock = this._commandLock.then(run, run);
        return this._commandLock;
    }

    /**
     * Internal command execution (unlocked)
     * @async
     * @private
     */
    async _executeCommandUnlocked(packet, packetResponseCbr, rawDataCbr, timeout = 500, checkTimeoutCbr = null) {
        if (!this.port || !this.port.writable) {
            throw new Error("Port is not writable.");
        }

        if (this.devMode) {
            this.dumpPacket(this.parsePacket(packet.payload));
        }

        return new Promise(async (resolve, reject) => {
            /* Set timeout handler */
            let timeoutHandle = null;

            const scheduleTimeout = () => {
                timeoutHandle = setTimeout(() => {
                    if (checkTimeoutCbr) {
                        if (checkTimeoutCbr()) {
                            safeReject(new Error(`Timeout in command ${packet.command}`));
                        } else {
                            scheduleTimeout();
                        }
                    } else {
                        safeReject(new Error(`Timeout after ${timeout} ms waiting for response to command ${packet.command}`));
                    }
                }, timeout);
            };

            const safeResolve = (value) => { clearTimeout(timeoutHandle); return resolve(value); };
            const safeReject = (err) => { clearTimeout(timeoutHandle); return reject(err); };


            /* Register response handlers */
            this.responseHandlers.clear();

            /* decide which callbacks to register */
            if (rawDataCbr) {
                /* this command seems to have have normal response then raw data */
                this.responseHandlers.set(packet.command, async (response) => {
                    if (packetResponseCbr) {
                        return packetResponseCbr(safeResolve, safeReject, response);
                    }
                });
                this.responseHandlers.set(-1, async (response) => {
                    return rawDataCbr(safeResolve, safeReject, response);
                });
            } else {
                /* only normal response */
                this.responseHandlers.set(packet.command, async (response) => {
                    if (packetResponseCbr) {
                        return packetResponseCbr(safeResolve, safeReject, response);
                    }
                });
            }

            /* Send the packet with proper error handling */
            try {
                scheduleTimeout();
                if (typeof performance !== 'undefined' && performance.mark) {
                    performance.mark('esp32_flasher_send_start');
                }

                await this._writeFrame(this.slipLayer.encode(packet.payload));

                if (typeof performance !== 'undefined' && performance.mark && performance.measure) {
                    performance.mark('esp32_flasher_send_end');
                    try {
                        performance.measure('esp32_flasher_send', 'esp32_flasher_send_start', 'esp32_flasher_send_end');
                        performance.measure('esp32_flasher_latency', 'esp32_flasher_receive_end', 'esp32_flasher_send_start');
                        /* measured ~50-100us latency on USB-JTAG for register read flooding */
                    } catch (measureErr) {
                    }
                }
            } catch (error) {
                clearTimeout(timeoutHandle);
                reject(error);
            }
        });
    }

    /**
     * Disconnect from serial port
     * @async
     * @returns {Promise<void>}
     */
    async disconnect() {
        if (this._disconnecting) {
            return;
        }
        this._disconnecting = true;

        navigator.serial.removeEventListener('disconnect', this.disconnect);

        if (this.reader) {
            try {
                await this.reader.cancel();
            } catch (error) {
                this.logError('Error cancelling reader:', error);
            }
        }

        /* Release persistent writer before closing port */
        this._releaseWriter();

        if (this.port) {
            try {
                this.port.removeEventListener('close', this.disconnect);
                await this.port.close();
            } catch (error) {
                //this.logError('Error during disconnect:', error);
            }
            this.port = null;
        }

        this.synced = false;
        this.consoleBuffer = '';
        this._preSyncState = 'idle';
        this._disconnecting = false;

        this.disconnected && this.disconnected();
    }

    async setDtr(value) {
        try {
            this.dtrState = value;
            await this.port.setSignals({
                dataTerminalReady: value,
                requestToSend: this.rtsState,
            });
            return true;
        } catch (error) {
            console.error(`Could not set DTR: ${error}.`);
            return false;
        }
    }

    async setRts(value) {
        try {
            this.rtsState = value;
            await this.port.setSignals({
                dataTerminalReady: this.dtrState,
                requestToSend: value,
            });
            return true;
        } catch (error) {
            console.error(`Could not set RTS: ${error}.`);
            return false;
        }
    }

    async setDtrRts(dtr, rts) {
        if (!this.port) {
            this.logError("Port is not open. Cannot set signals.");
            return false;
        }

        this.dtrState = dtr;
        this.rtsState = rts;

        try {
            await this.port.setSignals({
                dataTerminalReady: dtr,
                requestToSend: rts,
            });
            return true;
        } catch (error) {
            this.logError(`Could not set signals: ${error}.`);
            return false;
        }
    }

    async setSignals(signals) {
        if (!this.port) {
            this.logError("Port is not open. Cannot set signals.");
            return false;
        }

        if (signals.dataTerminalReady !== undefined) {
            this.dtrState = signals.dataTerminalReady;
        }
        if (signals.requestToSend !== undefined) {
            this.rtsState = signals.requestToSend;
        }

        try {
            await this.setDtr(this.dtrState);
            await this.setRts(this.rtsState);
            return true;
        } catch (error) {
            this.logError(`Could not set signals: ${error}.`);
            return false;
        }
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

        this.synced = false;
        this.consoleBuffer = '';
        this._preSyncState = 'idle';

        this.logDebug("Automatic bootloader reset sequence...");

        try {

            if (this.isEspressifUsbJtag) {
                /* Native USB/JTAG interface - use the method described in ESP32-S3 Table 33.4-3. Reset SoC into Download Mode.
                   This procedure assumes the Windows CDC driver toggles DRT only when RTS is set explicitly. */

                /* set to known state first, but causes an extra reset usually */
                await this.setDtr(false);
                await this.setRts(false);

                if (bootloader) {
                    await this.setDtr(true);
                    await this.setRts(false);
                    await this.setRts(true);
                    await this.setDtr(false);
                }

                await this.setRts(false);
                await this.setRts(true);
            } else {
                /* high/low vs. asserted/deasserted logic is a bit pain here:
                   EN pin (RTS) - active low - to reset, pull low (EN high means RTS=false)
                   IO0 pin (DTR) - active low - to enter bootloader, pull low (IO0 high means DTR=false)
                */
                const setPins = async ({ io0PinHigh, enPinHigh }) => {
                    const io0Level = io0PinHigh ? false : true;
                    const enLevel = enPinHigh ? false : true;
                    await this.setSignals({ requestToSend: enLevel, dataTerminalReady: io0Level });
                };

                await setPins({ io0PinHigh: true, enPinHigh: true });
                await setPins({ io0PinHigh: false, enPinHigh: false });
                await setPins({ io0PinHigh: true, enPinHigh: false });
                await new Promise(r => setTimeout(r, 50));
                await setPins({ io0PinHigh: bootloader ? false : true, enPinHigh: true });
                await new Promise(r => setTimeout(r, 100));
                await setPins({ io0PinHigh: true, enPinHigh: true });
            }

            return true;
        } catch (error) {
            this.logError(`Could not set signals for automatic reset: ${error}. Please ensure device is in bootloader mode manually.`);
            return false;
        }
    }


    /**
     * Convert base64-encoded string to binary data
     * @param {string} base64 - Base64-encoded data string
     * @returns {Uint8Array} Decoded binary data
     * @description Decodes base64 string using native atob and converts to Uint8Array
     */
    base64ToByteArray(base64) {
        const binaryString = atob(base64);
        const byteArray = new Uint8Array(binaryString.length);
        for (let index = 0; index < binaryString.length; index++) {
            byteArray[index] = binaryString.charCodeAt(index);
        }
        return byteArray;
    }

    /**
     * Download binary payload to device RAM
     * @async
     * @param {number} address - Target RAM address
     * @param {string} payload - Base64-encoded binary data
     * @returns {Promise<void>}
     * @throws {Error} If download fails
     * @description Used for downloading stub loader and other code to RAM
     */
    async downloadMem(address, payload) {
        var binary = this.base64ToByteArray(payload);
        const MAX_PACKET_SIZE = 0x1800; // as limited in https://github.com/espressif/esptool/blob/master/esptool/loader.py#L265 
        const packets = Math.ceil(binary.length / MAX_PACKET_SIZE);

        await this.executeCommand(this.buildCommandPacketU32(MEM_BEGIN, binary.length, packets, MAX_PACKET_SIZE, address),
            async (resolve, reject, responsePacket) => {
                resolve();
            }, null, 1000);

        /* Send data in chunks */
        for (let seq = 0; seq < packets; seq++) {
            const offset = seq * MAX_PACKET_SIZE;
            const chunk = binary.slice(offset, offset + MAX_PACKET_SIZE);

            await this.executeCommand(this.buildCommandPacketU32(MEM_DATA, chunk.length, seq, 0, 0, chunk),
                async (resolve, reject, responsePacket) => {
                    resolve();
                }, null, 1000);
        }
    }

    /**
     * Synchronize with bootloader and detect chip type
     * @async
     * @returns {Promise<void>}
     * @throws {Error} If synchronization fails after all retries
     * @description Performs SYNC command with retry logic, then reads chip magic value
     *              to detect connected chip type (ESP32, ESP32-S3, etc.)
     */
    async sync() {
        const maxRetries = 4;
        const retryDelayMs = 100; /* Delay between retries (Android stacks can be slower) */
        const syncTimeoutMs = 300; /* Timeout for each individual sync attempt */
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

        this.synced = true;

        // Read security information
        try {
            this.logDebug("Reading security information...");
            this.securityInfo = await this.getSecurityInfo();
            this.current_chip = CHIP_ID_MAP[this.securityInfo.chip_id_hex >>> 0] || "unknown";

            this.logDebug(`Security Info: Flags=${this.securityInfo.flags_hex}, Flash Crypt=${this.securityInfo.flash_crypt_cnt}, Chip ID=${this.securityInfo.chip_id_hex} (${this.current_chip}), ECO=${this.securityInfo.eco_version_hex}`);

            /* Log enabled security features */
            const enabledFlags = Object.entries(this.securityInfo.flags_decoded)
                .filter(([key, value]) => value)
                .map(([key, _]) => key);
            if (enabledFlags.length > 0) {
                this.logDebug(`  Enabled security features: ${enabledFlags.join(', ')}`);
            } else {
                this.logDebug(`  No security features enabled`);
            }

            if (this.securityInfo.flags_decoded.SECURE_BOOT_EN) {
                if (!this.securityInfo.flags_decoded.SECURE_DOWNLOAD_ENABLE) {
                    this.deviceStateCallback && this.deviceStateCallback('secure_boot');
                } else {
                    this.deviceStateCallback && this.deviceStateCallback('secure_download');
                }
            }

            /* if this command succeeded, we already have the chip type, so we can just return. only plain ESP32 doesn't have the security info command */
            return;
        } catch (error) {
            this.logDebug(`Failed to read security info: ${error.message}, maybe plain ESP32? Continuing to old chip detection...`);
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
        }
    }

    /**
     * Read device MAC address from eFuses
     * @async
     * @returns {Promise<string>} MAC address as colon-separated hex string (e.g., "aa:bb:cc:dd:ee:ff")
     * @throws {Error} If register read fails
     * @description Reads MAC address from chip-specific eFuse registers
     */
    async readMac() {
        /* Read the MAC address registers */
        var chip = this.chip_descriptions[this.current_chip];
        if (!chip.mac_efuse_reg) {
            throw new Error(`MAC eFuse register not defined for chip ${this.current_chip}`);
        }
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

    /**
     * Read chip security information
     * @async
     * @returns {Promise<Object>} Security info object with flags, flash_crypt_cnt, key_purposes, chip_id, eco_version
     * @throws {Error} If read fails
     * @description Reads chip security configuration including encryption status and key purposes
     */
    async getSecurityInfo() {
        return this.executeCommand(
            this.buildCommandPacketU32(GET_SECURITY_INFO, 0),
            async (resolve, reject, responsePacket) => {
                if (responsePacket && responsePacket.data && responsePacket.data.length >= 20) {
                    const data = responsePacket.data;

                    /* Parse 32-bit flags (little-endian) */
                    const flags = (data[0] | (data[1] << 8) | (data[2] << 16) | (data[3] << 24)) >>> 0;

                    /* Decode security flags */
                    const decodedFlags = {
                        SECURE_BOOT_EN: !!(flags & (1 << 0)),
                        SECURE_BOOT_AGGRESSIVE_REVOKE: !!(flags & (1 << 1)),
                        SECURE_DOWNLOAD_ENABLE: !!(flags & (1 << 2)),
                        SECURE_BOOT_KEY_REVOKE0: !!(flags & (1 << 3)),
                        SECURE_BOOT_KEY_REVOKE1: !!(flags & (1 << 4)),
                        SECURE_BOOT_KEY_REVOKE2: !!(flags & (1 << 5)),
                        SOFT_DIS_JTAG: !!(flags & (1 << 6)),
                        HARD_DIS_JTAG: !!(flags & (1 << 7)),
                        DIS_USB: !!(flags & (1 << 8)),
                        DIS_DOWNLOAD_DCACHE: !!(flags & (1 << 9)),
                        DIS_DOWNLOAD_ICACHE: !!(flags & (1 << 10))
                    };

                    /* Parse 1 byte flash_crypt_cnt */
                    const flash_crypt_cnt = data[4];

                    /* Parse 7 bytes key_purposes */
                    const key_purposes = Array.from(data.slice(5, 12));

                    /* Parse 32-bit chip_id (little-endian) */
                    const chip_id = (data[12] | (data[13] << 8) | (data[14] << 16) | (data[15] << 24)) >>> 0;

                    /* Parse 32-bit eco_version (little-endian) */
                    const eco_version = (data[16] | (data[17] << 8) | (data[18] << 16) | (data[19] << 24)) >>> 0;

                    const securityInfo = {
                        flags: flags,
                        flags_hex: '0x' + flags.toString(16).toUpperCase().padStart(8, '0'),
                        flags_decoded: decodedFlags,
                        flash_crypt_cnt: flash_crypt_cnt,
                        key_purposes: key_purposes,
                        chip_id: chip_id,
                        chip_id_hex: '0x' + chip_id.toString(16).toUpperCase().padStart(8, '0'),
                        eco_version: eco_version,
                        eco_version_hex: '0x' + eco_version.toString(16).toUpperCase().padStart(8, '0')
                    };

                    resolve(securityInfo);
                } else {
                    reject('Invalid security info response');
                }
            },
            null,
            100
        );
    }

    /**
     * Test serial communication reliability
     * @async
     * @param {Function} [cbr] - Progress callback(percentComplete)
     * @returns {Promise<boolean>} True if test passed, false if failed
     * @description Performs 1-second stress test reading the same register repeatedly,
     *              verifying all reads return identical values
     */
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
            this.logMessage(`Average read time: ${averageTime.toFixed(2)} ms over ${totalReads} reads.`);
        }

        return true;
    }

    /**
     * Download and execute stub loader on device
     * @async
     * @returns {Promise<boolean>} True if stub loaded successfully, false otherwise
     * @throws {Error} If stub loading or initialization fails
     * @description Downloads stub firmware to RAM and executes it.
     *              Stub provides additional capabilities like flash read/write and MD5.
     */
    async downloadStub() {
        var stub = this.chip_descriptions[this.current_chip].stub

        if (stub.data_start != undefined && stub.data != undefined) {
            await this.downloadMem(stub.data_start, stub.data);
        }
        await this.downloadMem(stub.text_start, stub.text);

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
            this.logDebug(error);
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

        this.stubLoaded = true;
        return true;
    }

    /**
     * Write data to flash memory
     * @async
     * @param {number} address - Target flash address
     * @param {Uint8Array} data - Binary data to write
     * @param {Function} [progressCallback] - Callback(bytesWritten, totalBytes)
     * @returns {Promise<void>}
     * @throws {Error} If write fails
     */
    async writeFlashPlain(address, data, progressCallback) {
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

            progressCallback && progressCallback(offset + chunk.length, data.length);
        }
    }

    /**
     * Read data from flash memory
     * @async
     * @param {number} address - Source flash address
     * @param {number} [totalLength=0x1000] - Number of bytes to read
     * @param {Function} [progressCallback] - Callback(bytesRead, totalBytes)
     * @returns {Promise<Uint8Array>} Read data (MD5 verified)
     * @throws {Error} If read fails or MD5 mismatch
     * 

       ESP32-C3
        [01:04:10] [DEBUG] ReadFlash timing: 262144 bytes in 22772ms
        [01:04:10] [DEBUG]   Data rate: 0.01 MB/s (11512 B/s)
        [01:04:10] [DEBUG]   Packet latency: min=348ms, max=358ms, avg=355.8ms
        [01:04:10] [DEBUG]   Packets received: 64

       ESP32-C6
        [01:05:00] [DEBUG] ReadFlash timing: 262144 bytes in 841ms
        [01:05:00] [DEBUG]   Data rate: 0.30 MB/s (311705 B/s)
        [01:05:00] [DEBUG]   Packet latency: min=13ms, max=14ms, avg=13.1ms
        [01:05:00] [DEBUG]   Packets received: 64

       ESP32-S3
        [01:06:29] [DEBUG] ReadFlash timing: 262144 bytes in 22762ms
        [01:06:29] [DEBUG]   Data rate: 0.01 MB/s (11517 B/s)
        [01:06:29] [DEBUG]   Packet latency: min=350ms, max=356ms, avg=355.6ms
        [01:06:29] [DEBUG]   Packets received: 64

     */
    async readFlashPlain(address, totalLength = 0x1000, cbr) {
        let blockSize = Math.min(totalLength, this.readFlashBlockSize);
        let maxInFlight = Math.min(totalLength, blockSize * this.readFlashMaxInFlight);
        const packetCount = Math.ceil(totalLength / blockSize);

        let packet = 0;
        let lastAckedLength = 0;
        var data = new Uint8Array(0);
        var lastDataTime = Date.now();

        /* Timing measurements */
        const readStartTime = Date.now();
        let packetLatencies = [];
        let lastPacketTime = readStartTime;
        let totalBytesReceived = 0;

        if (this.devMode) {
            this.logDebug(`[ReadFlashPlain] Starting ReadFlash:`, { address: `0x${address.toString(16)}`, length: `0x${totalLength.toString(16)}`, blockSize: `0x${blockSize.toString(16)}`, packets: packetCount, maxInFlight: `0x${maxInFlight.toString(16)}` });
        }

        return this.executeCommand(
            this.buildCommandPacketU32(READ_FLASH, address, totalLength, blockSize, maxInFlight),
            async () => {
                packet = 0;
            },
            async (resolve, reject, rawData) => {
                const currentTime = Date.now();
                lastDataTime = currentTime;

                if (data.length == totalLength) {
                    if (rawData.length == 16) {
                        /* Calculate MD5 of received data */
                        const calculatedMD5 = this.calculateMD5(data);

                        /* Convert received MD5 bytes to hex string */
                        const receivedMD5 = Array.from(rawData)
                            .map(b => b.toString(16).padStart(2, '0'))
                            .join('');

                        /* Compare MD5 hashes */
                        if (calculatedMD5.toLowerCase() === receivedMD5.toLowerCase()) {
                            /* Calculate and log timing statistics */
                            const totalTime = currentTime - readStartTime;
                            const dataRate = totalBytesReceived / (totalTime / 1000);
                            const avgLatency = packetLatencies.length > 0
                                ? packetLatencies.reduce((a, b) => a + b, 0) / packetLatencies.length
                                : 0;
                            const minLatency = packetLatencies.length > 0
                                ? Math.min(...packetLatencies)
                                : 0;
                            const maxLatency = packetLatencies.length > 0
                                ? Math.max(...packetLatencies)
                                : 0;

                            if (this.devMode) {
                                this.logDebug(`ReadFlash timing: ${totalBytesReceived} bytes in ${totalTime}ms`);
                                this.logDebug(`  Data rate: ${(dataRate / 1024 / 1024).toFixed(2)} MB/s (${dataRate.toFixed(0)} B/s)`);
                                this.logDebug(`  Packet latency: min=${minLatency}ms, max=${maxLatency}ms, avg=${avgLatency.toFixed(1)}ms`);
                                this.logDebug(`  Packets received: ${packetLatencies.length}`);
                            }

                            resolve(data);
                        } else {
                            const error = `MD5 mismatch! Expected: ${receivedMD5}, Got: ${calculatedMD5}`;
                            this.logError(error);
                            reject(new Error(error));
                        }
                    } else {
                        const error = `Unknown response length for MD5! Expected: 16, Got: ${rawData.length}`;
                        this.logError(error);
                        reject(new Error(error));
                    }
                } else {
                    /* Track packet latency */
                    const packetLatency = currentTime - lastPacketTime;
                    packetLatencies.push(packetLatency);
                    lastPacketTime = currentTime;
                    totalBytesReceived += rawData.length;

                    /* Append rawData to accumulated data */
                    const newData = new Uint8Array(data.length + rawData.length);
                    newData.set(data);
                    newData.set(rawData, data.length);
                    data = newData;
                    packet++;

                    if (this.devMode) {
                        this.logDebug(`[ReadFlashPlain] Received packet ${packet}/${packetCount}, total bytes: ${data.length}/${totalLength}`);
                    }

                    /* Prepare response */
                    if (data.length >= (lastAckedLength + maxInFlight) || (data.length >= totalLength)) {

                        if (this.devMode) {
                            this.logDebug(`[ReadFlashPlain] Sending ACK for ${data.length} bytes (lastAckedLength=${lastAckedLength})`);
                        }
                        /* Encode and write response */
                        var resp = new Uint8Array(4);
                        resp[0] = (data.length >> 0) & 0xFF;
                        resp[1] = (data.length >> 8) & 0xFF;
                        resp[2] = (data.length >> 16) & 0xFF;
                        resp[3] = (data.length >> 24) & 0xFF;

                        await this._writeFrame(this.slipLayer.encode(resp));

                        /* move last acked length further */
                        lastAckedLength = Math.min(lastAckedLength + maxInFlight, totalLength);
                    }

                    /* Call progress callback */
                    if (cbr) {
                        cbr(data.length, totalLength);
                    }
                }
            },
            500,
            /* Timeout condition: if the last raw data callback was more than a second ago */
            () => {
                const timeSinceLastData = Date.now() - lastDataTime;
                const hasTimedOut = timeSinceLastData > 1000;
                if (hasTimedOut) {
                    this.logError(`[ReadFlashPlain] TIMEOUT CHECK: timeSinceLastData=${timeSinceLastData}ms, triggering timeout`);
                }
                return hasTimedOut;
            }
        );
    }

    /**
     * Calculate MD5 checksum of flash region
     * @async
     * @param {number} address - Start address
     * @param {number} length - Number of bytes
     * @returns {Promise<string>} MD5 hash (hex)
     * @throws {Error} If checksum fails
     */
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
            1000 + length / 500 // Timeout based on length
        );
    }

    /**
     * Calculate local MD5 hash
     * @param {Uint8Array|string} data - Data to hash
     * @returns {string} MD5 hash (hex)
     */
    calculateMD5(data) {
        /* Create MD5 hash using the Md5 class */
        const md5 = new this.Md5();
        md5.update(data);
        return md5.hex();
    }

    /**
     * Read flash with comprehensive MD5 verification
     * @async
     * @param {number} address - Source address
     * @param {number} size - Number of bytes
     * @param {Function} [progressCallback] - Callback(read, total, stage)
     * @returns {Promise<Uint8Array>} Verified data
     * @throws {Error} If read/verification fails
     */
    async readFlash(address, size, progressCallback) {
        var blockSize = 64 * 0x1000;

        if (this.port instanceof WebUSBSerial) {
            blockSize = (this.port.maxTransferSize - 2) / 2; /* remove 2 bytes for SLIP overhead, divide by 2 because 0xC0 gets potentially escaped */
        }

        try {
            /* Step 1: Read data in blocks */
            this.logDebug(`ReadFlashSafe: Reading ${size} bytes in ${blockSize}-byte blocks...`);
            const allData = new Uint8Array(size);
            let offset = 0;

            while (offset < size) {
                const readSize = Math.min(blockSize, size - offset);
                let cbr = (read, readBlockSize) => {
                    progressCallback && progressCallback(offset + read, size, 'reading');
                }
                const blockData = await this.readFlashPlain(address + offset, readSize, cbr);

                /* Copy block to buffer */
                allData.set(blockData.slice(0, readSize), offset);
                offset += readSize;

                /* Call progress callback */
                progressCallback && progressCallback(offset, size, 'reading');

                if (this.devMode) {
                    this.logDebug(`ReadFlashSafe: Read ${offset}/${size} bytes (${Math.round((offset / size) * 100)}%)`);
                }
            }

            /* Step 2: Calculate MD5 of read data */
            progressCallback && progressCallback(size, size, 'calc MD5 of input');
            this.logDebug(`ReadFlashSafe: Calculating MD5 of read data...`);
            const actualMD5 = await this.calculateMD5(allData);
            this.logDebug(`Actual MD5: ${actualMD5}`);

            /* Step 3: Get expected MD5 from flash */
            progressCallback && progressCallback(size, size, 'calc MD5 onchip');

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

    /**
     * Write flash with MD5 verification
     * @async
     * @param {number} address - Target address
     * @param {Uint8Array} data - Data to write
     * @param {Function} [progressCbr] - Callback(written, total, stage)
     * @returns {Promise<Object>} {success: boolean, md5: string}
     * @throws {Error} If write/verification fails
     */
    async writeFlash(address, data, progressCbr) {
        try {
            /* Step 1: Write data to flash */
            this.logDebug(`WriteFlashSafe: Writing ${data.length} bytes to 0x${address.toString(16).padStart(8, '0')}...`);
            await this.writeFlashPlain(address, data, (offset, total) => {
                progressCbr && progressCbr(offset, total, 'Writing');
            });
            this.logDebug(`WriteFlashSafe: Write complete`);

            /* Step 2: Calculate MD5 of input data */
            progressCbr && progressCbr(data.length, data.length, 'Calculating MD5 of input');
            this.logDebug(`WriteFlashSafe: Calculating MD5 of ${data.length} bytes to write...`);
            const expectedMD5 = this.calculateMD5(data);
            this.logDebug(`Input data MD5: ${expectedMD5}`);

            /* Step 3: Get MD5 from device */
            progressCbr && progressCbr(data.length, data.length, 'Calculating MD5 on device');
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

            progressCbr && progressCbr(data.length, data.length, expectedMD5, 'Verified');

            return { success: true, md5: expectedMD5 };

        } catch (error) {
            this.logError(`WriteFlashSafe failed: ${error.message}`);
            throw error;
        }
    }

    /**
     * Check if flash memory is erased
     * @async
     * @param {Function} [cbr] - Progress callback
     * @returns {Promise<void>}
     */
    async blankCheck(startAddress = 0x000000, endAddress = 0x800000, cbr = null) {
        const blockSize = 0x1000;

        let totalReads = 0;
        let totalTime = 0;
        let erasedBytesTotal = 0;
        let currentAddress = startAddress;

        while (currentAddress < endAddress) {

            try {
                const startTime = Date.now();
                var rawData = await this.readFlashPlain(currentAddress, blockSize);
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

    /**
     * Write/Read stress test
     * @async
     * @param {number} address - Test address
     * @param {number} size - Test data size
     * @param {Function} [cbr] - Progress callback
     * @returns {Promise<Object>} Test result
     * @throws {Error} On critical failure
     */
    async writeReadTest(address, size, cbr) {
        try {
            /* Step 1: Read original data */
            this.logDebug(`Test: Reading original ${size} bytes from 0x${address.toString(16).padStart(8, '0')}...`);
            cbr && cbr('reading_original', 0, 3);
            const originalData = await this.readFlashPlain(address, size);
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
            await this.writeFlashPlain(address, randomData, (offset, total) => {
                const percent = Math.round((offset / total) * 100);
                cbr && cbr('writing', 2, 3, percent);
            });
            this.logDebug(`Write complete`);

            /* Step 4: Read back the data */
            this.logDebug(`Test: Reading back ${size} bytes from 0x${address.toString(16).padStart(8, '0')}...`);
            cbr && cbr('reading_back', 3, 3);
            const readbackData = await this.readFlashPlain(address, size);
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

    /**
     * Build command packet with 32-bit arguments
     * @param {number} command - Command code
     * @param {...(number|Uint8Array)} values - Arguments
     * @returns {Object} {command, payload: Uint8Array}
     */
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

    /**
     * Build raw command packet
     * @param {number} command - Command code
     * @param {Uint8Array} data - Payload
     * @returns {Object} {command, payload: Uint8Array}
     */
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

    /**
     * Debug dump packet to console
     * @param {Object} pkt - Parsed packet
     */
    dumpPacket(pkt) {
        if (!this.devMode) {
            return;
        }

        /* Log command execution with parameters */
        const commandNames = {
            0x02: 'FLASH_BEGIN', 0x03: 'FLASH_DATA', 0x04: 'FLASH_END',
            0x05: 'MEM_BEGIN', 0x06: 'MEM_END', 0x07: 'MEM_DATA',
            0x08: 'SYNC', 0x09: 'WRITE_REG', 0x0a: 'READ_REG',
            0x0b: 'SPI_SET_PARAMS', 0x0d: 'SPI_ATTACH', 0x0f: 'CHANGE_BAUDRATE',
            0x10: 'FLASH_DEFL_BEGIN', 0x11: 'FLASH_DEFL_DATA', 0x12: 'FLASH_DEFL_END',
            0x13: 'SPI_FLASH_MD5', 0x14: 'GET_SECURITY_INFO',
            0xd0: 'ERASE_FLASH', 0xd1: 'ERASE_REGION', 0xd2: 'READ_FLASH', 0xd3: 'RUN_USER_CODE'
        };
        const cmdName = commandNames[pkt.command] || `0x${pkt.command.toString(16)}`;
        this.logDebug(`[CMD] ${cmdName} (0x${pkt.command.toString(16).padStart(2, '0')})`, 'params:', pkt);

        if (pkt.dir == 0) {
            this.logDebug(`Command: `, pkt);
            this.logDebug(`Command raw: ${Array.from(pkt.raw).map(byte => byte.toString(16).padStart(2, '0')).join(' ')}`);
        }
        if (pkt.dir == 1) {
            this.logDebug(`Response: `, pkt);
            this.logDebug(`Response raw: ${Array.from(pkt.raw).map(byte => byte.toString(16).padStart(2, '0')).join(' ')}`);
        }
    }

    /**
     * Parse raw packet bytes
     * @param {Uint8Array} packet - Raw packet data
     * @returns {Object|null} Parsed packet or null if invalid
     */
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

    /**
     * Process received packet
     * @async
     * @param {Uint8Array} packet - Raw packet bytes
     * @returns {Promise<void>}
     */
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
            //this.logDebug(`Received raw SLIP: ${ Array.from(packet).map(byte => byte.toString(16).padStart(2, '0')).join(' ') }`);

            if (this.responseHandlers.has(-1)) {
                var handler = this.responseHandlers.get(-1);
                await handler(packet);
            }
        }
    }

    /* ==================== MD5 Hash Implementation ==================== */
    /**
     * MD5 Hash Implementation (from js-md5 library)
     * Standalone client-side hashing for data verification
     */
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

        /**
         * Finalize hash computation
         * @method finalize
         * @memberof Md5
         * @description Pads message and performs final hash operations
         */
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

        /**
         * Internal hash computation round
         * @method hash
         * @memberof Md5
         * @description Performs one MD5 hash block computation
         */
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

/* CommonJS export for Node.js */
if (typeof module !== 'undefined' && module.exports) {
    module.exports = ESPFlasher;
}