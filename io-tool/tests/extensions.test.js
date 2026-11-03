const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const chips = require('../configs/chips.js');
const { GPIOController, DemoTransport } = require('../gpio.js');
const { ExtensionManager, parseExtension } = require('../extensions.js');

// Chainable stand-in for the DOM-backed block helpers.
function fakeBlock() {
    const calls = [];
    const block = new Proxy(function () {}, {
        get(_, key) {
            if (key === 'remove') return () => calls.push('remove');
            if (key === 'calls') return calls;
            if (key === 'value') return '0';
            if (key === 'input') return { files: [], addEventListener() {} };
            return (...args) => { calls.push([key, ...args]); return block; };
        }
    });
    return block;
}

async function fixture({ i2c = true } = {}) {
    const chip = chips.esp32c3, model = new DemoTransport(chip), controller = new GPIOController(model, chip), operations = [], logs = [];
    const pins = chip.pins.filter(p => p.output && !p.reserved).slice(0, 6).map(p => p.id);
    await controller.initialize(pins);
    const host = i2c ? { ready: true, controller, config: { port: 0, sda: pins[0], scl: pins[1] }, info: [0, 0, 0, 0, 0, 16], transfer: async () => new Uint8Array() } : null;
    const blocks = [];
    const manager = new ExtensionManager({
        controller: () => controller, chip: () => chip, board: () => ({ id: 'raw', name: 'Raw' }), pins: () => pins, session: () => 'demo', log: (...a) => logs.push(a.join(' ')),
        hosts: { i2c: () => host, spi: () => null, rmt: () => null, pwm: () => null },
        blocked: () => false, setOperation: value => operations.push(value),
        ui: { block: () => { const b = fakeBlock(); blocks.push(b); return b; } }
    });
    return { manager, controller, pins, host, blocks, operations, logs, model };
}

test('definitions are validated before a file is accepted', () => {
    assert.throws(() => parseExtension('module.exports = {}', 'x.js'), /"id"/);
    assert.throws(() => parseExtension('module.exports = { id: "a b", name: "n", load() {} }', 'x.js'), /"id"/);
    assert.throws(() => parseExtension('module.exports = { id: "a", name: "n" }', 'x.js'), /load/);
    assert.throws(() => parseExtension('module.exports = { id: "a", name: "n", load() {}, interfaces: [{ id: "bus", kinds: ["uart"] }] }', 'x.js'), /kinds/);
    assert.throws(() => parseExtension('throw new Error("boom")', 'x.js'), /boom/);
    const def = parseExtension('module.exports = { id: "ok", name: "N", load() {}, gpios: [{ id: "led", mode: "output" }] }', 'x.js');
    assert.equal(def.gpios[0].label, 'led');
});

test('every shipped example is a valid extension', () => {
    const dir = path.join(__dirname, '../extensions');
    const files = fs.readdirSync(dir).filter(name => name.endsWith('.js'));
    assert.ok(files.length >= 4);
    for (const file of files) {
        const def = parseExtension(fs.readFileSync(path.join(dir, file), 'utf8'), file);
        assert.ok(def.name && def.description, file);
    }
    const ws = parseExtension(fs.readFileSync(path.join(dir, 'ws2812.js'), 'utf8'), 'ws2812.js');
    assert.deepEqual(ws.interfaces[0].kinds, ['rmt']);
});

