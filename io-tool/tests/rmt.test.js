const test = require('node:test');
const assert = require('node:assert/strict');
const { RMTHost, rmtSymbol, packRMT, ws2812Sequence, rainbowPattern } = require('../rmt.js');

test('WS2812 uses GRB, MSB first and defined pulse durations at 20 MHz', () => {
    const words = ws2812Sequence(Uint8Array.of(0x80, 0x01, 0), 20000000);
    const zero = rmtSymbol(1, 7, 0, 18), one = rmtSymbol(1, 14, 0, 11);
    assert.deepEqual([...words], [...Array(7).fill(zero), one, one, ...Array(15).fill(zero)]);
    assert.equal(packRMT(words).totalTicks, 600);
    assert.equal(rainbowPattern(1365).length, 4095);
    assert.throws(() => rainbowPattern(1366));
});

test('two-symbol packing retains bit order, RAW uses little endian and both enforce RAM limits', () => {
    const a = rmtSymbol(1, 10, 0, 20), b = rmtSymbol(1, 20, 0, 10), c = rmtSymbol(1, 30, 0, 10);
    const bitmap = packRMT(Uint32Array.of(a, b, a, b, b, a, a, b, b));
    assert.equal(bitmap.encoding, 1); assert.deepEqual([...bitmap.data], [0x59, 0x80]);
    assert.deepEqual(bitmap.dictionary, [a, b]);
    const raw = packRMT(Uint32Array.of(a, b, c)); assert.equal(raw.encoding, 0);
    assert.equal(new DataView(raw.data.buffer).getUint32(8, true), c);
    assert.equal(packRMT(new Uint32Array(32768).fill(a)).data.length, 4096);
    assert.throws(() => packRMT(Uint32Array.from({ length: 1025 }, (_, i) => [a, b, c][i % 3])), /4096/);
    assert.throws(() => packRMT(Uint32Array.of(0)), /Null/);
});

function hostFixture({ partial = false, fail = false } = {}) {
    const calls = [], transport = {
        closed: false, close() { this.closed = true; },
        async peripheral(kind, operation, port, args, data = new Uint8Array(), timeout) {
            calls.push({ kind, operation, port, args, data: data.slice(), timeout });
            if (operation === 16) this.count = args[1];
            if (operation === 17 && fail) throw new Error('upload failed');
            return { values: [operation === 18 ? (partial ? 1 : this.count * args[0]) : 0], data: new Uint8Array() };
        }
    };
    const controller = { transport, queue: { run: fn => fn() }, active: true };
    const host = new RMTHost(controller);host.ready = true;host.config = { port: 0 };host.actualHz = 20000000;
    return { host, calls, transport };
}

test('long uploads are contiguous bounded chunks followed by a single complete local send', async () => {
    const { host, calls } = hostFixture(), sequence = ws2812Sequence(rainbowPattern(1365), 20000000);
    await host.send(sequence, { repeat: 2 });
    assert.equal(calls[0].operation, 16); assert.equal(calls[0].args[1], 32760);
    const chunks = calls.filter(c => c.operation === 17);
    assert.deepEqual(chunks.map(c => c.args[0]), [0, 768, 1536, 2304, 3072, 3840]);
    assert.equal(chunks.reduce((sum, c) => sum + c.data.length, 0), 4095);
    assert.equal(calls.at(-1).operation, 18);assert.deepEqual(calls.at(-1).args, [2, 80]);
    assert.ok(calls.at(-1).timeout >= 100000);
});

test('upload errors abort the staged sequence; malformed completion closes the session', async () => {
    const sequence = ws2812Sequence(Uint8Array.of(1, 2, 3), 20000000);
    const a = hostFixture({ fail: true });await assert.rejects(a.host.send(sequence), /upload failed/);
    assert.equal(a.calls.at(-1).operation, 19);assert.ok(!a.calls.some(c => c.operation === 18));
    const b = hostFixture({ partial: true });await assert.rejects(b.host.send(sequence), /unvoll/);assert.equal(b.transport.closed, true);
    const cancelled = hostFixture(), abort = new AbortController();abort.abort();
    await assert.rejects(cancelled.host.send(sequence, { signal: abort.signal }), { name: 'AbortError' });assert.equal(cancelled.calls.length, 0);
});
