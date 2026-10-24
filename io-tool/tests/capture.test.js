const test = require('node:test');
const assert = require('node:assert/strict');
const chips = require('../configs/chips.js');
const { GPIOController, DemoTransport, RegisterTransport } = require('../gpio.js');
const { ADCReader, adcProfiles } = require('../adc.js');
const { SPIHost, PWMHost, RPCI2CHost } = require('../peripheral.js');
const { AcceleratedTransport, rpcEncode, rpcDecode } = require('../accelerated.js');
const protocol = require('../../stub/protocol.js');
const ESPFlasher = require('../../flasher.js');
async function fixture(chip) {
    const model = new DemoTransport(chip), traffic = [], device = new ESPFlasher({ logMessage() {}, logWarning() {}, logError() {} });
    device.port = { writable: true }; const decoder = new device.slipLayer.constructor(), plans = new Map(); let banks = [], reference, malformed = false;
    device._writeFrame = async frame => {
        for (const raw of decoder.decode(frame)) {
            const tag = new TextDecoder().decode(raw.slice(0, 4)); traffic.push({ tag, raw });
            if (tag === 'REGC') {
                const q = rpcDecode(raw, 'register_command'); let value = 0;
                if (q.operation === 0) value = await model.read(q.address); else await model.write(q.address, q.value, q.mask);
                await device.processPacket(rpcEncode('register_response', { value })); continue;
            }
            assert.equal(tag, 'IOCC');
            const q = rpcDecode(raw, 'capture_command'), samples = []; let detail = 0;
            if (q.operation === 1) { const v = new DataView(q.data.buffer, q.data.byteOffset); banks = Array.from({ length: q.count }, (_, i) => v.getUint32(i * 4, true)); }
            if (q.operation === 2) { const p = rpcDecode(raw, 'capture_plan'); plans.set(p.slot, p); }
            if (q.operation === 3) for (const [bank, address] of banks.entries()) if (q.selection & 1 << bank) samples.push([bank, 0, await model.read(address), 10]);
            if (q.operation === 4) for (const [slot, p] of plans) if (q.selection & 1 << slot) { const s = await reference.read(p.pin); samples.push([p.pin, 1, s.raw, 10]); }
            if (q.operation === 6) {
                const setup = rpcDecode(raw, 'adc_setup'); assert.ok(raw.length <= 1024); assert.ok(setup.init_count); assert.ok(setup.analog_count);
                reference = new ADCReader(model, adcProfiles[chip.id]); await reference.open(); detail = reference.calibration.version;
                for (const [unit, value] of Object.entries(reference.calibration.codes)) samples.push([Number(unit), 2, value, 0]);
            }
            if (q.operation === 5 || q.operation === 7) { await reference?.close(); reference = null; plans.clear(); }
            const data = new Uint8Array(samples.length * 12), v = new DataView(data.buffer);
            samples.forEach(([pin, kind, value, us], i) => { const o = i * 12; v.setUint16(o, pin, true); v.setUint16(o + 2, kind, true); v.setUint32(o + 4, value, true); v.setUint32(o + 8, us, true); });
            await device.processPacket(rpcEncode('capture_response', { count: samples.length, failed_slot: 65535, duration_us: 100, detail }, 'IOCR', malformed && data.length ? data.slice(1) : data));
        }
    };
    const transport = new AcceleratedTransport(device); transport.identity = { chip: chip.id, capabilities: 1 | 256, max_packet_length: 1024 };
    return { model, transport, traffic, malformed: () => { malformed = true; } };
}
test('classic mode observes GPIO without writes and rejects all control/ADC/peripheral actions', async () => {
    const t = new DemoTransport(chips.esp32p4), writes = [], original = t.write.bind(t);
    t.write = (...args) => { writes.push(args); return original(...args); };
    const c = new GPIOController(t, chips.esp32p4, { readOnly: true }); await c.initialize([4, 7, 8, 15]); await c.sample();
    assert.equal(c.pins.get(4).mode, 'observe'); assert.equal(writes.length, 0);
    await assert.rejects(c.configure(4, 'output')); await assert.rejects(c.setLevel(4, 1)); await assert.rejects(c.setReadMode('adc')); await assert.rejects(c.updateLDO4('off')); await assert.rejects(c.scanUsage([4]));
    for (const Host of [SPIHost, PWMHost, RPCI2CHost]) await assert.rejects(new Host(c).open({ pin: 4, sda: 7, scl: 8 }));
    await c.release(); await c.close(); assert.equal(writes.length, 0);
    assert.equal(new GPIOController(new RegisterTransport({}), chips.esp32c3).readOnly, true);
});
test('all target GPIO banks are captured in one accelerated request per sweep', async () => {
    for (const chip of Object.values(chips)) {
        const { transport, traffic } = await fixture(chip), c = new GPIOController(transport, chip);
        const ids = chip.pins.filter(p => !p.reserved).map(p => p.id); await c.initialize(ids); traffic.length = 0;
        await c.sample(); assert.deepEqual(traffic.map(t => t.tag), ['IOCC']);
        assert.equal(rpcDecode(traffic[0].raw, 'capture_command').operation, 3);
        assert.ok([...c.pins.values()].every(s => s.read === 0 || s.read === 1)); await c.release(); await c.close();
    }
});
test('ADC initialization/calibration use one stub command; repeated full sweeps contain no register polling', async () => {
    for (const [id, profile] of Object.entries(adcProfiles)) {
        const { transport, traffic } = await fixture(chips[id]), c = new GPIOController(transport, chips[id]);
        const ids = Object.keys(profile.channels).map(Number).filter(id => !chips[profile.chip].pins.find(p => p.id === id)?.reserved);
        await c.initialize(ids); traffic.length = 0; await c.setReadMode('adc');
        assert.equal(traffic.filter(t => t.tag === 'IOCC' && rpcDecode(t.raw, 'capture_command').operation === 6).length, 1);
        if (id === 'esp32c6' || id === 'esp32s3') {
            const setup = rpcDecode(traffic.find(t => t.tag === 'IOCC' && rpcDecode(t.raw, 'capture_command').operation === 6).raw, 'adc_setup');
            const v = new DataView(setup.data.buffer, setup.data.byteOffset, setup.data.byteLength);
            const ops = Array.from({ length: setup.init_count }, (_, i) => Array.from({ length: 3 }, (_, j) => v.getUint32(i * 12 + j * 4, true)));
            if (id === 'esp32c6') {
                const clocks = ops.findIndex(op => op[0] === 0x600af020);
                assert.deepEqual(ops[clocks], [0x600af020, 0x44000000, 0x44000000]);
                assert.ok(clocks < ops.findIndex(op => op[0] === 0x600af018), 'clock domains precede analog master enable');
            } else {
                // ROM leaves most analog blocks unmasked; SAR must be the only selected block.
                assert.deepEqual(ops.find(op => op[0] === 0x6000e044), [0x6000e044, 0xfffbffff, 0xffffffff]);
            }
        }
        const efuses = new Set([profile.hardwareCalibration.major.address, profile.hardwareCalibration.minor?.address]);
        assert.ok(!traffic.some(t => t.tag === 'REGC' && efuses.has(rpcDecode(t.raw, 'register_command').address)), 'factory trim is read inside stub');
        await c.sample(); traffic.length = 0;
        for (let i = 0; i < 3; i++) await c.sample();
        assert.equal(traffic.length, 3); assert.ok(traffic.every(t => t.tag === 'IOCC' && rpcDecode(t.raw, 'capture_command').operation === 4));
        assert.ok([...c.pins.values()].every(s => Number.isInteger(s.adcRaw) && s.adcRaw >= 0 && s.adcRaw <= 4095));
        traffic.length = 0;
        const single = await c.adc.read(ids[0]);
        assert.ok(Number.isInteger(single.raw)); assert.equal(traffic.length, 1); assert.equal(traffic[0].tag, 'IOCC');
        assert.equal(rpcDecode(traffic[0].raw, 'capture_command').operation, 4, 'usage scans also acquire ADC on device');
        assert.match(c.adc.calibration.source, /stub/); await c.release(); await c.close();
    }
});
test('malformed batched capture closes the session instead of plotting invented values', async () => {
    const f = await fixture(chips.esp32c3); await f.transport.captureConfigureGPIO([chips.esp32c3.gpio.banks[0].input]);
    f.malformed(); await assert.rejects(f.transport.captureGPIO(1), /Malformed/); assert.equal(f.transport.closed, true);
});
