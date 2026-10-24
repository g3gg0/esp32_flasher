const test = require('node:test');
const assert = require('node:assert/strict');
const chips = require('../configs/chips.js');
const { GPIOController, DemoTransport } = require('../gpio.js');
const { SPIHost, PWMHost, RPCI2CHost } = require('../peripheral.js');
const { AcceleratedTransport, rpcEncode, rpcDecode } = require('../accelerated.js');
const ESPFlasher = require('../../flasher.js');

async function fixture(chip) {
    const model = new DemoTransport(chip), controller = new GPIOController(model, chip), calls = [];
    const ids = chip.pins.filter(p => p.output && !p.reserved).slice(0, 5).map(p => p.id);
    await controller.initialize(ids);
    model.supports = () => true;
    model.peripheral = async (kind, operation, port, args = [], data = new Uint8Array()) => {
        calls.push({ kind, operation, port, args, data: data.slice() });
        const values = kind === 'I2C' ? [20, 20, 21, 21, chip.gpio.base + 0x200, chip.id === 'esp32c2' ? 16 : 32, 2, 0] : kind === 'SPI' ? [22, 23, 24, 25, chip.gpio.base + 0x200, 2, 64, 0] : [26, 8, 4, 19, 0x3ffff, 0, 0, 0];
        return { values, actual_hz: args[0] || 1000000, data: operation !== 2 || kind === 'PWM' ? new Uint8Array() : kind === 'SPI' ? data.map(b => b ^ 255) : Uint8Array.from({ length: args[2] }, (_, i) => i + 1) };
    };
    return { model, controller, ids, calls };
}
test('all ten chips share I2C, SPI and PWM leases and restore inherited GPIO register fields', async () => {
    for (const chip of Object.values(chips)) {
        const { model, controller: c, ids, calls } = await fixture(chip);
        await c.configure(ids[0], 'output', 'none'); await c.setLevel(ids[0], 1);
        const before = new Map(model.registers);
        const i2c = new RPCI2CHost(c), spi = new SPIHost(c), pwm = new PWMHost(c);
        await i2c.open({ sda: ids[0], scl: ids[1], speed: 400000, pullups: true });
        await assert.rejects(spi.open({ clk: ids[0], mosi: ids[2], miso: ids[3], cs: ids[4] }), /belegt/);
        assert.deepEqual([...await i2c.transfer(80, Uint8Array.of(0x12, 0x34), 2)], [1, 2]);
        await i2c.close();
        await spi.open({ clk: ids[0], mosi: ids[1], miso: ids[2], cs: ids[3], speed: 2000000, mode: 3, lsb: true });
        assert.deepEqual([...await spi.transfer(Uint8Array.of(0x9f, 0))], [0x60, 255]);
        const n = calls.length; await assert.rejects(spi.transfer(new Uint8Array(65)), /64/); assert.equal(calls.length, n);
        await spi.close();
        await pwm.open({ pin: ids[0], frequency: 1000, bits: 10, duty: 500 }); await pwm.duty(1000); await pwm.close();
        assert.equal(c.pinOwners.size, 0); assert.equal(c.peripheralSessions.size, 0);
        for (const [address, value] of before) assert.equal(model.registers.get(address), value, `${chip.id} ${address.toString(16)}`);
        await c.close();
    }
});
test('I2C uses the target FIFO limit and PWM protects a channel already in use', async () => {
    const { controller: c, ids, calls } = await fixture(chips.esp32c2), i2c = new RPCI2CHost(c);
    await i2c.open({ sda: ids[0], scl: ids[1] });
    let n = calls.length; await assert.rejects(i2c.transfer(80, new Uint8Array(15), 1), /16/); await assert.rejects(i2c.transfer(80, new Uint8Array(), 17), /16/); assert.equal(calls.length, n);
    await i2c.close();
    const a = new PWMHost(c), b = new PWMHost(c); await a.open({ pin: ids[0] });
    await assert.rejects(b.open({ pin: ids[1] }), /belegt/); await a.close(); await c.close();
});
test('typed peripheral packets preserve u32 arrays, serialize transfers and detect response correlation', async () => {
    const data = rpcEncode('peripheral_command', { operation: 2, port: 1, timeout_us: 100000, args: [0xffffffff, 0x12345678, 0x10000] }, 'SPIC', Uint8Array.of(1));
    assert.equal(data.length, 49); assert.deepEqual(rpcDecode(data, 'peripheral_command', 'SPIC').args.slice(0, 3), [0xffffffff, 0x12345678, 0x10000]);
    const device = new ESPFlasher({ logMessage() {}, logWarning() {}, logError() {} }), decoder = new device.slipLayer.constructor(); device.port = { writable: true };
    let wrong = false;
    device._writeFrame = async frame => { for (const raw of decoder.decode(frame)) { const q = rpcDecode(raw, 'peripheral_command', 'SPIC'); await device.processPacket(rpcEncode('peripheral_response', { operation: q.operation, port: wrong ? 2 : q.port, values: [0xffffffff] }, 'SPIR', q.data)); } };
    const t = new AcceleratedTransport(device); t.identity = { capabilities: 4, max_packet_length: 1024 };
    const r = await t.peripheral('SPI', 2, 1, [1], Uint8Array.of(12)); assert.equal(r.values[0], 0xffffffff); assert.deepEqual([...r.data], [12]);
    wrong = true; await assert.rejects(t.peripheral('SPI', 2, 1, [1], Uint8Array.of(12)), /correlation/); assert.equal(t.closed, true);
});
