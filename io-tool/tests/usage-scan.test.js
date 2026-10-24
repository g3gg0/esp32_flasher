'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const chips = require('../configs/chips.js');
const { adcProfiles, classifyUsage } = require('../adc.js');
const { GPIOController, DemoTransport } = require('../gpio.js');
const { scopeSVG, scopeLegend } = require('../scope.js');

test('digital scan works for every writable GPIO chip profile without opening or reading an ADC', async () => {
    for (const chip of Object.values(chips).filter(chip => !chip.readOnlyGPIO)) {
        const pin = chip.pins.find(pin => !pin.reserved && pin.output && pin.pulls && !adcProfiles[chip.id]?.channels[pin.id] && (chip.gpio.banks.length < 2 || pin.id >= 32));
        assert.ok(pin, chip.id);
        const transport = new DemoTransport(chip), controller = new GPIOController(transport, chip);
        await controller.initialize([pin.id]); await controller.configure(pin.id, 'output', 'up', 1);
        if (controller.adc) controller.adc.open = controller.adc.read = async () => { throw new Error('ADC must stay untouched'); };
        const bank = controller.bank(pin.id);
        const addresses = [pin.mux, bank.output, bank.enable, chip.gpio.matrix + pin.id * 4, chip.gpio.pinConfig + pin.id * 4, ...pin.digitalRoute.map(op => op.address)];
        const before = new Map(addresses.map(address => [address, transport.registers.get(address) || 0]));
        const [result] = await controller.scanUsage([pin.id], { method: 'compare', settleMs: 5 });
        assert.equal(result.measurement, 'digital'); assert.equal(result.calibration, null);
        assert.equal(result.assessment.label, 'Nur digital gemessen'); assert.equal(result.assessment.span, null);
        assert.equal(result.baseline.raw, null); assert.equal(result.baseline.value, null);
        for (const run of result.runs) {
            assert.deepEqual(run.phases.map(phase => phase.level), [0, 1, 0]);
            for (const sample of run.samples) {
                assert.equal(sample.raw, null); assert.equal(sample.value, null);
                assert.ok([0, 1].includes(sample.io));
                assert.ok(sample.ioStartedAt <= sample.t && sample.t <= sample.ioDoneAt);
            }
        }
        assert.deepEqual(result.runs[1].phases.map(phase => result.runs[1].samples.find(sample => sample.phase === phase.name).io), [0, 1, 0]);
        assert.deepEqual(result.runs[0].phases.map(phase => result.runs[0].samples.find(sample => sample.phase === phase.name).io), [0, 1, 0]);
        for (const address of addresses) assert.equal(transport.registers.get(address) || 0, before.get(address), `${chip.id} restore 0x${address.toString(16)}`);
        const svg = scopeSVG(result);
        assert.match(svg, /GPIO-Fenster/); assert.doesNotMatch(svg, /4095|NaN|ADC-Fenster|null/);
        assert.match(scopeLegend(result), /kein ADC/);
        await controller.release(); await controller.close();
    }
});

test('mixed ADC/digital scan keeps each pin measurement type and restores the ADC session', async () => {
    const controller = new GPIOController(new DemoTransport(chips.esp32c6), chips.esp32c6);
    await controller.initialize([0, 7]); await controller.setReadMode('adc');
    const results = await controller.scanUsage([0, 7], { method: 'compare', settleMs: 5 });
    assert.deepEqual(results.map(result => result.measurement), ['adc', 'digital']);
    assert.equal(controller.readMode, 'adc'); assert.equal(controller.adc.ready, true);
    assert.equal(controller.pins.get(7).mode, 'input');
    await controller.release(); await controller.close();
});

test('input-only pins without pulls are observed without ever enabling an output', async () => {
    const chip = chips.esp32, transport = new DemoTransport(chip), controller = new GPIOController(transport, chip);
    const id = 34, writes = [], write = transport.write.bind(transport);
    await controller.initialize([id]);
    transport.write = async (...args) => { writes.push(args); return write(...args); };
    const [result] = await controller.scanUsage([id], { method: 'compare', settleMs: 5 });
    assert.equal(result.method, 'observe'); assert.equal(result.requestedMethod, 'compare');
    assert.deepEqual(result.skippedMethods, ['pull', 'drive']);
    assert.equal(result.assessment.label, 'Nur Eingangsmessung');
    assert.equal(result.runs[0].phases[0].level, null);
    assert.ok(!writes.some(([address]) => address === controller.bank(id).enableSet));
    assert.doesNotMatch(scopeSVG(result), /NaN|LOW HIGH LOW/);
    await controller.release(); await controller.close();
});

test('digital scan cancellation restores the prior output latch, enable and pulls', async () => {
    const chip = chips.esp32s3, transport = new DemoTransport(chip), controller = new GPIOController(transport, chip);
    const id = 4, abort = new AbortController();
    await controller.initialize([id]); await controller.configure(id, 'output', 'up', 1);
    const mux = transport.registers.get(chip.pins.find(pin => pin.id === id).mux);
    await assert.rejects(controller.scanUsage([id], { method: 'drive', settleMs: 5, signal: abort.signal, onPhase: () => abort.abort() }), { name: 'AbortError' });
    assert.equal(controller.pins.get(id).mode, 'output'); assert.equal(controller.pins.get(id).level, 1);
    assert.equal(transport.registers.get(chip.pins.find(pin => pin.id === id).mux), mux);
    assert.ok(transport.registers.get(controller.bank(id).enable) & (1 << id));
    assert.ok(transport.registers.get(controller.bank(id).output) & (1 << id));
    assert.equal(controller.fault, false);
    await controller.release(); await controller.close();
});

test('comparison interprets the reported weak-HIGH / driven-LOW pattern and its opposite', () => {
    const samples = raw => [{ raw }, { raw }];
    const run = (method, low, high, returnLow = low) => ({ method, measurement: 'adc', low: samples(low), high: samples(high), returnLow: samples(returnLow) });
    const compare = (pull, drive) => classifyUsage({ ...drive, method: 'compare', runs: [pull, drive] });
    const up = compare(run('pull', 3650, 4095), run('drive', 57, 4095));
    assert.equal(up.label, 'Pull-up plausibel'); assert.equal(up.comparedMethods, true);
    assert.match(up.interpretation, /andere externe Ansteuerung/);
    assert.equal(compare(run('pull', 0, 420), run('drive', 10, 4000)).label, 'Pull-down plausibel');
    assert.equal(compare(run('pull', 0, 4095), run('drive', 10, 4095)).label, 'Folgt auch schwachen Pulls');
    // A changing source or an output that cannot pull LOW is not a pull-up finding.
    assert.notEqual(compare(run('pull', 3650, 4095, 0), run('drive', 57, 4095)).label, 'Pull-up plausibel');
    assert.notEqual(compare(run('pull', 3650, 4095), run('drive', 3600, 4095)).label, 'Pull-up plausibel');
});
