/*
 * Node.js Adapter for ESPFlasher
 * Minimal Web Serial API polyfill for flasher.js in Node.js
 * 
 * Usage:
 *   require('./flasher-nodejs.js');
 *   const ESPFlasher = require('./flasher.js');
 *   const { createNodeESPFlasher } = require('./flasher-nodejs.js');
 *   const flasher = new (createNodeESPFlasher(ESPFlasher))();
 *   await flasher.openPortByPath('/dev/ttyUSB0');
 */

const fs = require('fs');
const { EventEmitter } = require('events');

/* Polyfill TextEncoder/TextDecoder - used by flasher.js */
if (!global.TextEncoder) {
    global.TextEncoder = class {
        encode(str) {
            return new Uint8Array(Buffer.from(str, 'utf-8'));
        }
    };
}

if (!global.TextDecoder) {
    global.TextDecoder = class {
        constructor(encoding = 'utf-8') {
            this.encoding = encoding;
        }
        decode(buffer) {
            return Buffer.from(buffer).toString(this.encoding);
        }
    };
}

/*
 * Raw FD Serial Port - uses fs.readSync polling
 */
class RawFDSerialPort extends EventEmitter {
    constructor(portPath) {
        super();
        this.portPath = portPath;
        this.fd = null;
        this.isOpen = false;
        this.pollInterval = null;
    }

    async open(options = {}) {
        const baudRate = options.baudRate || 115200;
        const { execSync } = require('child_process');
        
        try {
            execSync(`stty -F ${this.portPath} ${baudRate} raw -echo -echoe -echok -ixoff -ixon -ixany -crtscts cs8 -parenb -cstopb min 0 time 0`, { stdio: 'ignore' });
        } catch (e) {}
        
        try {
            const flags = fs.constants.O_RDWR | fs.constants.O_NOCTTY | fs.constants.O_NONBLOCK;
            this.fd = fs.openSync(this.portPath, flags);
            this.isOpen = true;
            
            try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10); } catch (_) {}
            this._startPolling();
        } catch (error) {
            throw new Error(`Failed to open ${this.portPath}: ${error.message}`);
        }
    }

    async close() {
        if (!this.isOpen || !this.fd) return;
        this.isOpen = false;
        if (this.pollInterval) clearInterval(this.pollInterval);
        try {
            fs.closeSync(this.fd);
            this.fd = null;
            this.emit('close');
        } catch (error) {
            throw new Error(`Failed to close port: ${error.message}`);
        }
    }

    _startPolling() {
        const readBuffer = Buffer.alloc(4096);
        this.pollInterval = setInterval(() => {
            if (!this.isOpen || !this.fd) {
                if (this.pollInterval) {
                    clearInterval(this.pollInterval);
                    this.pollInterval = null;
                }
                return;
            }
            
            try {
                const bytesRead = fs.readSync(this.fd, readBuffer, 0, readBuffer.length);
                if (bytesRead > 0) {
                    this.emit('data', Buffer.from(readBuffer.slice(0, bytesRead)));
                }
            } catch (error) {
                if (error.code !== 'EAGAIN' && error.code !== 'EWOULDBLOCK' && this.isOpen) {
                    this.emit('error', error);
                }
            }
        }, 1);
    }

    write(data, callback) {
        if (!this.isOpen) {
            if (callback) callback(new Error('Port is not open'));
            return;
        }

        try {
            if (data instanceof Uint8Array) data = Buffer.from(data);
            let bytesWritten = 0;
            try {
                bytesWritten = fs.writeSync(this.fd, data);
            } catch (err) {
                if (err.code === 'EIO' || err.code === 'EAGAIN' || err.code === 'EWOULDBLOCK') {
                    try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2); } catch (_) {}
                    bytesWritten = fs.writeSync(this.fd, data);
                } else {
                    throw err;
                }
            }
            if (callback) setImmediate(() => callback(null, bytesWritten));
        } catch (error) {
            if (callback) callback(error);
            else this.emit('error', error);
        }
    }

    async setSignals(signals) {
        if (!this.isOpen || !this.fd) return Promise.resolve();
        
        try {
            const path = require('path');
            const { execSync } = require('child_process');
            const scriptPath = path.join(__dirname, 'set-signals.py');
            let args = [];
            
            if (signals.dataTerminalReady !== undefined) {
                args.push(`dtr=${signals.dataTerminalReady ? 1 : 0}`);
            }
            if (signals.requestToSend !== undefined) {
                args.push(`rts=${signals.requestToSend ? 1 : 0}`);
            }
            
            if (args.length > 0) {
                execSync(`python3 ${scriptPath} ${this.portPath} ${args.join(' ')}`, { stdio: 'ignore' });
            }
        } catch (e) {
            /* Silently fail - some systems may not support signal control */
        }
        
        return Promise.resolve();
    }

    addEventListener(event, callback) {
        this.on(event, callback);
    }

    removeEventListener(event, callback) {
        this.removeListener(event, callback);
    }
}

/*
 * Node.js Serial Port Wrapper
 */
class NodeSerialPort {
    constructor(portPath) {
        this.portPath = portPath;
        this.serialPort = new RawFDSerialPort(portPath);
        this.readable = null;
        this.writable = null;
        this.isOpen = false;
        this.eventListeners = { 'close': [], 'disconnect': [] };
    }

