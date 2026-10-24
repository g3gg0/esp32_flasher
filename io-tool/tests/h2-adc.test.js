'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const chips = require('../configs/chips.js');
const { ADCReader, adcProfiles } = require('../adc.js');
const { DemoTransport, GPIOController } = require('../gpio.js');

test('H2 factory trim uses BLOCK2 version >=2 and ATTEN3 +1600, with either analog master', async () => {
    const p = adcProfiles.esp32h2, cal = p.hardwareCalibration;
    // ESP-IDF H2 eFuse table: BLOCK2 bits 130..132/133..134 and 175..184.
    assert.deepEqual(cal.minor, { address: 0x600b086c, shift: 2, bits: 3 });
    assert.deepEqual(cal.major, { address: 0x600b086c, shift: 5, bits: 2 });
    assert.deepEqual(cal.units[1].efuse, { address: 0x600b0870, shift: 15, bits: 10 });
    for (const [major, minor, code, master] of [[0, 2, 0, 0], [0, 7, 1023, 1], [1, 0, 350, 0]]) {
        const transport = new DemoTransport(chips.esp32h2), reader = new ADCReader(transport, p);
        transport.registers.set(0x600b086c, major << 5 | minor << 2);
        transport.registers.set(0x600b0870, code << 15);
        transport.registers.set(p.analog.bus.select, master === 0 ? 1 << 11 : 0);
        transport.adcModel.analogRegisters.set(8, 0xff); // inherited internal ground path
        await reader.open();
        assert.equal(reader.busAddress, 0x600ad800 + master * 4);
        assert.equal(reader.calibration.version, major * 100 + minor);
        assert.deepEqual(reader.calibration.codes, { 1: code + 1600 });
        assert.equal(transport.adcModel.analogRegisters.get(8), 0xfd); // only ENCAL_GND bit 1 cleared
        await reader.close();
        assert.equal(transport.adcModel.analogRegisters.get(8), 0xff);
    }
    for (const version of [0, 1]) {
        const transport = new DemoTransport(chips.esp32h2), reader = new ADCReader(transport, p);
        transport.registers.set(0x600b086c, version << 2);
        const original = new Map(p.init.map(op => [op.address, transport.registers.get(op.address) || 0]));
        await assert.rejects(reader.read(1), new RegExp(`ESP32H2 eFuse-Blockversion 0\\.${version}.*Version ab 2`));
        assert.equal(reader.ready, false);
        assert.equal(transport.adcModel.analogRegisters.size, 0);
        for (const [address, value] of original) assert.equal(transport.registers.get(address) || 0, value);
    }
});

test('H2 waits on-device for synchronized data after each fresh DONE, including channel warm-up', async () => {
    const p = adcProfiles.esp32h2, s = p.sample;
    assert.equal(s.address, 0x6000e020);
    assert.equal(s.data, 0x6000e02c);
    const transport = new DemoTransport(chips.esp32h2), reader = new ADCReader(transport, p);
    const write = transport.write.bind(transport), read = transport.read.bind(transport);
    let pending = null, conversions = 0, synchronized = 0;
    transport.write = async (address, value, mask = 0xffffffff, delayUs = 0) => {
        const old = transport.registers.get(s.address) || 0;
        await write(address, value, mask, delayUs);
        if (address === s.address && (mask & s.start) && (value & s.start) && !(old & s.start)) {
            assert.equal(pending, null);
            pending = transport.registers.get(s.data);
            transport.registers.set(s.data, 0); // DONE precedes valid result on H2
            conversions++;
        }
        if (pending !== null && delayUs >= 10) {
            assert.ok(transport.registers.get(s.status) & s.done);
            assert.equal(transport.registers.get(s.address), old); // delay must not retrigger/disable ADC
            transport.registers.set(s.data, pending); pending = null; synchronized++;
        }
    };
    transport.read = async address => {
        if (address === s.data) assert.equal(pending, null, 'ADC data read before synchronization delay');
        return read(address);
    };
    for (let id = 1; id <= 5; id++) {
        transport.adcModel.sources.set(id, () => id / 8);
        const sample = await reader.read(id);
        assert.equal(sample.raw, Math.round(id / 8 * 4095));
        assert.ok(sample.startedAt <= sample.doneAt && sample.doneAt <= sample.receivedAt);
    }
    assert.equal(conversions, 10); assert.equal(synchronized, 10);
    await reader.close();
});

test('H2 live ADC preserves HP GPIO output/readback and excludes GPIO0 from analog data', async () => {
    const chip = chips.esp32h2, transport = new DemoTransport(chip), controller = new GPIOController(transport, chip);
    await controller.initialize([0, 3]);
    await controller.configure(3, 'output', 'none', 1);
    const bank = controller.bank(3), mux = transport.registers.get(controller.descriptor(3).mux);
    await controller.setReadMode('adc'); await controller.sample();
    assert.equal(transport.registers.get(controller.descriptor(3).mux), mux);
    assert.ok(transport.registers.get(bank.enable) & (1 << 3));
    assert.ok(controller.pins.get(3).adcRaw > 3900);
    assert.equal(controller.pins.get(0).adcRaw, null);
    assert.equal(controller.pins.get(0).history.samples.length, 0);
    await controller.setReadMode('digital'); await controller.sample();
    assert.equal(controller.pins.get(3).read, 1);
    const results = await controller.scanUsage([0, 3], { method: 'compare', settleMs: 5 });
    assert.deepEqual(results.map(result => result.measurement), ['digital', 'adc']);
    assert.ok(results[1].runs.every(run => run.samples.every(sample => Number.isFinite(sample.raw))));
    assert.equal(controller.pins.get(3).mode, 'output');
    assert.equal(controller.pins.get(3).level, 1);
    assert.equal(transport.registers.get(controller.descriptor(3).mux), mux);
    await controller.release(); await controller.close();
});
