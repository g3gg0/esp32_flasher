'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const chips = require('../configs/chips.js');
const { ADCReader, adcProfiles, classifyUsage } = require('../adc.js');
const { GPIOController, DemoTransport } = require('../gpio.js');

test('ADC profiles model C3/C6/H2 ADC1 and both P4/S3 units with the correct pin maps', () => {
    assert.deepEqual(Object.keys(adcProfiles.esp32c3.channels).map(Number), [0, 1, 2, 3, 4]);
    assert.deepEqual(Object.keys(adcProfiles.esp32c6.channels).map(Number), [0, 1, 2, 3, 4, 5, 6]);
    assert.deepEqual(Object.keys(adcProfiles.esp32h2.channels).map(Number), [1, 2, 3, 4, 5]);
    for (let id = 1; id <= 5; id++) assert.deepEqual(adcProfiles.esp32h2.channels[id], { unit: 1, channel: id - 1 });
    assert.deepEqual(adcProfiles.esp32p4.channels[54], { unit: 2, channel: 5 });
    assert.equal(adcProfiles.esp32c3.sample.address, 0x60040020);
    assert.equal(adcProfiles.esp32c6.sample.done, 0x80000000);
    assert.equal(adcProfiles.esp32p4.units[1].control, 0x5012700c);
    assert.equal(adcProfiles.esp32p4.units[2].channelOffset, 2);
    const s3 = adcProfiles.esp32s3;
    assert.equal(s3.kind, 'rtc-sar');
    assert.deepEqual(Object.keys(s3.channels).map(Number), Array.from({ length: 20 }, (_, i) => i + 1));
    for (let id = 1; id <= 20; id++) assert.deepEqual(s3.channels[id], { unit: id <= 10 ? 1 : 2, channel: (id - 1) % 10 });
    assert.equal(s3.units[1].control, 0x6000880c);
    assert.equal(s3.units[2].control, 0x60008830);
    assert.equal(s3.units[1].attenuation, 0x60008814);
    assert.equal(s3.units[2].attenuation, 0x60008838);
    assert.equal(s3.units[2].channelOffset, 0);
    assert.equal(s3.units[2].invalidMask, 0xc000);
    assert.deepEqual(s3.units[1].idle, { address: 0x60008840, mask: 0x3fc00000 });
    assert.equal(s3.analog.bus.control, 0x6000e000);
    assert.equal(s3.analog.bus.commandMask, 1 << 26);
    for (const p of Object.values(adcProfiles)) {
        assert.equal(p.calibrated, false);
        for (const op of p.init) assert.equal(op.address % 4, 0);
    }
});

test('fresh ADC conversions and channel switching map both ADC units independently', async () => {
    for (const chipId of Object.keys(adcProfiles)) {
        const chip = chips[chipId], profile = adcProfiles[chipId];
        const transport = new DemoTransport(chip), reader = new ADCReader(transport, profile);
        const ids = Object.keys(profile.channels).map(Number);
        for (const id of ids) transport.adcModel.sources.set(id, () => (id % 8 + 1) / 10);
        for (const id of [...ids, ...ids.slice().reverse()]) {
            const sample = await reader.read(id);
            assert.equal(sample.raw, Math.round((id % 8 + 1) / 10 * 4095), `${chipId} GPIO${id}`);
            assert.equal(sample.value, sample.raw / 4095);
        }
        await reader.close();
        assert.equal(reader.ready, false);
    }
});

test('ADC mode plots analog samples only on ADC-capable pins and restores peripheral registers on exit', async () => {
    const chip = chips.esp32c6, transport = new DemoTransport(chip), controller = new GPIOController(transport, chip);
    await controller.initialize([0, 7]); await controller.configure(0, 'output', 'up', 1);
    const mux = transport.registers.get(chip.pins[0].mux);
    const originals = new Map();
    for (const op of adcProfiles.esp32c6.init) { transport.registers.set(op.address, 0x100); originals.set(op.address, 0x100); }
    await controller.setReadMode('adc'); await controller.sample();
    assert.equal(controller.pins.get(0).mode, 'output'); assert.equal(controller.pins.get(0).level, 1);
    assert.ok(controller.pins.get(0).adcRaw > 3000);
    assert.equal(controller.pins.get(7).read, null); assert.equal(controller.pins.get(7).history.samples.length, 0);
    assert.equal(transport.registers.get(chip.pins[0].mux), mux);
    await controller.setReadMode('digital');
    for (const op of adcProfiles.esp32c6.init) assert.equal((transport.registers.get(op.address) & op.mask) >>> 0, (originals.get(op.address) & op.mask) >>> 0);
    assert.equal(controller.pins.get(0).history.samples.length, 0);
    await controller.sample(); assert.equal(controller.pins.get(0).read, 1);
    await controller.release(); await controller.close();
});

