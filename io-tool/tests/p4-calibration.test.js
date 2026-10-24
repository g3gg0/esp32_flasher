'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const chips = require('../configs/chips.js');
const { ADCReader, adcProfiles } = require('../adc.js');
const { DemoTransport } = require('../gpio.js');

test('P4 accepts eFuse block major >=1 as supported since ESP-IDF v5.5.2', async () => {
    for (const [major, minor] of [[0, 1], [0, 7], [1, 0], [1, 1], [2, 0], [3, 7]]) {
        const transport = new DemoTransport(chips.esp32p4), p = adcProfiles.esp32p4, reader = new ADCReader(transport, p);
        // BLOCK1 bit72..74 minor, bit75..76 major; shadow register +0x4c.
        assert.equal(p.hardwareCalibration.major.address, 0x5012d04c);
        transport.registers.set(0x5012d04c, major << 11 | minor << 8);
        await reader.open();
        assert.equal(reader.calibration.version, major * 100 + minor);
        assert.deepEqual(reader.calibration.blockVersion, { major, minor });
        assert.equal(reader.calibration.codes[1], 1750);
        assert.equal(reader.calibration.codes[2], 1750);
        assert.equal((await reader.read(16)).unit, 1);
        assert.equal((await reader.read(54)).unit, 2);
        await reader.close();
    }
});

test('P4 version zero reports actual fields and preserves the analog state', async () => {
    const transport = new DemoTransport(chips.esp32p4), p = adcProfiles.esp32p4, reader = new ADCReader(transport, p);
    transport.registers.set(p.hardwareCalibration.major.address, 0);
    transport.adcModel.analogRegisters.set(7, 0x5a);
    await assert.rejects(reader.open(), /ESP32P4 eFuse-Blockversion 0\.0 \(0\).*Selbstkalibrierung/);
    assert.equal(reader.ready, false);
    assert.equal(transport.adcModel.analogRegisters.get(7), 0x5a);
    assert.equal(reader.analogSaved.size, 0);
});
