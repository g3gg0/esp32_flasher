'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const chips = require('../configs/chips.js');
const { boards, raw } = require('../configs/boards.js');
const { GPIOController, RegisterTransport, History, DemoTransport } = require('../gpio.js');
const ESPFlasher = require('../../flasher.js');

class RecordingTransport extends DemoTransport {
    constructor(chip, clock) { super(chip, clock); this.writes = []; this.reads = []; }
    async write(address, value, mask) { this.writes.push({ address, value: value >>> 0, mask }); return super.write(address, value, mask); }
    async read(address) { this.reads.push(address); return super.read(address); }
}

test('chip profiles use the actual C3/C6/P4 register maps and matrix bitfields', () => {
    assert.equal(chips.esp32c3.gpio.base, 0x60004000);
    assert.equal(chips.esp32c6.gpio.base, 0x60091000);
    assert.equal(chips.esp32p4.gpio.base, 0x500e0000);
    assert.equal(chips.esp32c3.gpio.matrixGPIO, 128 | (1 << 9));
    assert.equal(chips.esp32p4.gpio.matrixGPIO, 256 | (1 << 10));
    assert.equal(chips.esp32p4.gpio.matrix, 0x500e0558);
    assert.equal(chips.esp32c3.gpio.matrix, 0x60004554);
    assert.deepEqual(chips.esp32p4.pins.find(pin => pin.id === 12).digitalRoute, [{ address: 0x5012b038, mask: 16 }]);
});

test('every board maps unique GPIOs present in its chip profile', () => {
    for (const chip of Object.values(chips)) {
        for (const board of [...boards.filter(board => board.chip === chip.id), raw(chip)]) {
            const ids = [...board.pins.map(pin => pin.gpio).filter(id => id !== null), ...(board.extra || [])];
            assert.equal(new Set(ids).size, ids.length, board.id);
            for (const id of ids) assert.ok(chip.pins.some(pin => pin.id === id), `${board.id}: GPIO${id}`);
        }
        for (const pin of chip.pins.filter(pin => !pin.reserved)) {
            assert.ok(Number.isInteger(pin.mux) && pin.mux > 0 && pin.mux % 4 === 0, `${chip.id} / ${pin.id}`);
        }
    }
});

test('S3 board headers match the pictured layouts and keep power pads non-interactive', () => {
    const mini = boards.find(board => board.id === 's3-supermini'), ai = boards.find(board => board.id === 'ai-s3');
    assert.equal(mini.chip, 'esp32s3'); assert.equal(ai.chip, 'esp32s3');
    assert.deepEqual(mini.pins.map(pin => pin.label), ['43', '44', '1', '2', '3', '4', '5', '6', '7', '5V', 'GND', '3V3', '13', '12', '11', '10', '9', '8']);
    assert.equal(mini.pins.filter(pin => pin.gpio !== null).length + mini.back.pins.length, 35);
    assert.equal(ai.pins.length, 44);
    assert.equal(ai.pins.filter(pin => pin.gpio !== null).length, 36);
    assert.deepEqual(ai.pins.slice(0, 3).map(pin => pin.label), ['3V3', '3V3', 'RST']);
    assert.deepEqual(ai.pins.slice(22, 27).map(pin => pin.label), ['GND', '43', '44', '1', '2']);
    for (const board of [mini, ai]) {
        assert.ok(require('node:fs').existsSync(require('node:path').join(__dirname, '..', board.image)));
        for (const pin of board.pins) {
            assert.equal(pin.gpio, /^\d+$/.test(pin.label) ? Number(pin.label) : null);
            assert.ok(pin.x >= board.crop.x && pin.x <= board.crop.x + board.crop.width);
            assert.ok(pin.y >= board.crop.y && pin.y <= board.crop.y + board.crop.height);
        }
    }
});

test('every pictured board provides image dimensions for both thumbnail and pinout rendering', () => {
    for (const board of boards.filter(board => board.image)) {
        assert.ok(Number.isInteger(board.imageSize.width) && board.imageSize.width > 0, board.id);
        assert.ok(Number.isInteger(board.imageSize.height) && board.imageSize.height > 0, board.id);
        assert.ok(board.crop.x + board.crop.width <= board.imageSize.width, board.id);
        assert.ok(board.crop.y + board.crop.height <= board.imageSize.height, board.id);
    }
});