test('stale DONE is cleared and ADC timeout never returns an old sample', async () => {
    const chip = chips.esp32c3, p = adcProfiles.esp32c3, transport = new DemoTransport(chip);
    const reader = new ADCReader(transport, p);
    await reader.read(0);
    transport.adcModel.neverDone = true;
    await assert.rejects(reader.read(0), /kein frisches DONE/);
    assert.equal((transport.registers.get(p.sample.address) || 0) & (p.sample.start | p.sample.enable), 0);
    await reader.close();
});

test('pull and active scans restore actual GPIO configuration, latch, enable and drive strength', async () => {
    for (const [chipId, id] of [['esp32c3', 0], ['esp32c6', 3], ['esp32p4', 54], ['esp32s3', 6], ['esp32s3', 15], ['esp32h2', 3]]) {
        const chip = chips[chipId], transport = new DemoTransport(chip), controller = new GPIOController(transport, chip);
        await controller.initialize([id]); await controller.configure(id, 'output', 'up', 1);
        const pin = chip.pins.find(pin => pin.id === id), bank = controller.bank(id), bit = 2 ** (id % 32);
        await transport.write(pin.mux, 2 << adcProfiles[chipId].driveStrength.shift, adcProfiles[chipId].driveStrength.mask);
        const addresses = [pin.mux, chip.gpio.matrix + id * 4, chip.gpio.pinConfig + id * 4, bank.enable, bank.output, ...pin.digitalRoute.map(op => op.address)];
        const before = new Map(addresses.map(address => [address, transport.registers.get(address) || 0]));
        for (const method of ['pull', 'drive', 'compare']) {
            const [result] = await controller.scanUsage([id], { method, settleMs: 5 });
            assert.ok(result.low.length >= 2); assert.ok(result.high.length >= 2);
            assert.ok(result.returnLow.length >= 2);
            assert.deepEqual(result.runs.map(run => run.method), method === 'compare' ? ['pull', 'drive'] : [method]);
            for (const run of result.runs) {
                assert.deepEqual(run.phases.map(phase => phase.level), [0, 1, 0]);
                for (const sample of run.samples) {
                    assert.ok(sample.startedAt <= sample.t && sample.t <= sample.doneAt);
                    assert.ok(sample.doneAt <= sample.receivedAt);
                }
                assert.ok(run.samples.every((s, i) => !i || s.t >= run.samples[i - 1].t));
            }
            assert.ok(result.low[1].elapsedMs >= result.low[0].elapsedMs);
            for (const address of addresses) assert.equal(transport.registers.get(address) || 0, before.get(address), `${chipId}, ${method}, 0x${address.toString(16)}`);
            assert.equal((transport.registers.get(bank.enable) || 0) & bit, bit);
            assert.equal(controller.pins.get(id).mode, 'output'); assert.equal(controller.pins.get(id).pull, 'up'); assert.equal(controller.pins.get(id).level, 1);
            assert.equal(controller.adc.ready, false);
        }
        await controller.release(); await controller.close();
    }
});

