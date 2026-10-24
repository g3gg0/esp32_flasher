'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const chips = require('../configs/chips.js');
const { GPIOController, DemoTransport } = require('../gpio.js');
const { SDHost, sdProfiles, decodeCID, decodeCSD, sectorRange } = require('../sd.js');
const pins = { d0: 4, d1: 5, d2: 6, d3: 14, cmd: 15, clk: 16 };
async function fixture(width = 1, chipId = 'esp32p4') {
    const transport = new DemoTransport(chips[chipId]), c = new GPIOController(transport, chips[chipId]);
    await c.initialize(Object.values(pins));
    const log = [], host = new SDHost(c, { onCommand: entry => log.push(entry), timeoutMs: 25 });
    return { c, transport, host, log, config: { pins: width === 1 ? { d0: pins.d0, cmd: pins.cmd, clk: pins.clk } : pins, width } };
}

test('S3 SDMMC recipe uses the native host, slot-1 signal IDs and PLL160M clock fields', () => {
    const p = sdProfiles.esp32s3, r = p.registers;
    assert.equal(p.backend, 'sdmmc'); assert.equal(p.slot, 1);
    assert.equal(r.control, 0x60028000); assert.equal(r.command, 0x6002802c);
    assert.equal(r.events, 0x60028044); assert.equal(r.status, 0x60028048);
    assert.equal(r.descriptorList, 0x60028088); assert.equal(r.transferred, 0x60028060);
    assert.deepEqual(p.init, [{ address: 0x600c001c, value: 128, mask: 128 }, { address: 0x600c0024, value: 0, mask: 128 }]);
    assert.deepEqual(p.reset, { address: 0x600c0024, value: 128, mask: 128 });
    assert.equal(p.hostClock.address, 0x60028800);
    const clock = p.hostClock.value, hostDivider = ((clock >>> 13) & 15) + 1;
    assert.equal(clock >>> 23 & 1, 1); // PLL160M, not XTAL
    assert.equal(hostDivider, 10);
    assert.equal(clock >>> 9 & 15, 4); assert.equal(clock >>> 17 & 15, 9);
    assert.equal(clock & 511, 1); // dout 90 degrees, din/core 0
    assert.equal(160000000 / hostDivider / (2 * p.cardDivider), 400000);
    assert.equal(p.matrix.inputBase, 0x60004154);
    assert.deepEqual(p.matrix.signals, { clk: 173, cmd: 179, d0: 213, d1: 214, d2: 215, d3: 216 });
    assert.equal(p.matrix.detect, 195); assert.equal(p.matrix.writeProtect, 197); assert.equal(p.matrix.cardInterrupt, 199);
    assert.equal(p.matrix.constantHigh, 0x38); assert.equal(p.matrix.constantLow, 0x3c);
    assert.deepEqual(p.dmaBuffer, { address: 0x3fcc0000, cpuOffset: 0 }); assert.equal(p.fifo.countMask, 0x3ffe0000);
    assert.equal(p.onboardPower, undefined); assert.equal(p.latchClock, undefined);
});