test('GPIO default initialization keeps the output driver disabled and sets input enable', async () => {
    for (const chip of Object.values(chips)) {
        if (chip.readOnlyGPIO) continue;
        const transport = new RecordingTransport(chip);
        const controller = new GPIOController(transport, chip);
        const requested = chip.pins.filter(pin => !pin.reserved).map(pin => pin.id);
        await controller.initialize(requested);
        const pins = requested;
        assert.equal(controller.pins.size, pins.length);
        assert.ok([...controller.pins.values()].every(pin => pin.mode === 'input' && pin.level === null));
        for (const bank of chip.gpio.banks) assert.ok(!transport.writes.some(write => write.address === bank.enableSet));
        for (const id of pins) {
            const desc = chip.pins.find(pin => pin.id === id);
            const mux = transport.registers.get(desc.mux);
            assert.equal(mux & chip.gpio.muxMask, chip.gpio.muxGPIO);
            assert.equal((transport.registers.get(chip.gpio.matrix + id * 4) || 0) & chip.gpio.matrixMask, chip.gpio.matrixGPIO);
        }
        await controller.close();
    }
});

test('ESP8266 reads GPIO0-15 and RTC GPIO16 without configuring pins', async () => {
    const chip = chips.esp8266, transport = new RecordingTransport(chip);
    const controller = new GPIOController(transport, chip);
    await controller.initialize([0, 5, 16]);
    assert.ok([...controller.pins.values()].every(pin => pin.mode === 'observe'));
    transport.reads = [];
    transport.read = async address => {
        transport.reads.push(address);
        return address === 0x6000078c ? 1 : (1 << 5);
    };
    await controller.sample();
    assert.deepEqual(transport.reads, [0x60000318, 0x6000078c]);
    assert.deepEqual([0, 5, 16].map(id => controller.pins.get(id).read), [0, 1, 1]);
    assert.equal(transport.writes.length, 0);
    await controller.close();
});

test('output preloads LOW/HIGH before enabling the driver, including P4 GPIO54', async () => {
    for (const [chip, id] of [[chips.esp32c3, 0], [chips.esp32c6, 3], [chips.esp32p4, 54]]) {
        const transport = new RecordingTransport(chip), controller = new GPIOController(transport, chip);
        const bank = chip.gpio.banks[Math.floor(id / 32)], mask = 2 ** (id % 32);
        await controller.configure(id, 'output', 'up', 1);
        assert.equal(transport.writes[0].address, bank.enableClear);
        assert.deepEqual(transport.writes.slice(-2).map(write => [write.address, write.value]), [[bank.set, mask], [bank.enableSet, mask]]);
        await controller.setLevel(id, 0);
        assert.equal(transport.writes.at(-1).address, bank.clear);
        assert.equal(transport.writes.at(-1).value, mask);
        await controller.sample(); assert.equal(controller.pins.get(id).read, 0);
        await controller.close();
    }
});

test('masking preserves unrelated IO MUX and RTC bits', async () => {
    const chip = chips.esp32c6, desc = chip.pins.find(pin => pin.id === 0);
    const transport = new RecordingTransport(chip), controller = new GPIOController(transport, chip);
    transport.registers.set(desc.mux, 0x80008800);
    const route = desc.digitalRoute[0]; transport.registers.set(route.address, 0xff);
    await controller.configure(0, 'input', 'up');
    assert.equal(transport.registers.get(desc.mux) >>> 31, 1);
    assert.equal(transport.registers.get(desc.mux) & 0x8800, 0x8800);
    assert.equal(transport.registers.get(route.address), 0xfe);
    await controller.close();
});

test('drive levels preserve unrelated mux bits, output level and later pull/mode changes on every writable chip', async () => {
    for (const chip of Object.values(chips).filter(chip => !chip.readOnlyGPIO)) {
        const pin = chip.pins.find(pin => !pin.reserved && pin.output && pin.pulls);
        const transport = new RecordingTransport(chip), controller = new GPIOController(transport, chip);
        const original = 0x80000800;
        transport.registers.set(pin.mux, original);
        await controller.initialize([pin.id]);
        assert.equal(controller.pins.get(pin.id).driveStrength, 2, chip.id);
        for (const strength of [0, 3, 1, 2]) {
            transport.writes = [];
            await controller.configure(pin.id, 'output', 'none', 1, strength);
            assert.equal((transport.registers.get(pin.mux) >>> 10) & 3, strength, chip.id);
            assert.equal(transport.registers.get(pin.mux) >>> 31, 1, chip.id);
            const writes = transport.writes, bank = chip.gpio.banks[Math.floor(pin.id / 32)];
            assert.equal(writes[0].address, bank.enableClear);
            assert.equal(writes.at(-1).address, bank.enableSet);
            await controller.configure(pin.id, 'output', 'up', 1);
            assert.equal(controller.pins.get(pin.id).level, 1);
            await controller.configure(pin.id, 'input', 'down');
            assert.equal(controller.pins.get(pin.id).driveStrength, strength, chip.id);
            assert.equal((transport.registers.get(pin.mux) >>> 10) & 3, strength, chip.id);
        }
        await controller.close();
    }
});