    async open(options = {}) {
        const baudRate = options.baudRate || 115200;
        try {
            await this.serialPort.open({ baudRate });
            this.isOpen = true;

            this.readable = {
                getReader: () => new NodeSerialReader(this.serialPort)
            };

            this.writable = {
                getWriter: () => new NodeSerialWriter(this.serialPort)
            };

            this.serialPort.on('close', () => {
                this.isOpen = false;
                this._triggerEvent('close');
            });

            this.serialPort.on('error', (err) => {
                console.error('Serial port error:', err);
            });
        } catch (error) {
            throw new Error(`Failed to open port: ${error.message}`);
        }
    }

    async close() {
        if (!this.serialPort || !this.isOpen) return;
        try {
            await this.serialPort.close();
            this.isOpen = false;
        } catch (error) {
            throw new Error(`Failed to close port: ${error.message}`);
        }
    }

    getInfo() {
        return { usbVendorId: undefined, usbProductId: undefined };
    }

    async setSignals(signals) {
        if (this.serialPort && typeof this.serialPort.setSignals === 'function') {
            return this.serialPort.setSignals(signals);
        }
        return Promise.resolve();
    }

    addEventListener(event, callback) {
        if (this.eventListeners[event]) this.eventListeners[event].push(callback);
    }

    removeEventListener(event, callback) {
        if (this.eventListeners[event]) {
            this.eventListeners[event] = this.eventListeners[event].filter(cb => cb !== callback);
        }
    }

    _triggerEvent(event) {
        if (this.eventListeners[event]) {
            this.eventListeners[event].forEach(callback => {
                try { callback({ target: this }); } catch (e) {}
            });
        }
    }
}

/*
 * Node.js Serial Reader - implements ReadableStreamDefaultReader interface
 */
class NodeSerialReader {
    constructor(serialPort) {
        this.serialPort = serialPort;
        this.canceled = false;
        this.dataQueue = [];
        this.readResolvers = [];
        
        this.serialPort.on('data', (chunk) => {
            if (this.canceled) return;
            this.dataQueue.push(new Uint8Array(chunk));
            while (this.readResolvers.length > 0 && this.dataQueue.length > 0) {
                const resolver = this.readResolvers.shift();
                resolver({ value: this.dataQueue.shift(), done: false });
            }
        });
        
        this.serialPort.on('close', () => {
            while (this.readResolvers.length > 0) {
                this.readResolvers.shift()({ value: undefined, done: true });
            }
        });
    }

    async read() {
        if (this.canceled) return { value: undefined, done: true };
        if (this.dataQueue.length > 0) {
            return { value: this.dataQueue.shift(), done: false };
        }
        return new Promise((resolve) => {
            this.readResolvers.push(resolve);
        });
    }

    async cancel() {
        this.canceled = true;
        while (this.readResolvers.length > 0) {
            this.readResolvers.shift()({ value: undefined, done: true });
        }
    }

    releaseLock() {}
}

/*
 * Node.js Serial Writer - implements WritableStreamDefaultWriter interface
 */
class NodeSerialWriter {
    constructor(serialPort) {
        this.serialPort = serialPort;
        this.closed = false;
    }

    async write(data) {
        if (this.closed) throw new Error('Writer is closed');
        if (data instanceof Uint8Array) data = Buffer.from(data);
        return new Promise((resolve, reject) => {
            this.serialPort.write(data, (err) => {
                if (err) reject(err);
                else resolve();
            });
        });
    }

    async close() {
        this.closed = true;
    }

    releaseLock() {}
}

/* Install navigator.serial polyfill */
if (!global.navigator) global.navigator = {};
if (!global.navigator.serial) {
    global.navigator.serial = {
        addEventListener: () => {},
        removeEventListener: () => {}
    };
}

/*
 * Extend ESPFlasher with Node.js methods
 */
function createNodeESPFlasher(ESPFlasherClass) {
    class NodeESPFlasher extends ESPFlasherClass {
        constructor() {
            super();
            this.portPath = null;
            this.isNodeJS = true;
            this.initialBaudRate = 115200;
        }

        async openPortByPath(portPath, baudRate = null) {
            this.portPath = portPath;
            const nodePort = new NodeSerialPort(portPath);
            const baud = baudRate || this.initialBaudRate;

            try {
                await nodePort.open({ baudRate: baud });
                return this.openPortWithPort(nodePort);
            } catch (error) {
                throw new Error(`Failed to open port ${portPath}: ${error.message}`);
            }
        }

        static async listPorts() {
            try {
                const { SerialPort } = require('serialport');
                const ports = await SerialPort.list();
                return ports.map(port => ({
                    path: port.path,
                    manufacturer: port.manufacturer,
                    productId: port.productId,
                    vendorId: port.vendorId,
                    serialNumber: port.serialNumber
                }));
            } catch (error) {
                throw new Error(`Failed to list ports: ${error.message}`);
            }
        }
    }

    return NodeESPFlasher;
}

/* Export */
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        NodeSerialPort,
        NodeSerialReader,
        NodeSerialWriter,
        createNodeESPFlasher
    };
}