test('S3 SD identifies and reads exact sectors in native 1/4-bit mode, including legacy byte addresses', async () => {
    for (const width of [1, 4]) for (const legacy of [false, true]) {
        const { c, host, config, transport, log } = await fixture(width, 'esp32s3');
        transport.sdModel.legacy = legacy;
        const r = host.profile.registers, writes = [], write = transport.write.bind(transport);
        transport.registers.set(r.control, 1 << 5 | 1 << 25);
        transport.write = async (address, value, mask) => { writes.push({ address, value, mask }); return write(address, value, mask); };
        await host.open(config);
        assert.equal(transport.registers.get(r.control) & (1 << 4 | 1 << 5 | 1 << 25), 0);
        assert.equal(transport.registers.get(r.clockDivider) >>> 8 & 255, 20);
        assert.equal(transport.registers.get(r.clockSource) >>> 2 & 3, 1);
        assert.equal(transport.registers.get(0x60004154 + 179 * 4), pins.cmd | 128);
        assert.equal(transport.registers.get(c.chip.gpio.matrix + pins.clk * 4), 173);
        assert.equal(writes.some(op => op.address >= 0x50000000 && op.address < 0x60000000), false, 'no P4 LDO or clock accesses');
        const resetIndex = writes.findIndex(op => op.address === 0x600c0024 && op.value === 128);
        assert.ok(writes.findIndex(op => op.address === 0x60028800) > resetIndex, 'configure host clock after system reset');
        const card = await host.identify();
        assert.equal(card.width, width); assert.equal(card.clockHz, 400000);
        assert.equal(card.type, legacy ? 'SDSC' : 'SDHC / SDXC');
        assert.equal(card.csd.capacityBytes, legacy ? 2 ** 30 : 8 * 2 ** 30);
        assert.equal(card.cid.serial, '0x12345678');
        assert.ok(log.filter(entry => entry.command === 'ACMD41').every(entry => entry.responseType === 'r3'));
        assert.ok(transport.sdModel.commands.every(cmd => (cmd.value >>> 16 & 31) === 1));
        if (width === 4) {
            assert.ok(log.some(entry => entry.command === 'ACMD6'));
            assert.equal(transport.registers.get(c.chip.gpio.matrix + pins.d3 * 4), 216);
        }
        const chunks = [], progress = [];
        await host.download({ start: 3, end: 4, write: async data => chunks.push(data), onProgress: value => progress.push(value) });
        assert.equal(chunks.length, 2);
        for (let sector = 0; sector < 2; sector++) {
            assert.equal(chunks[sector].byteLength, 512);
            for (let byte = 0; byte < 512; byte++) assert.equal(chunks[sector][byte], ((sector + 3) * 17 + byte) & 255);
        }
        assert.deepEqual(transport.sdModel.commands.filter(cmd => cmd.index === 17).map(cmd => cmd.argument), legacy ? [1536, 2048] : [3, 4]);
        assert.equal(progress.at(-1).bytesWritten, 1024);
        assert.equal(transport.sdModel.commands.some(cmd => [24, 25, 32, 33, 38].includes(cmd.index)), false);
        await c.release(); assert.equal(c.pinOwners.size, 0); await c.close();
    }
});

test('S3 SD leases suspend GPIO/ADC scans and restore pin, DMA and clock state without clobbering other bits', async () => {
    const { c, host, config, transport } = await fixture(4, 'esp32s3'), p = host.profile, g = c.chip.gpio;
    await c.configure(4, 'output', 'down', 1); await c.setReadMode('adc');
    transport.registers.set(p.hostClock.address, 0x20200000);
    transport.registers.set(p.registers.control, 1 << 5 | 1 << 25);
    const original = new Map(transport.registers);
    const write = transport.write.bind(transport);
    transport.write = async (address, value, mask) => {
        await write(address, value, mask);
        if (address === p.reset.address && value & p.reset.mask) transport.registers.set(p.hostClock.address, 0);
    };
    await host.open(config);
    await assert.rejects(c.configure(4, 'output'), /SD/);
    await assert.rejects(c.scanUsage([4]), /Peripheriezuordnung/);
    await c.sample(); assert.equal(c.pins.get(4).adcRaw, null);
    const saved = new Map(host.saved);
    transport.registers.set(p.hostClock.address, transport.registers.get(p.hostClock.address) | 1 << 30);
    await host.close();
    for (const [address, field] of saved) assert.equal(((transport.registers.get(address) || 0) & field.mask) >>> 0,
        ((original.get(address) || 0) & field.mask) >>> 0, address.toString(16));
    assert.ok(transport.registers.get(p.hostClock.address) & 1 << 30);
    assert.equal(c.pins.get(4).mode, 'output'); assert.equal(c.pins.get(4).pull, 'down');
    assert.ok(transport.registers.get(g.banks[0].enable) & 1 << 4);
    assert.equal(c.pinOwners.size, 0); await c.release(); await c.close();
});

