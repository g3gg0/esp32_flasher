const test = require('node:test');
const assert = require('node:assert/strict');
const { registerScanOptions, encodeI2CRegister, scanI2CRegisters } = require('../i2c-registers.js');
test('register addresses preserve width and byte order, including non-byte and 64-bit widths', () => {
    assert.deepEqual([...encodeI2CRegister(0x123n, 12, 'BE')], [1, 0x23]);
    assert.deepEqual([...encodeI2CRegister(0x123n, 12, 'LE')], [0x23, 1]);
    assert.deepEqual([...encodeI2CRegister(0xfedcba9876543210n, 64, 'BE')], [254, 220, 186, 152, 118, 84, 50, 16]);
    assert.throws(() => encodeI2CRegister(256, 8, 'BE'));
    for (const options of [{ bits: 0 }, { endian: 'xx' }, { start: '-1' }, { end: '256' }, { start: '4', end: '3' }, { bits: 16, end: '4096' }, { readLength: 0 }]) assert.throws(() => registerScanOptions(options));
});
test('register scan uses one combined write/read per row and reports exact TX/RX', async () => {
    const calls = [], rows = [], host = { transfer: async (...args) => { calls.push(args); return Uint8Array.of(args[1][0], 0xaa); } };
    assert.equal(await scanI2CRegisters(host, 0x50, { bits: 16, endian: 'LE', start: '0x123', end: '0x125', readLength: 2 }, { onRow: r => rows.push(r) }), 3);
    assert.deepEqual(calls.map(c => [c[0], [...c[1]], c[2]]), [[80, [35, 1], 2], [80, [36, 1], 2], [80, [37, 1], 2]]);
    assert.equal(rows[2].register, 0x125n); assert.deepEqual([...rows[0].read], [35, 170]);
});
test('scan cancellation and bus errors stop subsequent register accesses', async () => {
    const cancel = new AbortController(), rows = [];
    let calls = 0;
    const host = { transfer: async () => { calls++; cancel.abort(); return Uint8Array.of(1); } };
    await assert.rejects(scanI2CRegisters(host, 20, { end: '3' }, { signal: cancel.signal, onRow: r => rows.push(r) }), { name: 'AbortError' });
    assert.equal(calls, 1); assert.equal(rows.length, 1);
    const fail = new Error('NACK');
    await assert.rejects(scanI2CRegisters({ transfer: async () => { throw fail; } }, 20, { end: '3' }, { onRow: r => rows.push(r) }), fail);
    assert.equal(rows.at(-1).error, 'NACK');
});
test('register scan also uses the existing legacy P4 I2C backend', async () => {
    const chips = require('../configs/chips.js');
    const { GPIOController, DemoTransport } = require('../gpio.js');
    const { I2CHost } = require('../i2c.js');
    const c = new GPIOController(new DemoTransport(chips.esp32p4), chips.esp32p4);
    await c.initialize([7, 8]); const host = new I2CHost(c), rows = [];
    await host.open({ sda: 7, scl: 8, port: 0, speed: 100000, pullups: true });
    await scanI2CRegisters(host, 0x18, { bits: 8, start: '0', end: '2', readLength: 2 }, { onRow: row => rows.push(row) });
    assert.equal(rows.length, 3); assert.ok(rows.every(row => row.read.length === 2));
    await host.close(); assert.equal(c.pinOwners.size, 0); await c.close();
});
