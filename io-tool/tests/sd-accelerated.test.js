'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const ESPFlasher = require('../../flasher.js');
const chips = require('../configs/chips.js');
const { GPIOController, DemoTransport } = require('../gpio.js');
const { SDHost, SDFileWriter, sdProfiles } = require('../sd.js');
const { AcceleratedTransport, rpcEncode, rpcDecode } = require('../accelerated.js');
const protocol = require('../../stub/protocol.js');

async function fixture({ chipId = 'esp32p4', width = 1, legacy = false, clockHz = 400000 } = {}) {
    const model = new DemoTransport(chips[chipId]), p = sdProfiles[chipId], r = p.registers;
    model.sdModel.legacy = legacy;
    const device = new ESPFlasher({ logMessage() {}, logWarning() {}, logError() {} });
    device.port = { writable: true };
    const decoder = new device.slipLayer.constructor(), traffic = [];
    device._writeFrame = async frame => {
        for (const raw of decoder.decode(frame)) {
            const tag = new TextDecoder().decode(raw.slice(0, 4)); traffic.push({ tag, raw });
            if (tag === 'REGC') {
                const cmd = rpcDecode(raw, 'register_command'); let value = 0;
                if (cmd.operation === 0) value = await model.read(cmd.address);
                else await model.write(cmd.address, cmd.value, cmd.mask, cmd.delay_us);
                await device.processPacket(rpcEncode('register_response', { value })); continue;
            }
            assert.equal(tag, 'SDMC');
            const base = rpcDecode(raw, 'module_command', 'SDMC');
            const result = { operation: base.operation, port: base.port };
            let data = new Uint8Array();
            if (base.operation === 2) {
                const cmd = rpcDecode(raw, 'sdmmc_command'); Object.assign(result, { command: cmd.command, argument: cmd.argument, response_type: cmd.response_type });
                let flags = p.flags.start | p.flags.hold | 1 << 16 | cmd.command;
                flags |= cmd.command === 0 ? p.flags.initialClocks : p.flags.waitData;
                if (cmd.response_type) flags |= p.flags.response;
                if (cmd.response_type === protocol.sdmmcResponseTypes.R2) flags |= p.flags.longResponse;
                if (![0, protocol.sdmmcResponseTypes.R3].includes(cmd.response_type)) flags |= p.flags.crc;
                const b = p.dmaBuffer, cpu = b.address + b.cpuOffset;
                if (cmd.data_bytes) {
                    flags |= p.flags.dataExpected;
                    model.registers.set(cpu, 0x8000001e); model.registers.set(cpu + 4, 512);
                    model.registers.set(cpu + 8, b.address + 64); model.registers.set(cpu + 12, 0);
                    model.registers.set(r.descriptorList, b.address);
                    model.registers.set(r.control, 1 << 5 | 1 << 25); model.registers.set(r.dma, 0x82);
                    model.registers.set(r.transferred, 0);
                }
                await model.write(r.events, 0xffff); await model.write(r.argument, cmd.argument); await model.write(r.command, flags);
                result.events = model.registers.get(r.events) || 0;
                for (let i = 0; i < 4; i++) result[`response${i}`] = model.registers.get(r.response + 4 * i) || 0;
                if (result.events & 256) { result.status = 4; result.sd_error = 1; }
                else if (result.events & 64) { result.status = 5; result.sd_error = 3; }
                else if (cmd.data_bytes) {
                    result.data_events = result.events;
                    result.transferred = model.registers.get(r.transferred) || 0;
                    result.descriptor = model.registers.get(cpu) >>> 0;
                    if (result.events & 128) { result.status = 5; result.sd_error = 4; }
                    else if (result.events & 512) { result.status = 4; result.sd_error = 5; }
                    else if (result.transferred !== 512 || result.descriptor & 0x80000000) { result.status = 5; result.sd_error = 6; }
                    else {
                        data = new Uint8Array(512); const view = new DataView(data.buffer);
                        for (let i = 0; i < 128; i++) view.setUint32(i * 4, model.registers.get(cpu + 64 + 4 * i) || 0, true);
                    }
                }
                if (model.badRPCSize && data.length) data = data.slice(0, 511);
            }
            await device.processPacket(rpcEncode('sdmmc_response', result, 'SDMR', data));
        }
    };
    const transport = new AcceleratedTransport(device);
    transport.identity = { chip: chipId, capabilities: 9, max_packet_length: 1024, protocol_major: 1, protocol_minor: 1 };
    const controller = new GPIOController(transport, chips[chipId]);
    const pins = { d0: 4, d1: 5, d2: 6, d3: 14, cmd: 15, clk: 16 };
    await controller.initialize(Object.values(pins));
    const log = [], host = new SDHost(controller, { onCommand: entry => log.push(entry) });
    await host.open({ width, clockHz, pins: width === 4 ? pins : { d0: pins.d0, cmd: pins.cmd, clk: pins.clk } });
    return { host, controller, model, traffic, log, transport };
}