test('S3 partial SD initialization and failed restoration release leases and never re-enable an unsafe output', async () => {
    for (const restorationFails of [false, true]) {
        const { c, host, config, transport } = await fixture(4, 'esp32s3');
        await c.configure(4, 'output', 'up', 1);
        const write = transport.write.bind(transport), target = c.descriptor(15).mux;
        let injected = false;
        transport.write = async (address, value, mask) => {
            if (address === target && (!injected || restorationFails)) { injected = true; throw new Error('Injected S3 SD setup failure'); }
            return write(address, value, mask);
        };
        await assert.rejects(host.open(config));
        assert.equal(host.ready, false); assert.equal(c.pinOwners.size, 0);
        assert.equal(c.fault, restorationFails);
        assert.equal(!!(transport.registers.get(c.chip.gpio.banks[0].enable) & 1 << 4), !restorationFails);
        assert.equal(c.pins.get(4).mode, restorationFails ? 'unknown' : 'output');
        transport.write = write; await c.release(); await c.close();
    }
});

test('S3 rejects P4 onboard power and reserved/duplicate pins before register writes', async () => {
    const { c, host, config, transport } = await fixture(4, 'esp32s3');
    let writes = 0; const write = transport.write.bind(transport);
    transport.write = async (...args) => { writes++; return write(...args); };
    for (const bad of [
        { ...config, power: 'p4-eth' },
        { ...config, pins: { ...pins, clk: 19 } },
        { ...config, pins: { ...pins, cmd: 43 } },
        { ...config, pins: { ...pins, d0: 4, d1: 4 } },
        { ...config, pins: { d0: 4, cmd: 15, clk: 16 } },
    ]) await assert.rejects(host.open(bad));
    assert.equal(writes, 0); await c.release(); await c.close();
});

test('S3 response/data errors reject stale results and keep invalid sectors out of the download', async () => {
    for (const failure of ['absent', 'crcError', 'stuckStart', 'dataCRCError', 'dataTimeout', 'shortData']) {
        const { c, host, config, transport } = await fixture(1, 'esp32s3');
        await host.open(config);
        if (failure.startsWith('data') || failure === 'shortData') {
            await host.identify(); transport.sdModel[failure] = true;
            let written = 0;
            await assert.rejects(host.download({ start: 0, end: 0, write: async () => { written++; } }), /CRC|Timeout|DMA/);
            assert.equal(written, 0);
        } else {
            transport.registers.set(host.profile.registers.events, 4);
            transport.registers.set(host.profile.registers.response, 0xdeadbeef);
            if (failure === 'absent') transport.sdModel.present = false;
            else transport.sdModel[failure] = true;
            await assert.rejects(host.identify(), /Timeout|CRC/);
            assert.equal(host.card, null);
        }
        assert.equal(host.needsReset, true);
        transport.sdModel.present = true; transport.sdModel[failure] = false;
        assert.equal((await host.identify()).cid.product, 'DEMO4');
        await c.release(); await c.close();
    }
});

test('S3 download cancellation releases all SD pins and restores the prior GPIO output', async () => {
    const { c, host, config } = await fixture(4, 'esp32s3'), cancel = new AbortController(), chunks = [];
    await c.configure(4, 'output', 'up', 1);
    await host.open(config); await host.identify();
    await assert.rejects(host.download({ start: 1, end: 4, signal: cancel.signal,
        write: async data => { chunks.push(data); cancel.abort(); } }), { name: 'AbortError' });
    assert.equal(chunks.length, 1); assert.equal(chunks[0].byteLength, 512);
    assert.equal(host.ready, false); assert.equal(c.pinOwners.size, 0); assert.equal(c.fault, false);
    assert.equal(c.pins.get(4).mode, 'output'); assert.equal(c.pins.get(4).level, 1);
    await c.release(); await c.close();
});