test('analog setup clears inherited test sources, applies eFuse initial code and restores only changed bits', async () => {
    for (const chipId of Object.keys(adcProfiles)) {
        const p = adcProfiles[chipId], transport = new DemoTransport(chips[chipId]), reader = new ADCReader(transport, p);
        const original = new Map();
        for (const field of p.analog.init) transport.adcModel.analogRegisters.set(field.register, 0xff);
        for (const field of Object.values(p.hardwareCalibration.units).flatMap(info => [info.high, info.low])) transport.adcModel.analogRegisters.set(field.register, 0xff);
        for (const [register, value] of transport.adcModel.analogRegisters) original.set(register, value);
        await reader.open();
        for (const field of p.analog.init) assert.equal(transport.adcModel.analogRegisters.get(field.register) & field.mask, field.value & field.mask, `${chipId} analog ${field.register}`);
        for (const [unit, info] of Object.entries(p.hardwareCalibration.units)) {
            const code = (transport.adcModel.analogRegisters.get(info.high.register) & 15) * 256 + transport.adcModel.analogRegisters.get(info.low.register);
            const expected = info.efuses ? (info.offset ?? p.hardwareCalibration.offset) + 17 + 23 + 31 + 43 : p.hardwareCalibration.offset + 350;
            assert.equal(code, expected);
            assert.equal(reader.calibration.codes[unit], code);
        }
        // Modify an unrelated bit while ADC is open; restoration must preserve it.
        const field = p.analog.init.find(f => f.register === 7);
        const fieldsMask = p.analog.init.filter(f => f.register === 7).reduce((mask, f) => mask | f.mask, 0);
        const untouchedBit = (~fieldsMask & 255) & -(~fieldsMask & 255);
        if (untouchedBit) transport.adcModel.analogRegisters.set(7, transport.adcModel.analogRegisters.get(7) & ~untouchedBit);
        await reader.close();
        for (const [register, value] of original) assert.equal(transport.adcModel.analogRegisters.get(register), register === field.register ? value & ~untouchedBit : value);
    }
});

test('S3 ATTEN3 trim accumulates all four differential eFuse fields, including split words', async () => {
    const p = adcProfiles.esp32s3, transport = new DemoTransport(chips.esp32s3), reader = new ADCReader(transport, p);
    // BLOCK2 bits 128 onward: version 1, ADC1 diffs 100/20/30/40,
    // ADC2 diffs 200/10/50/60 (official esp_efuse_table.c layout).
    const shadows = 1n | 100n << 21n | 20n << 29n | 30n << 35n | 40n << 41n |
        200n << 47n | 10n << 55n | 50n << 61n | 60n << 67n;
    const base = p.hardwareCalibration.major.address;
    for (let word = 0; word < 3; word++) transport.registers.set(base + word * 4, Number(shadows >> BigInt(word * 32) & 0xffffffffn));
    const writes = [], write = transport.write.bind(transport);
    transport.write = async (address, value, mask) => { writes.push({ address, value }); return write(address, value, mask); };
    await reader.open();
    assert.deepEqual(reader.calibration.codes, { 1: 2200, 2: 2340 });
    const commands = writes.filter(op => op.address === 0x6000e000);
    assert.ok(commands.length > 0);
    assert.ok(commands.every(op => op.value & (1 << 26)), 'S3 analog commands require bit 26 for reads and writes');
    assert.ok(!writes.some(op => op.address >= base && op.address < base + 12), 'eFuse shadows must remain read-only');
    await reader.close();
});

test('S3 rejects unknown factory trim versions and restores the analog setup', async () => {
    for (const version of [0, 2, 3]) {
        const p = adcProfiles.esp32s3, transport = new DemoTransport(chips.esp32s3), reader = new ADCReader(transport, p);
        const address = p.hardwareCalibration.major.address;
        transport.registers.set(address, ((transport.registers.get(address) & ~3) | version) >>> 0);
        transport.adcModel.analogRegisters.set(7, 0xff);
        await assert.rejects(reader.read(1), /eFuse/);
        assert.equal(reader.ready, false);
        assert.equal(transport.adcModel.analogRegisters.get(7), 0xff);
        assert.equal(reader.saved.size, 0);
    }
});

test('S3 waits for RTC ADC1 idle and rejects ADC2 arbiter failure flags', async () => {
    const p = adcProfiles.esp32s3;
    for (const flag of [0x4000, 0x8000, 0xc000]) {
        const transport = new DemoTransport(chips.esp32s3), reader = new ADCReader(transport, p);
        const read = transport.read.bind(transport);
        transport.read = async address => {
            const value = await read(address);
            return address === p.units[2].control && value & p.units[2].done ? value | flag : value;
        };
        await assert.rejects(reader.read(11), /Arbiter-Status/);
        assert.equal(transport.registers.get(p.units[2].control) & (p.units[2].start | p.units[2].pad.mask), 0);
        await reader.close();
    }
    const transport = new DemoTransport(chips.esp32s3), reader = new ADCReader(transport, p);
    transport.registers.set(p.units[1].idle.address, p.units[1].idle.mask);
    await assert.rejects(reader.read(1), /RTC-SAR bleibt belegt/);
    assert.equal(transport.registers.get(p.units[1].control) & p.units[1].start, 0);
    await reader.close();
});