test('C6 drive strength follows the ADC LP mux and returns to the digital HP mux', async () => {
    const chip = chips.esp32c6, transport = new RecordingTransport(chip), controller = new GPIOController(transport, chip);
    const pin = chip.pins.find(pin => pin.id === 3), route = controller.adc.profile.padRoute;
    const lpMux = route.mux + pin.id * 4;
    transport.registers.set(lpMux, 0x80000400);
    await controller.configure(pin.id, 'output', 'up', 1, 3);
    await controller.setReadMode('adc');
    assert.equal((transport.registers.get(lpMux) >>> 10) & 3, 3);
    await controller.configure(pin.id, 'output', 'down', 1, 0);
    assert.equal(transport.registers.get(lpMux) >>> 31, 1);
    assert.equal((transport.registers.get(lpMux) >>> 10) & 3, 0);
    await controller.setReadMode('digital');
    assert.equal((transport.registers.get(pin.mux) >>> 10) & 3, 0);
    assert.equal(controller.pins.get(pin.id).driveStrength, 0);
    assert.equal(controller.pins.get(pin.id).level, 1);
    assert.equal(transport.registers.get(lpMux) >>> 0, 0x80000400);
    await controller.close();
});

test('invalid drive levels, input-only pins and classic mode issue no drive writes', async () => {
    for (const [id, strength, readOnly] of [[0, -1], [0, 4], [0, 1.5], [0, '2'], [34, 2], [0, 2, true]]) {
        const transport = new RecordingTransport(chips.esp32), controller = new GPIOController(transport, chips.esp32, { readOnly });
        await assert.rejects(controller.configure(id, 'input', 'none', 0, strength));
        assert.equal(transport.writes.length, 0);
        await controller.close();
    }
});

test('input-only and invalid pin requests do not issue writes', async () => {
    const chip = chips.esp32, transport = new RecordingTransport(chip), controller = new GPIOController(transport, chip);
    for (const [id, mode, pull] of [[34, 'output', 'none'], [34, 'input', 'up'], [99, 'input', 'none'], [0, 'spi', 'none']]) {
        await assert.rejects(controller.configure(id, mode, pull));
    }
    assert.equal(transport.writes.length, 0);
    await controller.close();
});

test('reserved pins are only observed on initialize/release but can be configured explicitly', async () => {
    const chip = chips.esp32, transport = new RecordingTransport(chip), controller = new GPIOController(transport, chip);
    assert.ok(chip.pins.find(pin => pin.id === 6).reserved);
    await controller.initialize([6]);
    assert.equal(controller.pins.get(6).mode, 'observe');
    assert.equal(transport.writes.length, 0);
    await controller.sample();
    assert.notEqual(controller.pins.get(6).read, null);
    await controller.release();
    assert.equal(transport.writes.length, 0);
    await controller.initialize([6]);
    await controller.configure(6, 'output', 'none', 1);
    assert.equal(controller.pins.get(6).mode, 'output');
    assert.ok(transport.writes.length > 0);
    await controller.release(); await controller.close();
});

test('input readback is independent of the requested output, with one read per bank', async () => {
    const chip = chips.esp32p4, transport = new RecordingTransport(chip), controller = new GPIOController(transport, chip);
    await controller.initialize([0, 1, 54]);
    await controller.configure(54, 'output', 'none', 1);
    transport.reads = [];
    transport.read = async address => { transport.reads.push(address); return 0; };
    await controller.sample();
    assert.deepEqual(transport.reads, chip.gpio.banks.map(bank => bank.input));
    assert.equal(controller.pins.get(54).read, 0);
    assert.equal(controller.pins.get(54).level, 1);
    const sample = controller.pins.get(54).history.samples.at(-1);
    assert.equal(sample.drive, 1); assert.equal(sample.read, 0);
    await controller.close();
});

test('releasing a board disables its managed output drivers before clearing states', async () => {
    const chip = chips.esp32c3, transport = new RecordingTransport(chip), controller = new GPIOController(transport, chip);
    await controller.initialize([0, 1]); await controller.configure(0, 'output');
    transport.writes = []; await controller.release();
    assert.deepEqual(transport.writes.map(write => [write.address, write.value]), [[chip.gpio.banks[0].enableClear, 1], [chip.gpio.banks[0].enableClear, 2]]);
    assert.equal(controller.pins.size, 0); await controller.close();
});