test('extension needs its interface and GPIOs, claims pins and restores them on stop', async () => {
    const { manager, controller, pins, blocks } = await fixture();
    const entry = await manager.loadSource(`module.exports = { id: 'blink', name: 'Blink', gpios: [{ id: 'led', mode: 'output', level: 1 }],
        async load(api) { api.ui.block('x'); await api.gpios.led.write(0); } };`, 'blink.js');
    assert.equal(entry.state, 'idle', 'requirements not met: waits for a GPIO');
    await assert.rejects(manager.start('blink'), /GPIO/);
    entry.gpioChoice.led = pins[2];
    assert.equal(manager.missing(entry), '');
    await manager.start('blink');
    assert.equal(entry.state, 'active');
    assert.equal(controller.pins.get(pins[2]).mode, 'output');
    assert.equal(blocks.length, 1);
    const other = await manager.loadSource(`module.exports = { id: 'other', name: 'O', gpios: [{ id: 'p', mode: 'output' }], load() {} };`, 'o.js');
    assert.ok(!manager.freeGpios(other, other.def.gpios[0]).includes(pins[2]), 'claimed pin is not offered twice');
    other.gpioChoice.p = pins[2];
    await assert.rejects(manager.start('other'), /verwendet/);
    await manager.stop('blink');
    assert.equal(entry.state, 'idle');
    assert.equal(controller.pins.get(pins[2]).mode, 'input');
    assert.ok(blocks[0].calls.includes('remove'));
    await controller.close();
});

test('interface binding is implicit for a single candidate and unload removes everything', async () => {
    const { manager, host, controller } = await fixture();
    globalThis.__ext = { unloaded: 0 };
    await manager.loadSource(`module.exports = { id: 'i2c-demo', name: 'D', interfaces: [{ id: 'bus', kinds: ['i2c'] }],
        load(api) { globalThis.__ext.bound = api.interfaces.bus.host; globalThis.__ext.shortcut = api.i2c; }, unload() { globalThis.__ext.unloaded++; } };`, 'd.js');
    await manager.start('i2c-demo');
    assert.equal(globalThis.__ext.bound, host);
    assert.equal(globalThis.__ext.shortcut, host);
    await manager.unload('i2c-demo');
    assert.equal(globalThis.__ext.unloaded, 1);
    assert.equal(manager.list.length, 0);
    delete globalThis.__ext;
    await controller.close();
});

test('missing interface is explained and a session reset stops running extensions', async () => {
    const { manager, controller } = await fixture({ i2c: false });
    const entry = await manager.loadSource(`module.exports = { id: 'needs-i2c', name: 'N', interfaces: [{ id: 'bus', kinds: ['i2c'] }], load() {} };`, 'n.js');
    assert.match(manager.missing(entry), /aktivieren/);
    await assert.rejects(manager.start('needs-i2c'), /aktivieren/);
    const free = await manager.loadSource(`module.exports = { id: 'free', name: 'F', load(api) { api.log('hi'); } };`, 'f.js');
    assert.equal(free.state, 'active', 'extensions without requirements start immediately');
    await manager.reset();
    assert.equal(free.state, 'idle');
    assert.equal(manager.list.length, 2, 'reset keeps extensions loaded');
    await manager.loadSource(`module.exports = { id: 'free', name: 'F', load() {} };`, 'dup.js').then(() => assert.fail(), error => assert.match(error.message, /already loaded/));
    await controller.close();
});

test('failing load() cleans up and reports the error', async () => {
    const { manager, controller, pins, blocks } = await fixture();
    const entry = manager.install(`module.exports = { id: 'bad', name: 'B', gpios: [{ id: 'g', mode: 'output' }], load(api) { api.ui.block('x'); throw new Error('nope'); } };`, 'bad.js');
    entry.gpioChoice.g = pins[0];
    await assert.rejects(manager.start('bad'), /nope/);
    assert.equal(entry.state, 'error');
    assert.equal(entry.error, 'nope');
    assert.ok(blocks[0].calls.includes('remove'));
    assert.ok(!manager.claims.has(pins[0]));
    await controller.close();
});

