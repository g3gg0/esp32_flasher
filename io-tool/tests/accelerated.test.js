'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ESPFlasher = require('../../flasher.js');
const protocol = require('../../stub/protocol.js');
const { AcceleratedTransport, RPCError, acceleratedTargets, prepareAccelerated, probeAccelerated, startAccelerated, rpcEncode, rpcDecode } = require('../accelerated.js');

function identity(chip = 'esp32c3', extra = {}) {
    return rpcEncode('identity', { protocol_major: 1, protocol_minor: 0, max_packet_length: 1024, capabilities: 1, chip, cpu: 'riscv32', cpu_cores: 1, build: '0.1.0', idf: '6.1', ...extra });
}
function fixture(handler, options = {}) {
    const device = new ESPFlasher({ logMessage() {}, logWarning() {}, logError() {}, ...options });
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

test('ADC calibration failures expose the native bus stage without confusing readback bytes with the eFuse version', async () => {
    for(const diagnostic of [false,true]){
        const {transport}=fixture(()=>rpcEncode('capture_response',{status:5,failed_slot:diagnostic?0x0307:65535,detail:diagnostic?3|(2<<16)|(1<<24):3},'IOCR'));
        transport.identity={capabilities:1<<protocol.capabilities.CAPTURE,max_packet_length:1024};
        await assert.rejects(transport.captureRequest('adc_setup',{operation:protocol.captureOperations.ADC_INITIALIZE}),error=>{
            assert.match(error.message,/eFuse version 3\)/);
            if(diagnostic)assert.match(error.message,/analog register readback mismatch, register 0x07, expected 0x02, observed 0x01/);
            else assert.doesNotMatch(error.message,/readback mismatch/);
            return true;
        });
        assert.equal(transport.closed,false);
    }
});

test('one step-response command validates the averaged payload and response correlation', async () => {
    const config=require('../step-response.js').stepOptions({maxDelayUs:4,settleUs:2,repetitions:2});
    const values={pin:5,slot:65535,min_delay_ns:1000,max_delay_us:4,settle_us:2,repetitions:2,mode_mask:31};
    for(const malformed of [false,true]){
        const {device,transport,sent}=fixture(packet=>{
            const q=rpcDecode(packet,'step_command'),count=config.delays.length*10,data=new Uint8Array(count*6),view=new DataView(data.buffer);
            for(let i=0;i<count;i++){view.setUint16(i*6,8,true);view.setUint32(i*6+2,config.delays[i%3]+100,true);}
            return rpcEncode('step_response',{...q,pin:malformed?6:q.pin,point_count:3,sample_count:count,duration_us:1000},undefined,data);
        });
        transport.identity=rpcDecode(identity('esp32s3',{protocol_minor:9,capabilities:1|(1<<protocol.capabilities.CAPTURE)}),'identity');
        if(malformed){await assert.rejects(transport.captureStep(values,config),/Malformed step-response/);assert.equal(transport.closed,true);}
        else{const samples=await transport.captureStep(values,config);assert.equal(samples.length,30);assert.equal(samples[0].mean,.5);assert.equal(samples[0].actualDelayNs,1100);}
        assert.equal(sent.length,1);assert.equal(device.port.writable,true);
    }
});

test('debug log budget bounds polling bursts and reports dropped logs each second', t => {
    let now = 0;
    t.mock.method(performance, 'now', () => now);
    const logs = [], errors = [];
    const device = new ESPFlasher({
        maxDebugLogsPerSecond: 20, logDebug: (...args) => logs.push(args),
        logError: error => errors.push(error)
    });
    for (let i = 0; i < 10000; i++) device.logDebug('packet', i);
    assert.equal(logs.length, 20);
    now = 999; device.logDebug('still limited');
    assert.equal(logs.length, 20);
    now = 1000; device.logDebug('next window');
    assert.equal(logs.length, 22);
    assert.match(logs[20][0], /9981 messages suppressed/);
    assert.deepEqual(logs[21], ['next window']);
    device.logError('not rate limited');
    assert.deepEqual(errors, ['not rate limited']);
    for (const limit of [-1, 0.5, NaN]) assert.throws(() => new ESPFlasher({ maxDebugLogsPerSecond: limit }), /rate limit/);
    const unlimited = new ESPFlasher({ logDebug: (...args) => logs.push(args) });
    for (let i = 0; i < 30; i++) unlimited.logDebug('unlimited');
    assert.equal(logs.length, 52);
});

