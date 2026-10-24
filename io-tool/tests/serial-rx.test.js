'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const ESPFlasher = require('../../flasher.js');

/* Readable stand-in that hands out chunks; fail() errors the current stream like Web Serial does. */
class FakeStream {
    constructor() { this.queue = []; this.waiter = null; }
    push(item) { if (this.waiter) { const w = this.waiter; this.waiter = null; w(item); } else this.queue.push(item); }
    getReader() {
        return {
            read: () => {
                const settle = item => item instanceof Error ? Promise.reject(item) : Promise.resolve(item && item.done ? item : { value: item, done: false });
                return this.queue.length ? settle(this.queue.shift()) : new Promise((resolve, reject) => { this.waiter = item => settle(item).then(resolve, reject); });
            },
            cancel: async () => this.push({ done: true }),
            releaseLock() {}
        };
    }
}

function setup(port, logs = []) {
    const flasher = new ESPFlasher({ logWarning: m => logs.push(['warn', m]), logError: m => logs.push(['error', m]) });
    flasher.port = port; flasher.stubLoaded = true;
    const decoder = new flasher.slipLayer.constructor();
    let respond = () => {};
    flasher._writeFrame = async frame => {
        const [packet] = decoder.decode(frame), address = new DataView(packet.buffer).getUint32(8, true);
        const response = new Uint8Array(12), view = new DataView(response.buffer);
        response[0] = 1; response[1] = 0x0a; view.setUint16(2, 4, true); view.setUint32(4, (address ^ 0xc0dbc0db) >>> 0, true);
        setImmediate(() => respond(flasher.slipLayer.encode(response)));
    };
    flasher.reader = port.readable.getReader();
    flasher.startRxLoop();
    return { flasher, setResponder: fn => { respond = fn; } };
}

test('SLIP responses split into arbitrary partial reads are reassembled', async () => {
    const stream = new FakeStream(), { flasher, setResponder } = setup({ readable: stream, writable: {} });
    for (const split of ['bytewise', 'random']) {
        setResponder(encoded => {
            for (let i = 0; i < encoded.length;) {
                const n = split === 'bytewise' ? 1 : 1 + Math.floor(Math.random() * encoded.length);
                stream.push(encoded.slice(i, i + n)); i += n;
            }
        });
        /* low bytes 0xc0/0xdb exercise escape sequences split across reads */
        for (let i = 0; i < 300; i++) {
            const address = 0x60000000 + i;
            assert.equal(await flasher.readReg(address), (address ^ 0xc0dbc0db) >>> 0);
        }
    }
    await flasher.reader.cancel();
});

test('non-fatal read errors drop the partial frame and resume on the fresh port.readable', async () => {
    const logs = [], port = { readable: new FakeStream(), writable: {} };
    const { flasher, setResponder } = setup(port, logs);
    const first = port.readable;
    setResponder(encoded => {
        /* half a frame, then a framing error; the port provides a new stream */
        first.push(encoded.slice(0, 5));
        port.readable = new FakeStream();
        first.push(Object.assign(new Error('Framing error'), { name: 'FramingError' }));
    });
    await assert.rejects(flasher.readReg(0x60000010), /Timeout/);
    assert.ok(logs.some(([level, message]) => level === 'warn' && /FramingError/.test(message)));
    assert.ok(flasher.reader, 'reception resumed with a new reader');
    setResponder(encoded => port.readable.push(encoded));
    assert.equal(await flasher.readReg(0x60000020), (0x60000020 ^ 0xc0dbc0db) >>> 0);
    await flasher.reader.cancel();
});

test('read errors without a replacement stream stop reception visibly', async () => {
    const logs = [], port = { readable: new FakeStream(), writable: {} };
    const { flasher } = setup(port, logs);
    port.readable.push(new Error('device lost'));
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(flasher.reader, null);
    assert.ok(logs.some(([level, message]) => level === 'error' && /reception stopped/.test(message)));
});
test('device panic and reset evidence remains visible after ROM sync', () => {
    const messages=[],f=new ESPFlasher({logWarning:line=>messages.push(line)});f.synced=true;
    f.parseResetMessages(new TextEncoder().encode('Guru Meditation Error: Load access fault\nMEPC : 0x4fc00184\nMCAUSE : 0x5\n'));
    assert.equal(messages.length,3);assert.ok(messages.some(line=>line.includes('MEPC')));
});