test('S3 fresh DONE is required on both units, and cancellation disables the selected pad', async () => {
    const p = adcProfiles.esp32s3;
    for (const id of [1, 11]) {
        const transport = new DemoTransport(chips.esp32s3), reader = new ADCReader(transport, p);
        await reader.read(id);
        transport.adcModel.neverDone = true;
        await assert.rejects(reader.read(id), /kein frisches DONE/);
        const unit = p.units[p.channels[id].unit];
        assert.equal(transport.registers.get(unit.control) & (unit.start | unit.pad.mask), 0);
        transport.adcModel.neverDone = false;
        const abort = new AbortController(), write = transport.write.bind(transport);
        transport.write = async (address, value, mask) => {
            await write(address, value, mask);
            if (address === unit.control && value & unit.start) abort.abort();
        };
        await assert.rejects(reader.read(id, abort.signal), error => error.name === 'AbortError');
        assert.equal(transport.registers.get(unit.control) & (unit.start | unit.pad.mask), 0);
        await reader.close();
    }
});

test('eFuse shadow fields crossing a register boundary are decoded with the official initial-code offsets', async () => {
    const transport = new DemoTransport(chips.esp32p4), p = adcProfiles.esp32p4, reader = new ADCReader(transport, p);
    const field = p.hardwareCalibration.units[1].efuse;
    assert.equal(field.shift, 30);
    transport.registers.set(field.address, 0xc0000000);
    transport.registers.set(field.address + 4, 0x000000a5);
    assert.equal(await reader.efuse(field), 0x297);
    await reader.open(); assert.equal(reader.calibration.codes[1], 0x297 + 1400); await reader.close();
});

test('C6 ADC uses LP IO MUX and the matching LP output, pulls and readback, then restores HP operation', async () => {
    const chip = chips.esp32c6, transport = new DemoTransport(chip), controller = new GPIOController(transport, chip);
    const route = adcProfiles.esp32c6.padRoute;
    assert.equal(route.mux, 0x600b2048); assert.equal(route.bank.input, 0x600b2024);
    await controller.initialize([0, 1]); await controller.configure(0, 'output', 'up', 1);
    transport.registers.set(route.mux, 0x4100); transport.registers.set(route.bank.output, 0x82);
    transport.registers.set(route.bank.enable, 0x80);
    const addresses = [route.select, route.mux, route.mux + 4, route.pinConfig, route.pinConfig + 4, route.bank.output, route.bank.enable];
    const original = new Map(addresses.map(address => [address, transport.registers.get(address) || 0]));
    await controller.setReadMode('adc');
    assert.equal(transport.registers.get(route.select) & 3, 3);
    assert.equal(transport.registers.get(route.bank.enable) & 3, 1);
    assert.equal(transport.registers.get(chip.gpio.banks[0].enable) & 3, 0);
    assert.equal(transport.registers.get(route.mux) & route.pullUp, route.pullUp);
    await controller.setLevel(0, 0); await controller.sample();
    assert.equal(transport.registers.get(route.bank.output) & 1, 0);
    assert.equal(transport.registers.get(chip.gpio.banks[0].output) & 1, 1);
    assert.ok(controller.pins.get(0).adcRaw < 100);
    await controller.setReadMode('digital');
    assert.equal(transport.registers.get(chip.gpio.banks[0].enable) & 1, 1);
    assert.equal(transport.registers.get(chip.gpio.banks[0].output) & 1, 0);
    for (const address of addresses) assert.equal(transport.registers.get(address) || 0, original.get(address));
    const [result] = await controller.scanUsage([0], { method: 'compare', settleMs: 5 });
    assert.ok(result.runs[0].high.at(-1).raw > 3500);
    assert.ok(result.runs[1].low.at(-1).raw < 100);
    assert.ok(result.runs[1].high.at(-1).raw > 3900);
    for (const address of addresses) assert.equal(transport.registers.get(address) || 0, original.get(address));
    await controller.release(); await controller.close();
});