test('polling stops after a transport failure and cannot silently resume', async () => {
    const chip = chips.esp32c3, transport = new RecordingTransport(chip);
    let resolveError; const failed = new Promise(resolve => { resolveError = resolve; });
    const controller = new GPIOController(transport, chip, { onError: resolveError });
    await controller.initialize([0]); let reads = 0;
    transport.read = async () => { reads++; throw new Error('USB disconnected'); };
    controller.start(1); assert.equal((await failed).message, 'USB disconnected');
    assert.equal(controller.running, false); assert.equal(controller.fault, true);
    controller.start(1); await controller.pause(); assert.equal(reads, 1); await controller.close();
});

test('partial configuration failure keeps driver disabled, invalidates old state and halts polling', async () => {
    const chip = chips.esp32c3, transport = new RecordingTransport(chip), controller = new GPIOController(transport, chip);
    await controller.configure(0, 'output');
    const write = transport.write.bind(transport);
    transport.write = async (...args) => { if (args[0] === chip.pins[0].mux) throw new Error('WRITE_REG error'); return write(...args); };
    await assert.rejects(controller.configure(0, 'output', 'up', 1), /WRITE_REG error/);
    assert.equal(transport.registers.get(chip.gpio.banks[0].enable) & 1, 0);
    assert.equal(controller.pins.get(0).mode, 'unknown'); assert.equal(controller.fault, true);
    await controller.close();
});

test('history retains the boundary state and command timestamps without fabricated readback', () => {
    const history = new History();
    history.push(0, 0); history.push(500, 1); history.push(900, null, 1); history.push(1000, 0, 1); history.push(1600, 1, 1);
    assert.deepEqual(history.samples.map(sample => sample.t), [500, 900, 1000, 1600]);
    assert.equal(history.samples[1].read, null);
    for (let index = 0; index < 10000; index++) history.push(1700, 1);
    assert.ok(history.samples.length <= 4096);
});

test('register adapter emits masked WRITE_REG and rejects failed or malformed ACKs', async () => {
    const packets = [];
    const flasher = { stubLoaded: true, buildCommandPacketU32: (...args) => args,
        executeCommand: async (packet, callback) => { packets.push(packet); return new Promise((resolve, reject) => callback(resolve, reject, { value: 0x80000000, data: Uint8Array.of(0, 0) })); } };
    const transport = new RegisterTransport(flasher);
    await transport.write(0x60009004, 0x1200, 0x7000);
    assert.deepEqual(packets[0], [0x09, 0x60009004, 0x1200, 0x7000, 0]);
    assert.equal(await transport.read(0x6000403c), 0x80000000);
    for (const data of [Uint8Array.of(1, 0xc2), Uint8Array.of(0), Uint8Array.of(0, 0xff)]) {
        flasher.executeCommand = async (_, callback) => new Promise((resolve, reject) => callback(resolve, reject, { value: 0, data }));
        await assert.rejects(transport.write(0x60009004, 0));
    }
    transport.close(); await assert.rejects(transport.read(0x6000403c), /geschlossen/);
});

test('classic GPIO logging uses the existing flasher queue and SLIP parser without writes', async () => {
    const flasher = new ESPFlasher(), chip = chips.esp32c3;
    const device = new DemoTransport(chip);
    flasher.port = { writable: {} }; flasher.stubLoaded = true;
    const opcodes = [];
    flasher._writeFrame = async frame => {
        assert.equal(frame[0], 0xc0); assert.equal(frame.at(-1), 0xc0);
        const bytes = [];
        for (let index = 1; index < frame.length - 1; index++) {
            if (frame[index] === 0xdb) bytes.push(frame[++index] === 0xdc ? 0xc0 : 0xdb);
            else bytes.push(frame[index]);
        }
        const packet = Uint8Array.from(bytes), view = new DataView(packet.buffer);
        const command = packet[1], address = view.getUint32(8, true);
        opcodes.push(command);
        let value = 0;
        if (command === 0x0a) value = await device.read(address);
        else if (command === 0x09) await device.write(address, view.getUint32(12, true), view.getUint32(16, true));
        else assert.fail(`Unexpected command 0x${command.toString(16)}`);
        const response = new Uint8Array(10), responseView = new DataView(response.buffer);
        response[0] = 1; response[1] = command; responseView.setUint16(2, 2, true); responseView.setUint32(4, value, true);
        await flasher.processPacket(response);
    };
    const controller = new GPIOController(new RegisterTransport(flasher), chip);
    await controller.initialize([0]);
    await controller.sample(); assert.ok([0, 1].includes(controller.pins.get(0).read));
    await assert.rejects(controller.configure(0, 'output', 'none', 1));
    await assert.rejects(controller.setLevel(0, 0));
    assert.ok(opcodes.includes(0x0a)); assert.ok(!opcodes.includes(0x09));
    await controller.release(); await controller.close();
});