test('packet logging can be switched during an RPC session without reopening or resetting', async () => {
    const { device, transport, sent } = fixture(packet =>
        Buffer.from(packet.slice(0, 4)).toString() === 'SYNC'
            ? identity() : rpcEncode('register_response', { value: 42 }));
    device.openPort = device.hardReset = async () => assert.fail('logging must not reconnect/reset');
    await transport.sync('esp32c3');
    for (const enabled of [true, false, true]) {
        device.setPacketLogging(enabled);
        assert.equal(device.logPackets, enabled);
        assert.equal(device.devMode, enabled);
        assert.equal(device.slipLayer.logPackets, enabled);
        assert.equal(await transport.read(0x60004000), 42);
        assert.equal(transport.closed, false);
    }
    assert.equal(sent.length, 4);
    assert.throws(() => device.setPacketLogging('false'), /boolean/);
});

test('running stub probe identifies the target and reuses RPC without ROM commands or upload', async () => {
    const { device, sent } = fixture(packet => Buffer.from(packet.slice(0, 4)).toString() === 'SYNC' ? identity('esp32s3') : rpcEncode('register_response', { value: 123 }));
    device.sync = device.hardReset = device.downloadStub = async () => assert.fail('probe must not call ROM/flasher setup');
    const transport = await probeAccelerated(device, { timeoutMs: 50 });
    assert.equal(transport.identity.chip, 'esp32s3');
    assert.equal(transport.closed, false);
    assert.equal(await transport.read(0x60004000), 123);
    assert.deepEqual(sent.map(packet => Buffer.from(packet.slice(0, 4)).toString()), ['SYNC', 'REGC']);
});

test('silent or unrelated probe traffic falls back cleanly to the ROM command queue', async () => {
    for (const noise of [null, new TextEncoder().encode('ROM boot message')]) {
        const { device, sent } = fixture(packet => packet[0] === 0 ? Uint8Array.of(1, 10, 4, 0, 42, 0, 0, 0, 0, 0, 0, 0) : noise);
        assert.equal(await probeAccelerated(device, { timeoutMs: 10 }), null);
        assert.equal(await device.readReg(0x60004000), 42);
        assert.equal(sent.length, 2);
    }
});

test('responding incompatible or malformed stubs do not fall back to ROM uploads', async () => {
    for (const reply of [identity('esp32s3', { protocol_major: 99 }), identity('unknown-chip'), identity('esp32s3').slice(0, 12)]) {
        const { device, sent } = fixture(() => reply);
        await assert.rejects(probeAccelerated(device, { timeoutMs: 50 }), /identity\/protocol mismatch|Malformed/);
        assert.equal(sent.length, 1);
    }
});

test('stub probe reports serial write errors instead of treating them as an absent stub', async () => {
    const { device } = fixture(() => { throw new Error('serial write failed'); });
    await assert.rejects(probeAccelerated(device, { timeoutMs: 50 }), /serial write failed/);
});

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

test('debug logging supports both ROM packets and raw accelerated RPC payloads', async () => {
    const logs = [];
    const { device, transport, sent } = fixture(packet => {
        if (packet[0] === 0) return Uint8Array.of(1, packet[1], 4, 0, 0, 0, 0, 0, 0, 0, 0, 0);
        if (Buffer.from(packet.slice(0, 4)).toString() === 'SYNC') return identity();
        return rpcEncode('register_response', { value: 0xc0db1234 });
    }, { devMode: true, logPackets: true, logDebug: (...args) => logs.push(args) });
    await device.executeCommand(device.buildCommandPacketU32(5, 32, 1, 32, 0x40378000),
        (resolve, reject, response) => resolve(response.data));
    await transport.sync('esp32c3');
    assert.equal(await transport.read(0x60004000), 0xc0db1234);
    assert.equal(transport.closed, false);
    assert.equal(sent.length, 3);
    assert.ok(logs.some(([message]) => message.includes('MEM_BEGIN')));
    assert.ok(logs.some(([message, packet]) => message.includes('Raw SLIP') && packet.command === 'rpc'));
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
        for (const segment of value.segments) assert.equal(segment.length % 4, 0, `${chip} segment ${segment.address} must be word-aligned for ROM MEM_DATA`);
    }
    {
        const value = manifest('esp32c3'), bytes = Buffer.from(value.segments[0].data, 'base64').subarray(0, -2);
        Object.assign(value.segments[0], { data: bytes.toString('base64'), length: bytes.length, sha256: require('crypto').createHash('sha256').update(bytes).digest('hex') });
        await assert.rejects(prepareAccelerated('esp32c3', fetchManifest(value)), /32-bit aligned/);
    }
    for (const mutate of [m => { m.chip = 'esp32p4'; }, m => { m.entry = 0x42000000; }, m => { m.segments[0].address = 0x42000000; }, m => { m.segments[0].sha256 = '0'.repeat(64); }, m => { m.segments[0].length--; }, m => { m.ram.dataUsed = 999999; }]) {
        const value = manifest('esp32c3'); mutate(value);
        await assert.rejects(prepareAccelerated('esp32c3', fetchManifest(value)));
    }
    await assert.rejects(prepareAccelerated('esp32c99', () => { throw new Error('must not fetch'); }), /no accelerated/);
});