test('an ACK with ignored analog writes is rejected by masked readback verification', async () => {
    const p = adcProfiles.esp32c6, transport = new DemoTransport(chips.esp32c6), reader = new ADCReader(transport, p);
    const write = transport.write.bind(transport);
    transport.write = async (address, value, mask) => {
        if ([p.analog.bus.control, p.analog.bus.control + 4].includes(address) && value & (1 << 24)) return;
        return write(address, value, mask);
    };
    await assert.rejects(reader.open(), /wurde nicht übernommen/);
    assert.equal(reader.ready, false);
});

test('C6 enables both analog-I2C clock domains after ROM startup and restores their state', async () => {
    const p = adcProfiles.esp32c6, transport = new DemoTransport(chips.esp32c6);
    const address = 0x600af020, mask = 0x44000000, original = 0x22000000;
    transport.registers.set(address, original);
    const read = transport.read.bind(transport), write = transport.write.bind(transport);
    const gated = address => [p.analog.bus.control, p.analog.bus.control + 4].includes(address) &&
        ((transport.registers.get(0x600af020) || 0) & mask) !== mask;
    transport.read = address => gated(address) ? Promise.resolve(0) : read(address);
    transport.write = (address, ...args) => gated(address) ? Promise.resolve() : write(address, ...args);
    const missingClocks = structuredClone(p);
    missingClocks.analog.bus.init = missingClocks.analog.bus.init.filter(op => op.address !== address);
    await assert.rejects(new ADCReader(transport, missingClocks).open(), /wurde nicht übernommen/);
    const reader = new ADCReader(transport, p);
    await reader.open();
    assert.equal(transport.registers.get(address), original | mask);
    assert.equal(reader.calibration.source, 'efuse');
    await reader.close();
    assert.equal(transport.registers.get(address), original);
});

test('missing factory trim stops measurement and restores all analog fields', async () => {
    const transport = new DemoTransport(chips.esp32c6), p = adcProfiles.esp32c6, reader = new ADCReader(transport, p);
    transport.registers.set(p.hardwareCalibration.minor.address, 0);
    transport.adcModel.analogRegisters.set(7, 0x5a);
    await assert.rejects(reader.read(0), /ESP32C6 eFuse-Blockversion 0\.0 \(0\)/);
    assert.equal(reader.ready, false); assert.equal(transport.adcModel.analogRegisters.get(7), 0x5a);
});