test('P4/S3 share RPC identification and exact 2-MiB dumps in 1/4-bit mode with bounded file writes', async () => {
    for (const chipId of ['esp32p4', 'esp32s3']) {
    for (const width of [1, 4]) {
        const clockHz = chipId === 'esp32p4' ? 5000000 : 400000;
        const { host, controller, traffic, log, model } = await fixture({ chipId, width, clockHz });
        const card = await host.identify(); assert.equal(card.width, width); assert.equal(host.rpcSD, true);
        assert.equal(card.clockHz, clockHz); assert.equal(model.registers.get(host.profile.registers.clockDivider) >>> 8 & 255, chipId === 'esp32p4' ? 8 : 20);
        const files = [], writer = new SDFileWriter({ write: async data => files.push(data.slice()), close: async () => {} });
        traffic.length = 0;
        const result = await host.download({ start: 17, end: 17 + 4096 - 1, write: data => writer.write(data) });
        await writer.close();
        assert.equal(result.bytesWritten, 2 * 1024 * 1024); assert.equal(writer.saved, result.bytesWritten);
        assert.equal(files.length, 32); assert.ok(files.every(data => data.length === 65536));
        for (let chunk = 0; chunk < files.length; chunk++) for (let byte = 0; byte < files[chunk].length; byte++) {
            const absolute = chunk * 65536 + byte, sector = 17 + Math.floor(absolute / 512);
            assert.equal(files[chunk][byte], (sector * 17 + absolute % 512) & 255);
        }
        assert.equal(traffic.length, 4096); assert.ok(traffic.every(item => item.tag === 'SDMC'));
        assert.ok(log.every(entry => entry.accelerated));
        await host.close(); assert.equal(controller.pinOwners.size, 0); await controller.close();
    }
    }
});

test('RPC SDSC uses byte addresses, including CMD16 before the dump', async () => {
    const { host, controller, traffic } = await fixture({ legacy: true });
    const card = await host.identify(); assert.equal(card.type, 'SDSC'); traffic.length = 0;
    const chunks = [];
    await host.download({ start: 3, end: 4, write: async data => chunks.push(data) });
    const commands = traffic.filter(item => item.tag === 'SDMC').map(item => rpcDecode(item.raw, 'sdmmc_command'));
    assert.deepEqual(commands.map(cmd => [cmd.command, cmd.argument]), [[16, 512], [17, 1536], [17, 2048]]);
    assert.equal(chunks[0][0], 51); assert.equal(chunks[1][0], 68);
    await host.close(); await controller.close();
});

test('RPC errors/short sectors never reach the sink; a card error permits re-identification', async () => {
    for (const flag of ['dataCRCError', 'shortData', 'dataTimeout']) {
        const { host, controller, model } = await fixture(); await host.identify();
        model.sdModel[flag] = true; let writes = 0;
        await assert.rejects(host.download({ start: 0, end: 5, write: async () => { writes++; } }), /RPC/);
        assert.equal(writes, 0); assert.equal(host.needsReset, true);
        model.sdModel[flag] = false; await host.identify(); assert.equal(host.needsReset, false);
        await host.close(); await controller.close();
    }
});

test('RPC cancellation retains a complete prefix and releases all pin leases', async () => {
    const { host, controller } = await fixture(); await host.identify();
    const abort = new AbortController(); let saved = 0;
    await assert.rejects(host.download({ start: 0, end: 99, signal: abort.signal, write: async data => { saved += data.length; abort.abort(); } }), { name: 'AbortError' });
    assert.equal(saved, 512); assert.equal(host.ready, false); assert.equal(controller.pinOwners.size, 0);
    await controller.close();
});

test('a truncated RPC sector closes the session and never writes stale bytes', async () => {
    const { host, controller, model, transport } = await fixture(); await host.identify(); model.badRPCSize = true;
    let writes = 0;
    await assert.rejects(host.download({ start: 0, end: 0, write: async () => { writes++; } }), /length mismatch/);
    assert.equal(writes, 0); assert.equal(transport.closed, true);
    await assert.rejects(host.close()); await controller.close();
});

test('file writer flushes a valid partial tail and truncates failed batches to the acknowledged prefix', async () => {
    let closed = false, truncated;
    const tail = [], writer = new SDFileWriter({ write: async data => tail.push(data.slice()), close: async () => { closed = true; } });
    for (let i = 0; i < 129; i++) await writer.write(new Uint8Array(512).fill(i));
    await writer.close(); assert.deepEqual(tail.map(data => data.length), [65536, 512]); assert.equal(writer.saved, 66048); assert.ok(closed);
    let writes = 0;
    const failed = new SDFileWriter({ write: async () => { if (++writes > 1) throw new Error('disk full'); }, truncate: async size => { truncated = size; }, close: async () => {} });
    for (let i = 0; i < 255; i++) await failed.write(new Uint8Array(512));
    await assert.rejects(failed.write(new Uint8Array(512)), /disk full/);
    await failed.close(); assert.equal(failed.saved, 65536); assert.equal(truncated, 65536);
});