test('P4 SD identification uses native slot 1, fresh raw status, R3 without CRC and 80 initialization clocks', async () => {
    const { c, transport, host, log, config } = await fixture();
    await host.open(config);
    const card = await host.identify(), commands = transport.sdModel.commands;
    assert.deepEqual(commands.map(cmd => cmd.index), [0, 8, 55, 41, 55, 41, 2, 3, 9, 7, 13]);
    assert.deepEqual(card.cid, { manufacturer: 3, oem: 'SD', product: 'DEMO4', revision: '1.2', serial: '0x12345678', year: 2025, month: 10 });
    assert.equal(card.csd.capacityBytes, 8 * 2 ** 30);
    assert.equal(card.rca, 0x1234); assert.equal(card.width, 1); assert.equal(card.clockHz, 400000);
    const p = sdProfiles.esp32p4, r = p.registers;
    assert.equal(transport.registers.get(r.clockDivider) >>> 8 & 255, 100);
    assert.equal(transport.registers.get(r.clockSource) >>> 2 & 3, 1);
    assert.equal(transport.registers.get(p.matrix.inputBase + 4), 15 | 128);
    assert.equal(transport.registers.get(c.chip.gpio.matrix + 16 * 4) & 0xfff, 0); // clock signal is index 0
    assert.ok(commands[0].value & 1 << 15);
    for (const cmd of commands) {
        assert.equal(cmd.value >>> 16 & 31, 1);
        assert.ok(cmd.value & 1 << 29); // hold register
        assert.equal(cmd.value & (1 << 9 | 1 << 10), 0); // no data transfers / card writes
        if (cmd.index === 41) { assert.equal(cmd.value & 1 << 8, 0); assert.ok(cmd.app); }
        if ([2, 9].includes(cmd.index)) assert.ok(cmd.value & 1 << 7);
    }
    assert.ok(log.every(entry => !entry.error && entry.finishedAt >= entry.startedAt));
    await c.release(); assert.equal(host.ready, false); assert.equal(c.pinOwners.size, 0); await c.close();
});

test('P4 SD four-bit negotiation occurs after selection and D3 stays GPIO HIGH until ACMD6', async () => {
    const { c, transport, host, config } = await fixture(4), g = c.chip.gpio, r = host.profile.registers;
    const write = transport.write.bind(transport), phase = [];
    transport.write = async (address, value, mask) => {
        if (address === r.command && value & host.profile.flags.start && !(value & host.profile.flags.clockUpdate)) phase.push({ cmd: value & 63,
            width: transport.registers.get(r.width) || 0, route: transport.registers.get(g.matrix + pins.d3 * 4),
            d3: (transport.registers.get(g.banks[0].output) || 0) & (1 << pins.d3) });
        return write(address, value, mask);
    };
    await host.open(config); const card = await host.identify();
    assert.equal(card.width, 4); assert.equal(transport.sdModel.width, 4);
    assert.ok(phase.filter(p => p.cmd !== 13).every(p => p.route === g.matrixGPIO && p.d3));
    assert.equal(phase.find(p => p.cmd === 6).width & 2, 0);
    assert.equal(phase.at(-1).width & 2, 2);
    assert.equal(phase.at(-1).route, 5);
    assert.equal(transport.sdModel.commands.find(cmd => cmd.index === 6).app, true);
    await host.identify(); // second initialization must return D3 to HIGH before CMD0
    assert.equal(phase.filter(p => p.cmd === 0).at(-1).route, g.matrixGPIO);
    await c.release(); await c.close();
});

test('SD leases prevent GPIO/scan conflicts, skip ADC sampling and restore original GPIO and shared fields', async () => {
    const { c, transport, host, config } = await fixture(4), g = c.chip.gpio;
    await c.configure(4, 'output', 'down', 1);
    await c.setReadMode('adc');
    const original = new Map(transport.registers);
    await host.open(config);
    assert.equal(c.pinOwners.size, 6);
    await assert.rejects(c.configure(4, 'output'), /SD/);
    await assert.rejects(c.scanUsage([4]), /Peripheriezuordnung/);
    assert.equal(c.fault, false);
    await c.sample(); assert.equal(c.pins.get(16).adcRaw, null);
    const bank = g.banks[0];
    transport.registers.set(bank.enable, (transport.registers.get(bank.enable) || 0) | 1 << 17);
    const modified = [...host.saved.keys()];
    await host.close();
    for (const address of modified) {
        const actual = transport.registers.get(address) || 0, expected = original.get(address) || 0;
        assert.equal((actual & ~(address === bank.enable ? 1 << 17 : 0)) >>> 0, expected, address.toString(16));
    }
    assert.ok(transport.registers.get(bank.enable) & 1 << 17);
    assert.equal(c.pins.get(4).mode, 'output'); assert.equal(c.pins.get(4).level, 1);
    assert.equal(c.pins.get(4).pull, 'down'); assert.equal(c.pinOwners.size, 0);
    await c.release(); await c.close();
});

