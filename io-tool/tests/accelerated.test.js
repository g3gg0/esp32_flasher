'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ESPFlasher = require('../../flasher.js');
const protocol = require('../../stub/protocol.js');
const { AcceleratedTransport, RPCError, acceleratedTargets, prepareAccelerated, startAccelerated, rpcEncode, rpcDecode } = require('../accelerated.js');

function identity(chip = 'esp32c3', extra = {}) {
    return rpcEncode('identity', { protocol_major: 1, protocol_minor: 0, max_packet_length: 1024, capabilities: 1, chip, cpu: 'riscv32', cpu_cores: 1, build: '0.1.0', idf: '6.1', ...extra });
}
function fixture(handler) {
    const device = new ESPFlasher({ logMessage() {}, logWarning() {}, logError() {} });
    const decoder = new device.slipLayer.constructor();
    const sent = [];
    device.port = { writable: true };
    device._writeFrame = async frame => {
        for (const packet of decoder.decode(frame)) {
            sent.push(packet);
            const response = await handler(packet, sent.length);
            if (response) await device.processPacket(response);
        }
    };
    return { device, sent, transport: new AcceleratedTransport(device) };
}
const manifest = chip => JSON.parse(fs.readFileSync(path.join(__dirname, '../../stub', chip, 'stub.json'), 'utf8'));
const fetchManifest = value => async () => ({ ok: true, json: async () => structuredClone(value) });

test('JSON-generated codec has an eight-byte SYNC and rejects invalid framing and fields', () => {
    assert.deepEqual(Array.from(rpcEncode('sync')), [83, 89, 78, 67, 8, 0, 0, 0]);
    assert.equal(rpcDecode(identity(), 'identity').chip, 'esp32c3');
    assert.throws(() => rpcEncode('register_command', { address: -1 }));
    for (const bytes of [new Uint8Array(), identity().slice(0, -1), Uint8Array.from([...identity(), 0])]) assert.throws(() => rpcDecode(bytes, 'identity'), /Malformed/);
    const wrongLength = identity(); wrongLength[4] = 8;
    assert.throws(() => rpcDecode(wrongLength, 'identity'), /Malformed/);
});

test('uses the real flasher SLIP reader and command lock for synchronous RPC/register access', async () => {
    let active = 0;
    const { transport, sent } = fixture(async packet => {
        assert.equal(active++, 0);
        await new Promise(resolve => setTimeout(resolve, 2)); active--;
        const tag = Buffer.from(packet.slice(0, 4)).toString();
        if (tag === 'SYNC') return identity();
        const cmd = rpcDecode(packet, 'register_command');
        return rpcEncode('register_response', { value: cmd.operation === 0 ? 0xc0db1234 : 0 });
    });
    await transport.sync('esp32c3');
    const [value] = await Promise.all([transport.read(0x60004000), transport.write(0x60004004, 0xdb, 255, 10)]);
    assert.equal(value, 0xc0db1234);
    assert.equal(sent.length, 3);
    assert.equal(rpcDecode(sent[2], 'register_command').delay_us, 10);
    await assert.rejects(transport.call('I2C', 1), error => error instanceof RPCError && error.status === protocol.status.UNSUPPORTED);
    assert.equal(sent.length, 3, 'unadvertised modules must not issue traffic');
});

test('structured errors preserve session; malformed responses and identity mismatch close it', async () => {
    const { transport } = fixture(packet => Buffer.from(packet.slice(0, 4)).toString() === 'SYNC' ? identity() : rpcEncode('error', { request_magic: 'REGC', status: 3 }));
    await transport.sync('esp32c3');
    await assert.rejects(transport.read(0), /BAD_ARGUMENT/);
    assert.equal(transport.closed, false);
    const bad = fixture(() => identity('esp32p4')).transport;
    await assert.rejects(bad.sync('esp32c3'), /mismatch/); assert.equal(bad.closed, true);
    const malformed = fixture(() => Uint8Array.of(1, 2, 3)).transport;
    await assert.rejects(malformed.sync('esp32c3'), /Malformed/); assert.equal(malformed.closed, true);
});

test('a timeout closes RPC and prevents a late reply from being reused', async () => {
    const { transport, device, sent } = fixture(() => null);
    // Shorten the real command timer for this test, retaining its actual lock.
    const original = device.executeCommand.bind(device);
    device.executeCommand = (packet, normal, raw) => original(packet, normal, raw, 15);
    const first = transport.sync('esp32c3');
    const queued = transport.read(0x60004000);
    await Promise.all([assert.rejects(first, /Timeout/), assert.rejects(queued, /closed/)]);
    await device.processPacket(identity());
    await assert.rejects(transport.read(0x60004000), /closed/);
    assert.equal(sent.length, 1);
});

test('every chip profile has a generated target and a validated RAM-only build', async () => {
    assert.deepEqual(Object.keys(acceleratedTargets).sort(), Object.values(require('../configs/chips.js')).filter(chip => !chip.readOnlyGPIO).map(chip => chip.id).sort());
    for (const chip of Object.keys(acceleratedTargets)) {
        const value = await prepareAccelerated(chip, fetchManifest(manifest(chip)));
        assert.equal(value.ramOnly, true);
    }
    for (const mutate of [m => { m.chip = 'esp32p4'; }, m => { m.entry = 0x42000000; }, m => { m.segments[0].address = 0x42000000; }, m => { m.segments[0].sha256 = '0'.repeat(64); }, m => { m.segments[0].length--; }, m => { m.ram.dataUsed = 999999; }]) {
        const value = manifest('esp32c3'); mutate(value);
        await assert.rejects(prepareAccelerated('esp32c3', fetchManifest(value)));
    }
    await assert.rejects(prepareAccelerated('esp32c99', () => { throw new Error('must not fetch'); }), /no accelerated/);
});

test('each target shares the ROM handoff, segment checks, entry launch and identity handshake', async () => {
    for (const chip of Object.keys(acceleratedTargets)) {
    const { device, sent } = fixture(packet => packet[0] === 0 ? Uint8Array.of(1, packet[1], 4, 0, 0, 0, 0, 0, 0, 0, 0, 0) : identity(chip, { cpu: acceleratedTargets[chip].cpu }));
    let reset = false;
    device.hardReset = async boot => { assert.equal(boot, true); reset = true; };
    device.sync = async () => { assert.ok(reset); device.current_chip = chip; device.stubLoaded = false; };
    const transport = await startAccelerated(device, manifest(chip));
    assert.equal(transport.identity.chip, chip);
    const upload = manifest(chip).segments.flatMap(segment => [5, ...Array(Math.ceil(segment.length / 0x1800)).fill(7)]);
    assert.deepEqual(sent.map(p => p[0] === 0 ? p[1] : Buffer.from(p.slice(0, 4)).toString()), [...upload, 6, 'SYNC']);
    const entries = sent.filter(p => p[1] === 5);
    assert.deepEqual(entries.map(p => new DataView(p.buffer, p.byteOffset).getUint32(20, true)), manifest(chip).segments.map(s => s.address));
    }
});

test('ROM error stops upload before execution', async () => {
    const { device, sent } = fixture(packet => Uint8Array.of(1, packet[1], 4, 0, 0, 0, 0, 0, 1, 7, 0, 0));
    device.hardReset = async () => {};
    device.sync = async () => { device.current_chip = 'esp32c3'; device.stubLoaded = false; };
    await assert.rejects(startAccelerated(device, manifest('esp32c3')), /ROM RAM download failed/);
    assert.equal(sent.length, 1);
});