test('older smaller RAM reservations stay loadable inside current target limits', async () => {
    const value=manifest('esp32p4');
    value.ram.textBudget=Math.ceil(value.segments[0].length/256)*256;
    value.ram.dataBudget=Math.ceil(value.ram.dataUsed/256)*256;
    await prepareAccelerated('esp32p4',fetchManifest(value));
    const outside=structuredClone(value);outside.ram.dataBudget=outside.ram.dataUsed-1;
    await assert.rejects(prepareAccelerated('esp32p4',fetchManifest(outside)),/RAM reservation/);
    const oversized=structuredClone(value);oversized.ram.dataBudget=acceleratedTargets.esp32p4.dataBudget+256;
    await assert.rejects(prepareAccelerated('esp32p4',fetchManifest(oversized)),/RAM reservation/);
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

test('manual bootloader entry skips reset but still synchronizes, uploads and verifies the accelerated stub', async () => {
    for (const chip of Object.keys(acceleratedTargets)) {
        const { device, sent } = fixture(packet => packet[0] === 0 ? Uint8Array.of(1, packet[1], 4, 0, 0, 0, 0, 0, 0, 0, 0, 0) : identity(chip, { cpu: acceleratedTargets[chip].cpu }));
        device.skipBootloaderReset = true;
        device.hardReset = async () => assert.fail('Manual bootloader entry must not call hardReset');
        let syncs = 0;
        device.sync = async () => { syncs++; device.current_chip = chip; device.stubLoaded = false; };
        const transport = await startAccelerated(device, manifest(chip));
        assert.equal(syncs, 1);
        assert.equal(transport.identity.chip, chip);
        assert.ok(sent.some(packet => packet[1] === 5), 'RAM download still runs');
        assert.equal(Buffer.from(sent.at(-1).slice(0, 4)).toString(), 'SYNC');
    }
});

test('skipBootloaderReset skips only bootloader entry and leaves signal control and normal reset available', async () => {
    const device = new ESPFlasher({ skipBootloaderReset: true }), signals = [];
    device.port = { setSignals: async value => signals.push(value) };
    assert.equal(await device.hardReset(true), true);
    assert.equal(signals.length, 0);
    await device.setDtr(true);
    await device.setRts(false);
    await device.setDtrRts(false, true);
    await device.setSignals({ dataTerminalReady: false, requestToSend: false });
    assert.ok(signals.length > 0, 'manual DTR/RTS calls remain available');
    signals.length = 0;
    assert.equal(await device.hardReset(false), true);
    assert.ok(signals.length > 0, 'reset into application mode still runs');
    const automatic = new ESPFlasher();
    automatic.port = device.port;
    signals.length = 0;
    assert.equal(await automatic.hardReset(true), true);
    assert.ok(signals.length > 0, 'automatic bootloader entry remains the default');
});

test('gateway-sized blocks preserve every byte and sequence in classic and accelerated S3 RAM uploads', async () => {
    const chip = 'esp32s3', value = manifest(chip);
    for (const blockSize of [64, 1024]) for (const classic of [true, false]) {
        const { device, sent } = fixture(packet => {
            if (packet[0] !== 0) return identity(chip, { cpu: acceleratedTargets[chip].cpu });
            if (packet[1] === 7) {
                const view = new DataView(packet.buffer, packet.byteOffset);
                assert.ok(view.getUint32(8, true) <= blockSize, 'gateway rejects larger blocks');
                assert.equal(view.getUint32(4, true), packet.slice(24).reduce((checksum, byte) => checksum ^ byte, 0xef));
            }
            return Uint8Array.of(1, packet[1], 4, 0, 0, 0, 0, 0, 0, 0, 0, 0);
        }, { initialBaudRate: 115200, skipBootloaderReset: true, ramBlockSize: blockSize, ramCommandTimeout: 5000 });
        device.hardReset = async () => assert.fail('gateway must not be reset');
        device.sync = async () => { device.current_chip = chip; device.stubLoaded = false; };
        const timeouts = [], execute = device.executeCommand.bind(device);
        device.executeCommand = (...args) => { if ([5, 6, 7].includes(args[0].command)) timeouts.push(args[3]); return execute(...args); };
        if (classic) for (const segment of value.segments) await device.downloadMem(segment.address, segment.data);
        else await startAccelerated(device, value);
        let segmentIndex = -1, chunks = [], sequence = 0;
        const checkSegment = () => {
            if (segmentIndex >= 0) assert.deepEqual(Buffer.concat(chunks), Buffer.from(value.segments[segmentIndex].data, 'base64'));
        };
        for (const packet of sent.filter(packet => packet[0] === 0)) {
            const view = new DataView(packet.buffer, packet.byteOffset);
            if (packet[1] === 5) {
                checkSegment(); segmentIndex++; chunks = []; sequence = 0;
                assert.equal(view.getUint32(16, true), blockSize);
                assert.equal(view.getUint32(20, true), value.segments[segmentIndex].address);
            } else if (packet[1] === 7) {
                assert.equal(view.getUint32(12, true), sequence++);
                assert.equal(view.getUint32(8, true), packet.length - 24);
                chunks.push(Buffer.from(packet.slice(24)));
            }
        }
        checkSegment();
        assert.equal(segmentIndex + 1, value.segments.length);
        assert.ok(timeouts.every(timeout => timeout === 5000));
        assert.equal(device.initialBaudRate, 115200);
    }
});

test('data command checksums cover short final blocks while non-data commands keep checksum zero', () => {
    const device = new ESPFlasher();
    for (const opcode of [3, 7, 17]) for (let length = 1; length <= 64; length++) {
        const data = Uint8Array.from({ length }, (_, i) => (i * 37 + length) & 255);
        const packet = device.buildCommandPacketU32(opcode, length, 0, 0, 0, data);
        assert.equal(new DataView(packet.payload.buffer).getUint32(4, true), data.reduce((sum, byte) => sum ^ byte, 0xef), `opcode ${opcode}, ${length} bytes`);
    }
    const sync = device.buildCommandPacketU32(8, new Uint8Array(36).fill(0x55));
    assert.equal(new DataView(sync.payload.buffer).getUint32(4, true), 0);
});

test('failed S3 RAM block reports chip, address, sequence and size', async () => {
    const { device } = fixture(packet => {
        if (packet[1] === 7) throw new Error('simulated lost gateway data');
        return Uint8Array.of(1, packet[1], 4, 0, 0, 0, 0, 0, 0, 0, 0, 0);
    }, { skipBootloaderReset: true, ramBlockSize: 1024 });
    device.sync = async () => { device.current_chip = 'esp32s3'; device.stubLoaded = false; };
    await assert.rejects(startAccelerated(device, manifest('esp32s3')), /MEM_DATA esp32s3 at 0x[\da-f]+, block 0, 1024 bytes: simulated lost gateway data/);
});

test('classic RAM upload stops at the first rejected block and exposes the actual ROM error bytes', async () => {
    const { device, sent } = fixture(packet => Uint8Array.of(1, packet[1], 4, 0, 0, 0, 0, 0, packet[1] === 7 ? 1 : 0, packet[1] === 7 ? 7 : 0, 0, 0), { ramBlockSize: 1024 });
    const bytes = Buffer.alloc(4096, 0xa5);
    await assert.rejects(device.downloadMem(0x40378000, bytes.toString('base64')), /MEM_DATA at 0x40378000, block 0, 1024 bytes: .*status 0x01, error 0x07 \(checksum error\); ACK 01 07 00 00/);
    assert.deepEqual(sent.map(packet => packet[1]), [5, 7, 7, 7], 'only the rejected block is retried, then upload stops');
    assert.deepEqual(sent.filter(packet => packet[1] === 7).map(packet => new DataView(packet.buffer, packet.byteOffset).getUint32(12, true)), [0, 0, 0]);
});

test('RAM status parsing handles ROM and stub ACK layouts and rejects incomplete replies', () => {
    const device = new ESPFlasher();
    assert.throws(() => device.checkRAMResponse({ data: Uint8Array.of(1, 15, 0, 0) }, 5), /error 0x0f \(invalid RAM binary address\)/);
    assert.throws(() => device.checkRAMResponse({ data: Uint8Array.of(0, 0) }, 7), /incomplete ACK/);
    device.stubLoaded = true;
    device.checkRAMResponse({ data: Uint8Array.of(0, 0) }, 7);
    assert.throws(() => device.checkRAMResponse({ data: Uint8Array.of(1, 7) }, 7), /checksum error/);
    assert.throws(() => device.checkRAMResponse({ data: Uint8Array.of(1, 7) }, 7, 4), /incomplete ACK/);
});

test('checksum retry preserves identical RAM block bytes and sequence in both upload paths', async () => {
    for (const classic of [true, false]) {
        let rejected = false;
        const { device, sent } = fixture(packet => {
            if (packet[0] !== 0) return identity('esp32s3', { cpu: acceleratedTargets.esp32s3.cpu });
            const fail = packet[1] === 7 && !rejected;
            if (fail) rejected = true;
            return Uint8Array.of(1, packet[1], 4, 0, 0, 0, 0, 0, fail ? 1 : 0, fail ? 7 : 0, 0, 0);
        }, { skipBootloaderReset: true, ramBlockSize: 1024 });
        device.sync = async () => { device.current_chip = 'esp32s3'; device.stubLoaded = false; };
        if (classic) await device.downloadMem(0x40378000, Buffer.alloc(2048, 0xdb).toString('base64'));
        else await startAccelerated(device, manifest('esp32s3'));
        const blocks = sent.filter(packet => packet[0] === 0 && packet[1] === 7);
        assert.deepEqual(blocks[0], blocks[1], 'retry must send the exact same checksum, sequence and payload');
        assert.equal(new DataView(blocks[2].buffer, blocks[2].byteOffset).getUint32(12, true), 1);
    }
});

test('RAM transfer never retries a timeout or an address rejection', async () => {
    for (const error of [new Error('simulated timeout'), Object.assign(new Error('invalid RAM address'), { romStatus: 1, romError: 15 })]) {
        const device = new ESPFlasher(); let attempts = 0;
        device.executeCommand = async () => { attempts++; throw error; };
        await assert.rejects(device.sendRAMCommand(7, [1, 0, 0, 0, Uint8Array.of(0xc0)]), value => value === error);
        assert.equal(attempts, 1);
    }
});

test('gateway writes preserve SLIP bytes, frame ordering and UART wire-time pacing in 64-byte chunks', async t => {
    const delays = [], writes = [], realTimeout = globalThis.setTimeout;
    t.mock.method(globalThis, 'setTimeout', (callback, delay) => { delays.push(delay); return realTimeout(callback, 0); });
    const device = new ESPFlasher({ writeChunkSize: 64, writePacingBaudRate: 115200 });
    let writers = 0, writing = false;
    device.port = { writable: { getWriter: () => { writers++; return { write: async bytes => {
        assert.equal(writing, false); writing = true;
        await Promise.resolve(); writes.push(Buffer.from(bytes)); writing = false;
    } }; } } };
    const first = device.slipLayer.encode(Uint8Array.from({ length: 257 }, (_, i) => i & 255)), second = Uint8Array.of(0xc0, 1, 2, 0xc0);
    await Promise.all([device._writeFrame(first), device._writeFrame(second)]);
    assert.deepEqual(Buffer.concat(writes), Buffer.concat([Buffer.from(first), Buffer.from(second)]));
    assert.ok(writes.every(bytes => bytes.length <= 64));
    assert.equal(writers, 1);
    assert.equal(delays.length, Math.ceil(first.length / 64) - 1);
    assert.ok(delays.every(ms => ms === 7), '64 bytes at 115200 8N1 need 5.56 ms plus guard');
});

test('64-byte gateway writes without pacing preserve complete frames and never schedule a sleep', async t => {
    t.mock.method(globalThis, 'setTimeout', () => assert.fail('unpaced writes must not sleep'));
    const device = new ESPFlasher({ initialBaudRate: 115200, writeChunkSize: 64 }), writes = [];
    device.port = { writable: { getWriter: () => ({ write: async bytes => writes.push(Buffer.from(bytes)) }) } };
    const first = device.slipLayer.encode(Uint8Array.from({ length: 1024 }, (_, i) => i & 255));
    const second = device.slipLayer.encode(Uint8Array.of(0xc0, 0xdb));
    await Promise.all([device._writeFrame(first), device._writeFrame(second)]);
    assert.ok(writes.every(bytes => bytes.length <= 64));
    assert.deepEqual(Buffer.concat(writes), Buffer.concat([Buffer.from(first), Buffer.from(second)]));
    assert.equal(device.initialBaudRate, 115200);
});