test('invalid SD pin assignments and unsupported chips issue no writes', async () => {
    const { c, transport, host, config } = await fixture(); let count = 0;
    const write = transport.write.bind(transport); transport.write = async (...args) => { count++; return write(...args); };
    for (const bad of [
        { ...config, pins: { cmd: 15, clk: 16 } },
        { ...config, pins: { d0: 4, cmd: 4, clk: 16 } },
        { ...config, pins: { d0: 24, cmd: 15, clk: 16 } },
        { ...config, pins: { d0: 17, cmd: 15, clk: 16 } },
        { ...config, width: 4 }, { ...config, width: 8 },
    ]) await assert.rejects(host.open(bad));
    assert.equal(count, 0);
    const other = new GPIOController(new DemoTransport(chips.esp32c6), chips.esp32c6);
    await other.initialize([0, 1, 2]);
    await assert.rejects(new SDHost(other).open({ width: 1, pins: { d0: 0, cmd: 1, clk: 2 } }), /noch nicht implementiert/);
    await other.release(); await other.close(); await c.close();
});

test('missing card, CRC error and stale DONE never produce a false identification', async () => {
    for (const failure of ['absent', 'crc', 'stuck']) {
        const { c, transport, host, config, log } = await fixture(); await host.open(config);
        const r = host.profile.registers;
        transport.registers.set(r.events, 4); transport.registers.set(r.response, 0xdeadbeef);
        if (failure === 'absent') transport.sdModel.present = false;
        if (failure === 'crc') transport.sdModel.crcError = true;
        if (failure === 'stuck') transport.sdModel.stuckStart = true;
        await assert.rejects(host.identify(), /Timeout|CRC/);
        assert.equal(host.card, null); assert.ok(log.some(entry => entry.error));
        assert.ok(log.filter(entry => entry.error).every(entry => entry.response === undefined));
        transport.sdModel.present = true; transport.sdModel.crcError = false; transport.sdModel.stuckStart = false;
        assert.equal((await host.identify()).cid.product, 'DEMO4'); // explicit re-identification resets host
        await c.release(); await c.close();
    }
});

test('legacy SD ignores only CMD8 response timeout and omits HCS in ACMD41', async () => {
    const { c, transport, host, config } = await fixture(); transport.sdModel.legacy = true;
    await host.open(config); const card = await host.identify();
    assert.equal(card.type, 'SDSC'); assert.equal(card.csd.capacityBytes, 2 ** 30);
    assert.ok(transport.sdModel.commands.filter(cmd => cmd.index === 41).every(cmd => !(cmd.argument & 0x40000000)));
    await c.release(); await c.close();
});

test('SD cancellation releases leases and restores the original output without faulting GPIO', async () => {
    const { c, host, config } = await fixture(), cancel = new AbortController();
    await c.configure(4, 'output', 'up', 1); await host.open(config);
    host.onCommand = entry => { if (entry.command === 'CMD2') cancel.abort(); };
    await assert.rejects(host.identify(cancel.signal), { name: 'AbortError' });
    assert.equal(host.ready, false); assert.equal(c.pinOwners.size, 0); assert.equal(c.fault, false);
    assert.equal(c.pins.get(4).mode, 'output'); assert.equal(c.pins.get(4).level, 1);
    await c.release(); await c.close();
});

test('partial SD setup is restored, and a restore failure leaves the original output disabled', async () => {
    for (const restorationFails of [false, true]) {
        const { c, transport, host, config } = await fixture(), g = c.chip.gpio;
        await c.configure(4, 'output', 'up', 1);
        const write = transport.write.bind(transport), target = c.descriptor(15).mux;
        let injected = false;
        transport.write = async (address, value, mask) => {
            if (address === target && (!injected || restorationFails)) { injected = true; throw new Error('Injected register failure'); }
            return write(address, value, mask);
        };
        await assert.rejects(host.open(config));
        assert.equal(host.ready, false); assert.equal(c.pinOwners.size, 0);
        assert.equal(c.fault, restorationFails);
        assert.equal(!!(transport.registers.get(g.banks[0].enable) & 1 << 4), !restorationFails);
        assert.equal(c.pins.get(4).mode, restorationFails ? 'unknown' : 'output');
        transport.write = write; await c.release(); await c.close();
    }
});

