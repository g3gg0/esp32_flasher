const test = require('node:test');
const assert = require('node:assert/strict');
const chips = require('../configs/chips.js');
const { GPIOController, DemoTransport } = require('../gpio.js');
const { I2CHost, i2cProfiles, transactionPlan, parseHexBytes } = require('../i2c.js');
const { SDHost } = require('../sd.js');
async function fixture(port = 0, speed = 100000) {
    const t = new DemoTransport(chips.esp32p4), c = new GPIOController(t, chips.esp32p4);
    await c.initialize([4, 7, 8, 15, 16]);
    const log = [], host = new I2CHost(c, { onTransaction: e => log.push(e), timeoutMs: 20 });
    return { t, c, host, log, config: { sda: 7, scl: 8, port, speed, pullups: true } };
}
test('P4 I2C uses native opcodes, both clock gates in CTRL10, separate dividers and LL timings', () => {
    const ports = i2cProfiles.esp32p4.ports;
    assert.deepEqual(ports[0].opcodes, { restart: 6, write: 1, read: 3, stop: 2, end: 4 });
    for (const [index, p] of ports.entries()) {
        assert.equal(p.registers.control, 0x500c4004 + index * 0x1000);
        assert.deepEqual(p.matrix.signals, { sda: 69 + index * 2, scl: 68 + index * 2 });
        for (const speed of [100000, 400000]) {
            const ops = p.timings[speed], half = speed === 100000 ? 200 : 50;
            assert.equal(ops[0].address, 0x500e6040);
            assert.equal(ops[0].value, index ? 1 << 27 : 2);
            assert.equal(ops[1].address, 0x500e6040 + index * 4);
            assert.equal(ops[1].value, 0);
            assert.equal(ops[2].value, half - 1);
            assert.equal(ops[3].value, (half / 2 - 2) << 9 | half - (half / 2 - 2));
        }
    }
});
test('I2C combined transfers keep repeated START and ACK all but the final RX byte', () => {
    const p = i2cProfiles.esp32p4.ports[0], plan = transactionPlan(p, 0x18, Uint8Array.of(0x10), 4);
    assert.deepEqual(plan.tx, [0x30, 0x10, 0x31]);
    assert.deepEqual(plan.commands.map(c => c >>> 11 & 7), [6, 1, 6, 1, 3, 3, 2]);
    assert.equal(plan.commands[4] & 255, 3); assert.equal(plan.commands[4] & 1024, 0);
    assert.equal(plan.commands[5] & 255, 1); assert.equal(plan.commands[5] & 1024, 1024);
    assert.equal(plan.commands[1] & 256, 256); assert.equal(plan.commands[3] & 256, 256);
    assert.deepEqual(Array.from(parseHexBytes('00 A5,0xff;12')), [0, 165, 255, 18]);
    for (const text of ['1', 'GG', '0x100']) assert.throws(() => parseHexBytes(text));
    for (const [write, read] of [[32, 0], [31, 1], [0, 33]]) assert.throws(() => transactionPlan(p, 0x18, new Uint8Array(write), read));
    assert.throws(() => transactionPlan(p, 128));
});
test('I2C0/1 read and write byte-exact data at 100/400 kHz and reject oversize transfers before traffic', async () => {
    for (const port of [0, 1]) for (const speed of [100000, 400000]) {
        const { c, t, host, config } = await fixture(port, speed); await host.open(config);
        assert.deepEqual(Array.from(await host.transfer(0x18, Uint8Array.of(0x10), 4)), [16, 17, 18, 19]);
        await host.transfer(0x18, Uint8Array.of(0x10, 0xaa, 0xbb), 0);
        assert.deepEqual(Array.from(await host.transfer(0x18, Uint8Array.of(0x10), 2)), [170, 187]);
        assert.equal((await host.transfer(0x18, new Uint8Array(), 32)).length, 32);
        const count = t.i2cModel.ports[port].transactions.length;
        await assert.rejects(host.transfer(0x18, new Uint8Array(31), 1), /FIFO/);
        assert.equal(t.i2cModel.ports[port].transactions.length, count);
        await host.close(); await c.release(); await c.close();
    }
});
test('address scan skips NACKs with a real STOP recovery and finds only responding addresses', async () => {
    const { c, t, host, config, log } = await fixture(); await host.open(config);
    const progress = [], found = [];
    assert.deepEqual(await host.scan({ onFound: a => found.push(a), onProgress: a => progress.push(a) }), [0x18, 0x50]);
    assert.deepEqual(found, [0x18, 0x50]); assert.equal(progress[0], 3); assert.equal(progress.at(-1), 0x77);
    assert.equal(log.length, 117); assert.equal(t.i2cModel.ports[0].transactions.filter(e => e.recoveryStop).length, 115);
    await host.close(); await c.release(); await c.close();
});
test('I2C rejects stale DONE, hardware timeout and arbitration loss; it never fabricates RX', async () => {
    for (const failure of ['staleDone', 'timeout', 'arbitration']) {
        const { c, t, host, config, log } = await fixture(); await host.open(config);
        t.i2cModel.ports[0][failure] = true;
        await assert.rejects(host.transfer(0x18, new Uint8Array(), 1), /DONE|Timeout|Arbitration/);
        assert.equal(log.at(-1).read, undefined); assert.ok(log.at(-1).error);
        await host.close(); await c.release(); await c.close();
    }
});
test('I2C leases restore GPIO outputs and coexist with SD without clobbering shared clocks', async () => {
    const { c, t, host, config } = await fixture(1); await c.configure(7, 'output', 'down', 1);
    const sd = new SDHost(c); await sd.open({ width: 1, pins: { d0: 4, cmd: 15, clk: 16 } });
    await host.open(config);
    assert.equal(c.pinOwners.get(7), 'I²C1'); assert.equal(c.pinOwners.get(4), 'SD');
    await assert.rejects(c.configure(7, 'input', 'none'), /I²C1|verwendet/);
    await assert.rejects(c.scanUsage([7]), /Peripherie|verwendet|I²C/);
    for (const id of [7, 8]) assert.equal(t.registers.get(c.chip.gpio.pinConfig + id * 4) & 4, 4);
    await host.close(); assert.equal(sd.ready, true); assert.equal(c.pinOwners.get(4), 'SD');
    assert.equal(c.pins.get(7).mode, 'output'); assert.equal(c.pins.get(7).level, 1);
    await sd.identify(); await c.release(); await c.close();
});
test('I2C scan cancellation frees leases and restores the previous output', async () => {
    const { c, host, config } = await fixture(); await c.configure(7, 'output', 'none', 0); await host.open(config);
    const cancel = new AbortController();
    await assert.rejects(host.scan({ signal: cancel.signal, onProgress: () => cancel.abort() }), { name: 'AbortError' });
    assert.equal(host.ready, false); assert.equal(c.pinOwners.size, 0); assert.equal(c.fault, false);
    assert.equal(c.pins.get(7).mode, 'output'); assert.equal(c.pins.get(7).level, 0);
    await c.release(); await c.close();
});
