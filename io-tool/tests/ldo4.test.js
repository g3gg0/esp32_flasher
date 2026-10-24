'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const chips = require('../configs/chips.js');
const { GPIOController, DemoTransport } = require('../gpio.js');
const { LDO4, ldo4Profiles } = require('../ldo4.js');
const p = ldo4Profiles.esp32p4;

test('GPIO initialization never reads or writes the separate supply; unknown/off does not block pins', async () => {
    const transport = new DemoTransport(chips.esp32p4), c = new GPIOController(transport, chips.esp32p4);
    const accesses = [], read = transport.read.bind(transport), write = transport.write.bind(transport);
    transport.read = async address => { accesses.push(address); return read(address); };
    transport.write = async (...args) => { accesses.push(args[0]); return write(...args); };
    const ids = [4, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49];
    await c.initialize(ids);
    assert.deepEqual([...c.pins.keys()], ids);
    assert.equal(c.ldo4.state, null);
    await c.configure(45, 'output', 'none', 0);
    await c.sample();
    assert.equal(accesses.some(address => [p.control, p.analog].includes(address)), false);
    await c.updateLDO4();
    assert.equal(c.ldo4.state.enabled, false);
    await c.setLevel(45, 1);
    assert.equal(c.pins.get(45).level, 1);
    assert.deepEqual([...c.pins.keys()], ids);
    await c.release(); await c.close();
});

test('explicit supply switching preserves unrelated PMU bits and never changes GPIO configuration', async () => {
    const transport = new DemoTransport(chips.esp32p4), c = new GPIOController(transport, chips.esp32p4);
    const control = 0xa5a00020, analog = 0x91012345;
    transport.registers.set(p.control, control); transport.registers.set(p.analog, analog);
    await c.initialize([4, 39, 45, 48]);
    await c.configure(45, 'output', 'none', 0);
    const pins = [...c.pins.entries()], writes = [], write = transport.write.bind(transport);
    transport.write = async (...args) => { writes.push(args); return write(...args); };
    await c.updateLDO4('bypass');
    assert.equal(transport.registers.get(p.control), ((control & ~p.mask) | p.bypass) >>> 0);
    assert.equal(transport.registers.get(p.analog), (analog | p.voltageDetector) >>> 0);
    c.pinOwners.set(39, 'I²C0');
    await c.updateLDO4();
    await assert.rejects(c.updateLDO4('off'), /freigeben/);
    assert.equal(c.ldo4.state.bypass, true); assert.equal(c.fault, false);
    c.pinOwners.clear();
    await c.updateLDO4('off');
    assert.equal(transport.registers.get(p.control), (control & ~p.mask) >>> 0);
    assert.deepEqual([...c.pins.entries()], pins);
    assert.equal(c.pins.get(45).mode, 'output');
    assert.ok(writes.every(([address]) => [p.control, p.analog].includes(address)));
    await c.updateLDO4('bypass');
    await c.release();
    assert.equal(transport.registers.get(p.control) & p.mask, p.bypass);
    await c.close();
});

test('explicit refresh reads inherited state; XPD, not TIEH, indicates enabled', async () => {
    const transport = new DemoTransport(chips.esp32p4), ldo = new LDO4(transport, p);
    for (const [control, enabled] of [[0, false], [1 << 14, false], [p.enable, true], [p.bypass, true]]) {
        transport.registers.set(p.control, control);
        assert.equal((await ldo.refresh()).enabled, enabled);
    }
    await assert.rejects(ldo.setMode('1.8V'), /nur Aus/);
});

test('supply errors reject and invalidate readback without gating or reconfiguring GPIOs', async () => {
    for (const failRead of [false, true]) {
        const transport = new DemoTransport(chips.esp32p4), c = new GPIOController(transport, chips.esp32p4);
        await c.initialize([4, 45]);
        const pins = [...c.pins.entries()];
        if (failRead) transport.read = async () => { throw new Error('read failed'); };
        else transport.write = async () => {};
        await assert.rejects(c.updateLDO4('bypass'), failRead ? /read failed/ : /nicht bestätigt/);
        assert.equal(c.ldo4.state, null);
        assert.equal(c.fault, false);
        assert.deepEqual([...c.pins.entries()], pins);
        assert.equal(c.descriptor(45).id, 45);
        await c.close();
    }
});

test('supply support and register fields come from profiles, not hard-coded chip IDs', async () => {
    const profile = { ...p, control: 0x100, analog: 0x104, enable: 2, mask: 6, bypass: 6, voltageDetector: 8, pins: [4] };
    const transport = new DemoTransport(chips.esp32s3), ldo = new LDO4(transport, profile);
    assert.equal(ldo.affects(4), true); assert.equal(ldo.affects(45), false);
    await ldo.setMode('bypass');
    assert.equal(transport.registers.get(profile.control), 6);
    assert.equal(transport.registers.get(profile.analog), 8);
    assert.equal(ldo.state.enabled, true);
    const c = new GPIOController(transport, chips.esp32s3);
    assert.equal(c.ldo4, null);
    await c.initialize([39, 45]);
    assert.equal(c.pins.size, 2);
    await assert.rejects(c.updateLDO4('off'), /nicht verfügbar/);
    await c.release(); await c.close();
});

test('board domain notes cover every affected pin without reserving it', () => {
    const board = require('../configs/boards.js').boards.find(board => board.id === 'p4-eth');
    for (const id of p.pins) {
        assert.match(board.notes[id], /LDO4(?:-Domäne| power domain).*separate (?:Stromversorgung|supply)/);
        assert.equal(chips.esp32p4.pins.find(pin => pin.id === id).reserved, '');
    }
});