test('SD response decoding handles both SD CSD formats and full-width serial numbers', () => {
    const words = value => Array.from({ length: 4 }, (_, i) => Number(value >> BigInt(32 * i) & 0xffffffffn));
    assert.equal(decodeCSD(words(1n << 126n | 0x3fffffn << 48n)).capacityBytes, 2 ** 41);
    assert.equal(decodeCSD(words(4095n << 62n | 7n << 47n | 9n << 80n)).capacityBytes, 2 ** 30);
    assert.equal(decodeCSD(words(2n << 126n)).capacityBytes, null);
    assert.equal(decodeCID(words(0xffffffffn << 24n)).serial, '0xffffffff');
});

test('P4-ETH preset enables LDO4 rail bypass and active-low GPIO45, then restores both', async () => {
    const board = require('../configs/boards.js').boards.find(board => board.id === 'p4-eth');
    const transport = new DemoTransport(chips.esp32p4), c = new GPIOController(transport, chips.esp32p4);
    const cfg = { ...board.sd, width: 4 }, host = new SDHost(c);
    await c.initialize([39, 40, 41, 42, 43, 44, 45]);
    const [ana, ldo] = host.profile.onboardPower;
    // H2/P4 PMU layout is not interchangeable: P4 VO4 is PMU.ext_ldo[4].
    assert.equal(ldo.address, 0x501151d8);
    const oldLDO = 0x40000020, oldANA = 0xa1000000;
    transport.registers.set(ldo.address, oldLDO); transport.registers.set(ana.address, oldANA);
    await host.open(cfg);
    assert.equal(c.pinOwners.get(45), 'SD');
    assert.equal((transport.registers.get(ldo.address) & ldo.mask) >>> 0, 0x4180); // rail, software owner, xpd; tieh_sel=0
    assert.equal(transport.registers.get(ana.address) & 1 << 26, 1 << 26);
    const bank = c.chip.gpio.banks[1], bit = 1 << (45 - 32);
    assert.ok(transport.registers.get(bank.enable) & bit);
    assert.equal((transport.registers.get(bank.output) || 0) & bit, 0);
    assert.equal((await host.identify()).width, 4);
    await host.close();
    assert.equal(transport.registers.get(ldo.address), oldLDO);
    assert.equal(transport.registers.get(ana.address), oldANA);
    assert.equal((transport.registers.get(bank.enable) || 0) & bit, 0);
    assert.equal(c.pinOwners.size, 0);
    await c.release(); await c.close();
});

test('SD sector ranges default to 0-max, include both endpoints and reject out-of-card access', () => {
    const card = { csd: { capacityBytes: 8 * 2 ** 30 } };
    assert.equal(sectorRange(card).sectors, 16777216);
    assert.deepEqual(sectorRange(card, '17', '17'), { start: 17, end: 17, sectors: 1, bytes: 512, maximum: 16777215 });
    assert.equal(sectorRange(card, 16777215, 'max').bytes, 512);
    for (const [start, end] of [[-1, 1], [2, 1], [0, 16777216], ['1.2', 5], ['', 5], [0, 'garbage']]) assert.throws(() => sectorRange(card, start, end));
    assert.throws(() => sectorRange({ csd: { capacityBytes: null } }));
});

test('SD DMA dump preserves exact bytes and sector addressing with bounded writes and progress', async () => {
    for (const legacy of [false, true]) {
        const { c, transport, host, config } = await fixture(); transport.sdModel.legacy = legacy;
        await host.open(config); await host.identify();
        const chunks = [], progress = [];
        await host.download({ start: 7, end: 9, write: async data => {
            assert.equal(transport.sdModel.commands.filter(cmd => cmd.index === 17).length, chunks.length + 1, 'next request must wait for sink');
            chunks.push(data); await new Promise(resolve => setTimeout(resolve, 1));
        }, onProgress: p => progress.push(p) });
        assert.equal(chunks.length, 3);
        for (let i = 0; i < 3; i++) for (let byte = 0; byte < 512; byte++) assert.equal(chunks[i][byte], ((7 + i) * 17 + byte) & 255);
        assert.deepEqual(transport.sdModel.commands.filter(cmd => cmd.index === 17).map(cmd => cmd.argument), [7, 8, 9].map(n => legacy ? n * 512 : n));
        assert.equal(progress.at(-1).completed, 3); assert.equal(progress.at(-1).bytesWritten, 1536); assert.equal(progress.at(-1).etaSeconds, 0);
        assert.ok(progress.at(-1).bytesPerSecond > 0);
        assert.equal(transport.sdModel.commands.some(cmd => [24, 25, 32, 33, 38].includes(cmd.index)), false);
        assert.equal(transport.sdModel.commands.some(cmd => cmd.index === 16), legacy);
        await c.release(); await c.close();
    }
});