test('Lattice example reads the device ID and looks up the part name', async () => {
    const { manager, host, controller } = await fixture();
    const sent = [];
    host.transfer = async (address, data, read) => { sent.push([address, [...data], read]); return read === 4 ? Uint8Array.of(0x01, 0x2B, 0xB0, 0x43) : new Uint8Array(read); };
    const buttons = [], out = { set: text => out.text = text };
    const block = new Proxy({}, { get: (_, key) => key === 'output' ? () => out : key === 'button' ? (label, fn) => { buttons.push([label, fn]); return {}; } : key === 'field' ? () => ({ value: '40', input: { files: [] } }) : () => block, });
    const manager2 = new ExtensionManager({
        controller: () => controller, chip: () => chips.esp32c3, board: () => ({ id: 'raw', name: 'Raw' }), pins: () => [], session: () => 'demo', log() {},
        hosts: { i2c: () => host }, blocked: () => false, setOperation() {}, ui: { block: () => ({ ...['row', 'text', 'table', 'progress'].reduce((o, k) => ({ ...o, [k]: () => block }), {}), button: block.button, field: block.field, output: block.output, setStatus() {}, remove() {}, setTitle() {} }) }
    });
    const entry = await manager2.loadSource(fs.readFileSync(path.join(__dirname, '../extensions/lattice-machxo2.js'), 'utf8'), 'lattice.js');
    await manager2.start('lattice-machxo2');
    assert.equal(entry.state, 'active');
    const idButton = buttons.find(([label]) => label === 'ID lesen');
    await idButton[1]();
    assert.match(out.text, /LCMXO2-2000HC/);
    assert.deepEqual(sent.find(item => item[1][0] === 0xE0), [0x40, [0xE0, 0, 0, 0], 4]);
    await controller.close();
});

test('Lattice example runs over SPI: ID read and config-flash programming sequence', async () => {
    const { controller } = await fixture({ i2c: false });
    const sent = [];
    // Status: DONE set, not busy; ID answer follows the four command bytes.
    const spiHost = { ready: true, controller, config: { mode: 0, lsb: false }, transfer: async data => {
        sent.push([...data]);
        const rx = new Uint8Array(data.length);
        if (data[0] === 0xE0) rx.set([0x01, 0x2B, 0xB0, 0x43], 4);
        if (data[0] === 0x3C) rx.set([0x00, 0x00, 0x01, 0x00], 4);
        return rx;
    } };
    const buttons = new Map(), out = { set: text => out.text = text };
    const helper = { button: (label, fn) => { buttons.set(label, fn); return {}; }, field: () => ({ value: '', input: { files: [{ arrayBuffer: async () => Uint8Array.from({ length: 40 }, (_, i) => i).buffer }] } }), output: () => out };
    const block = new Proxy({}, { get: (_, key) => helper[key] || (() => block) });
    globalThis.window = { confirm: () => true };
    const manager = new ExtensionManager({
        controller: () => controller, chip: () => chips.esp32c3, board: () => ({ id: 'raw', name: 'Raw' }), pins: () => [], session: () => 'demo', log() {},
        hosts: { i2c: () => null, spi: () => spiHost }, blocked: () => false, setOperation() {}, ui: { block: () => block }
    });
    const entry = await manager.loadSource(fs.readFileSync(path.join(__dirname, '../extensions/lattice-machxo2.js'), 'utf8'), 'lattice.js');
    assert.equal(manager.missing(entry), '', 'single available SPI host is selected automatically');
    await manager.start('lattice-machxo2');
    await buttons.get('ID lesen')();
    assert.match(out.text, /LCMXO2-2000HC/);
    sent.length = 0;
    await buttons.get('Flash programmieren')();
    delete globalThis.window;
    const opcodes = sent.map(p => p[0]).filter(op => op !== 0x3C);
    assert.deepEqual(opcodes.slice(0, 3), [0xC6, 0x0E, 0x46]);
    assert.deepEqual(sent.find(p => p[0] === 0x0E), [0x0E, 0x04, 0, 0], 'flash erase mask');
    const pages = sent.filter(p => p[0] === 0x70);
    assert.equal(pages.length, 3, '40 bytes are padded to three 16-byte pages');
    assert.deepEqual(pages[0].slice(0, 6), [0x70, 0, 0, 1, 0, 1]);
    assert.deepEqual(pages[2].slice(-8), new Array(8).fill(0xFF));
    assert.ok(opcodes.includes(0x5E) && opcodes.includes(0x79));
    await controller.close();
});