test('scope exports real time bounds and separate digital readback for both pull and output', async () => {
    const { scopeSVG, scopeStats } = require('../scope.js');
    const controller = new GPIOController(new DemoTransport(chips.esp32c6), chips.esp32c6);
    await controller.initialize([0]);
    const [result] = await controller.scanUsage([0], { method: 'compare', settleMs: 5 });
    assert.ok(result.runs.every(run => run.samples.filter(s => s.io != null).length >= 6));
    const svg = scopeSVG(result);
    assert.match(svg, /LOW HIGH LOW/); assert.match(svg, /ADC-Fenster/);
    assert.match(svg, /#68e8a5/); assert.match(svg, /#67c9ff/); assert.match(svg, /#ff7786/);
    assert.match(scopeStats(result), /Pull:.*OUT:/);
    await controller.release(); await controller.close();
});

test('scan cancellation during active drive releases the test and restores the original input', async () => {
    const chip = chips.esp32c6, transport = new DemoTransport(chip), controller = new GPIOController(transport, chip), abort = new AbortController();
    await controller.initialize([0]);
    await assert.rejects(controller.scanUsage([0], { method: 'drive', settleMs: 5, signal: abort.signal,
        onPhase: () => abort.abort() }), error => error.name === 'AbortError');
    assert.equal(controller.pins.get(0).mode, 'input');
    assert.equal((transport.registers.get(chip.gpio.banks[0].enable) || 0) & 1, 0);
    assert.equal(controller.fault, false);
    await controller.release(); await controller.close();
});

test('scan ADC failure still restores the output and stops the controller', async () => {
    const chip = chips.esp32c3, transport = new DemoTransport(chip), controller = new GPIOController(transport, chip);
    await controller.initialize([0]); await controller.configure(0, 'output', 'none', 1);
    await assert.rejects(controller.scanUsage([0], { method: 'drive', settleMs: 5,
        onPhase: () => { transport.adcModel.neverDone = true; } }), /kein frisches DONE/);
    assert.equal(controller.pins.get(0).mode, 'output'); assert.equal(controller.pins.get(0).level, 1);
    assert.equal((transport.registers.get(chip.gpio.banks[0].enable) || 0) & 1, 1);
    assert.equal(controller.fault, true);
    await controller.release(); await controller.close();
});

test('failed pin restoration is reported, other fields are restored and the original output is not re-enabled', async () => {
    const chip = chips.esp32c6, transport = new DemoTransport(chip), controller = new GPIOController(transport, chip);
    await controller.initialize([0]); await controller.configure(0, 'output', 'up', 1);
    const write = transport.write.bind(transport), mux = chip.pins[0].mux;
    let restoring = false;
    transport.write = async (address, value, mask) => {
        if (restoring && address === mux) throw new Error('mux restore failure');
        return write(address, value, mask);
    };
    const abort = new AbortController();
    await assert.rejects(controller.scanUsage([0], { method: 'drive', settleMs: 5, signal: abort.signal,
        onPhase: () => { restoring = true; abort.abort(); } }), /Wiederherstellung unvollständig/);
    assert.equal(controller.pins.get(0).mode, 'unknown'); assert.equal(controller.fault, true);
    assert.equal((transport.registers.get(chip.gpio.banks[0].enable) || 0) & 1, 0);
    restoring = false; await controller.release(); await controller.close();
});

test('P4 stale DONE cannot pass a new conversion after timeout or cancellation', async () => {
    const transport = new DemoTransport(chips.esp32p4), p = adcProfiles.esp32p4, reader = new ADCReader(transport, p);
    await reader.read(54); transport.adcModel.neverDone = true;
    await assert.rejects(reader.read(54), /kein frisches DONE/);
    assert.equal((transport.registers.get(p.units[2].control) || 0) & (p.units[2].start | p.units[2].pad.mask), 0);
    await reader.close();
});

test('pause marks a measurement gap without changing output state or ADC source', async () => {
    const chip = chips.esp32c3, transport = new DemoTransport(chip), controller = new GPIOController(transport, chip);
    await controller.initialize([0]); await controller.configure(0, 'output', 'none', 1);
    await controller.setReadMode('adc'); controller.start(); await controller.pause();
    const state = controller.pins.get(0);
    assert.equal(state.history.samples.at(-1).breakRead, true);
    assert.equal(state.read, null); assert.equal(state.lastRead, null); assert.equal(state.level, 1);
    assert.equal(controller.readMode, 'adc');
    await controller.sample(); assert.ok(state.adcRaw > 3000);
    await controller.release(); await controller.close();
});

test('unmanaged and reserved pins and invalid scan parameters remain rejected', async () => {
    const chip = chips.esp32c3, transport = new DemoTransport(chip), controller = new GPIOController(transport, chip);
    await controller.initialize([0, 7]);
    await assert.rejects(controller.scanUsage([6]), /GPIO-Pins/);
    await assert.rejects(controller.scanUsage([18]), /GPIO-Pins/);
    await assert.rejects(controller.scanUsage([0], { method: 'invalid' }), /Scanparameter/);
    await assert.rejects(controller.scanUsage([0], { settleMs: -1 }), /Scanparameter/);
    await controller.release(); await controller.close();
});

test('classification distinguishes response bands without declaring an input/output direction', () => {
    const result = (low, high) => ({ method: 'drive', low: [{ raw: low }, { raw: low }], high: [{ raw: high }, { raw: high }] });
    assert.equal(classifyUsage(result(50, 4000)).label, 'Folgt deutlich');
    assert.equal(classifyUsage(result(300, 2000)).label, 'Folgt teilweise');
    assert.equal(classifyUsage(result(1000, 1010)).label, 'Kaum Reaktion');
    assert.equal(classifyUsage(result(3500, 500)).label, 'Widersprüchliche Reaktion');
    assert.equal(classifyUsage(result(0, 4095)).saturated, true);
    assert.match(classifyUsage(result(1000, 1010)).interpretation, /Last.*extern/);
});