test('SD dump rejects CRC, timeout and short DMA data before passing a sector to the file sink', async () => {
    for (const failure of ['dataCRCError', 'dataTimeout', 'shortData']) {
        const { c, transport, host, config } = await fixture();
        await host.open(config); await host.identify(); transport.sdModel[failure] = true;
        let writes = 0;
        await assert.rejects(host.download({ start: 0, end: 0, write: async () => { writes++; } }), /CRC|Timeout|DMA/);
        assert.equal(writes, 0); assert.equal(host.needsReset, true);
        await c.release(); await c.close();
    }
});

test('SD dump cancellation retains only complete sectors and frees the SD port', async () => {
    const { c, host, config } = await fixture(), signal = new AbortController(), chunks = [];
    await host.open(config); await host.identify();
    await assert.rejects(host.download({ start: 4, end: 100, signal: signal.signal, write: async data => { chunks.push(data); signal.abort(); } }), { name: 'AbortError' });
    assert.equal(chunks.length, 1); assert.equal(chunks[0].length, 512);
    assert.equal(host.ready, false); assert.equal(c.pinOwners.size, 0); assert.equal(c.fault, false);
    await c.release(); await c.close();
});

test('SD sectors are received by one IDMAC descriptor into the fixed buffer, CPU reads use the alias', async () => {
    for (const chipId of ['esp32p4', 'esp32s3']) {
        const { c, host, transport, config } = await fixture(1, chipId); await host.open(config); await host.identify();
        const r = host.profile.registers, { address, cpuOffset } = host.profile.dmaBuffer, cpu = address + cpuOffset;
        const write = transport.write.bind(transport), read = transport.read.bind(transport), writes = [], reads = [];
        transport.write = (a, v, m) => { writes.push([a, v >>> 0, m]); return write(a, v, m); };
        transport.read = a => { reads.push(a); return read(a); };
        const chunks = []; await host.download({ start: 2, end: 2, write: async data => chunks.push(data) });
        for (let byte = 0; byte < 512; byte++) assert.equal(chunks[0][byte], (2 * 17 + byte) & 255);
        const at = a => writes.findIndex(w => w[0] === a), cmd = writes.findIndex(w => w[0] === r.command && (w[1] & 63) === 17);
        assert.deepEqual(writes.find(w => w[0] === cpu + 4).slice(0, 2), [cpu + 4, 512]);
        assert.deepEqual(writes.find(w => w[0] === cpu + 8).slice(0, 2), [cpu + 8, address + 64]);
        assert.deepEqual(writes.find(w => w[0] === cpu).slice(0, 2), [cpu, 0x8000002e]);
        assert.deepEqual(writes.find(w => w[0] === r.descriptorList).slice(0, 2), [r.descriptorList, address]);
        for (const reg of [cpu, r.descriptorList, r.pollDemand]) assert.ok(at(reg) >= 0 && at(reg) < cmd, 'DMA armed before CMD17');
        assert.ok(writes.some(w => w[0] === r.dma && w[1] === (1 << 7 | 1 << 1)));
        assert.equal(reads.filter(a => a >= cpu + 64 && a < cpu + 576).length, 128);
        if (cpuOffset) assert.equal(reads.some(a => a >= address && a < address + 576), false, 'cached alias never touched by the CPU');
        assert.equal(transport.registers.get(r.dma), 0); assert.equal(transport.registers.get(r.control) & (1 << 5 | 1 << 25), 0);
        await c.release(); await c.close();
    }
});