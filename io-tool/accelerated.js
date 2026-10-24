(function (root) {
    'use strict';
    const protocol = typeof module === 'object' && module.exports ? require('../stub/protocol.js') : root.ESPIO.rpcProtocol;
    const acceleratedTargets = typeof module === 'object' && module.exports ? require('../stub/targets.js') : root.ESPIO.acceleratedTargets;
    const decoder = new TextDecoder();
    const sizes = { u8: 1, u16: 2, u32: 4, char: 1 };
    function layout(name) {
        const packet = protocol.packets[name];
        if (!packet) throw new Error(`Unknown RPC packet ${name}`);
        return packet;
    }
    function encode(name, values = {}, magic = layout(name).magic, trailing = new Uint8Array()) {
        const packet = layout(name), bytes = new Uint8Array(packet.size + trailing.length);
        if (!/^[\x20-\x7e]{4}$/.test(magic) || bytes.length > protocol.maxPacketLength) throw new Error('Invalid RPC tag or packet length.');
        bytes.set(Array.from(magic, c => c.charCodeAt(0)));
        const view = new DataView(bytes.buffer); view.setUint32(4, bytes.length, true);
        for (const [field, type, count] of packet.fields) {
            const offset = packet.offsets[field], value = values[field] ?? 0;
            if (count) {
                const array = type === 'char' ? Array.from(String(values[field] ?? ''), c => c.charCodeAt(0)) : (values[field] ?? []);
                if (array.length > count) throw new Error(`${field} is too long`);
                for (let i = 0; i < array.length; i++) {
                    const value = array[i], max = sizes[type] === 4 ? 0xffffffff : 2 ** (8 * sizes[type]) - 1;
                    if (!Number.isInteger(value) || value < 0 || value > max) throw new Error(`Invalid ${field}`);
                    if (type === 'u32') view.setUint32(offset + i * 4, value, true);
                    else if (type === 'u16') view.setUint16(offset + i * 2, value, true);
                    else bytes[offset + i] = value;
                }
            } else {
                const max = sizes[type] === 4 ? 0xffffffff : 2 ** (8 * sizes[type]) - 1;
                if (!Number.isInteger(value) || value < 0 || value > max) throw new Error(`Invalid ${field}`);
                if (type === 'u32') view.setUint32(offset, value, true);
                else if (type === 'u16') view.setUint16(offset, value, true);
                else bytes[offset] = value;
            }
        }
        bytes.set(trailing, packet.size); return bytes;
    }
    function decode(bytes, name, magic = layout(name).magic) {
        const packet = layout(name);
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        if (bytes.length < packet.size || bytes.length > protocol.maxPacketLength || view.getUint32(4, true) !== bytes.length || decoder.decode(bytes.subarray(0, 4)) !== magic || (!packet.trailing && bytes.length !== packet.size)) throw new Error(`Malformed ${magic} RPC response.`);
        const result = {};
        for (const [field, type, count] of packet.fields) {
            const offset = packet.offsets[field];
            result[field] = count ? (type === 'char' ? decoder.decode(bytes.subarray(offset, offset + count)).replace(/\0.*$/s, '') : type === 'u8' ? bytes.slice(offset, offset + count) : Array.from({ length: count }, (_, i) => type === 'u32' ? view.getUint32(offset + i * 4, true) : view.getUint16(offset + i * 2, true))) : type === 'u32' ? view.getUint32(offset, true) : type === 'u16' ? view.getUint16(offset, true) : bytes[offset];
        }
        if (packet.trailing) result.data = bytes.slice(packet.size);
        return result;
    }
    class RPCError extends Error {
        constructor(status, magic, response = null) {
            super(`${magic}: ${Object.keys(protocol.status).find(key => protocol.status[key] === status) || `status ${status}`}`);
            this.status = status;
            this.response = response;
        }
    }
    class AcceleratedTransport {
        constructor(flasher) { this.flasher = flasher; this.closed = false; this.identity = null; this.tail = Promise.resolve(); }
        request(...args) {
            const run = () => this._request(...args);
            const pending = this.tail.then(run, run);
            this.tail = pending.catch(() => {});
            return pending;
        }
        async _request(name, values, responseName, magic, responseMagic, trailing) {
            if (this.closed) throw new Error('Accelerated session closed; reconnect to recover.');
            const payload = encode(name, values, magic, trailing);
            if (this.identity && payload.length > this.identity.max_packet_length) throw new Error('RPC exceeds the negotiated packet limit.');
            try {
                // Keep the flasher's one reader, SLIP codec, writer, and command lock.
                return await this.flasher.executeCommand({ command: 'rpc', payload }, null, (resolve, reject, raw) => {
                    try {
                        if (decoder.decode(raw.subarray(0, 4)) === protocol.packets.error.magic) {
                            const error = decode(raw, 'error');
                            if (error.request_magic !== decoder.decode(payload.subarray(0, 4))) throw new Error('RPC error refers to another request.');
                            throw new RPCError(error.status, error.request_magic);
                        }
                        const response = decode(raw, responseName, responseMagic);
                        if (response.status) throw new RPCError(response.status, responseMagic || layout(responseName).magic, response);
                        resolve(response);
                    } catch (error) { reject(error); }
                }, 2000);
            } catch (error) {
                // Without request IDs a late response after timeout cannot be matched
                // safely. Require reconnect, rather than consuming it as fresh data.
                if (!(error instanceof RPCError)) this.closed = true;
                throw error;
            }
        }
        async sync(expectedChip) {
            const id = await this.request('sync', {}, 'identity');
            if (id.protocol_major !== protocol.version.major || id.chip !== expectedChip || id.max_packet_length < protocol.packets.register_command.size || id.max_packet_length > protocol.maxPacketLength || !(id.capabilities & (1 << protocol.capabilities.REGISTERS))) {
                this.closed = true; throw new Error('Accelerated stub identity/protocol mismatch.');
            }
            this.identity = id; return id;
        }
        async read(address) {
            return (await this.request('register_command', { operation: protocol.registerOperations.READ, address }, 'register_response')).value;
        }
        async write(address, value, mask = 0xffffffff, delayUs = 0) {
            await this.request('register_command', { operation: protocol.registerOperations.WRITE, address, value: value >>> 0, mask: mask >>> 0, delay_us: delayUs }, 'register_response');
        }
        async call(module, operation, port = 0, data = new Uint8Array(), timeoutUs = 100000) {
            const pair = protocol.modules[module];
            if (!pair) throw new Error(`Unknown RPC module ${module}`);
            if (!this.identity || !(this.identity.capabilities & (1 << protocol.capabilities[module]))) throw new RPCError(protocol.status.UNSUPPORTED, module);
            const response = await this.request('module_command', { operation, port, timeout_us: timeoutUs }, 'module_response', pair.command, pair.response, data);
            if (response.operation !== operation || response.port !== port) { this.closed = true; throw new Error('RPC operation/port mismatch.'); }
            return response.data;
        }
        supports(module) { return !!(this.identity?.capabilities & (1 << protocol.capabilities[module])); }
        async captureRequest(name, values, data = new Uint8Array()) {
            if (!this.supports('CAPTURE')) throw new Error('Load accelerated stub 0.5.0 or newer for batched GPIO/ADC capture.');
            const startedAt = performance.now();
            let r, failure;
            try { r = await this.request(name, values, 'capture_response', 'IOCC', 'IOCR', data); }
            catch (error) { if (!error.response) throw error; r = error.response; failure = error; }
            const receivedAt = performance.now(), init = values.operation === protocol.captureOperations.ADC_INITIALIZE, scan = init || [protocol.captureOperations.GPIO_SCAN, protocol.captureOperations.ADC_SCAN].includes(values.operation);
            if (r.count > protocol.captureResult.maxChannels || r.data.length !== r.count * protocol.captureResult.size || ((!scan || failure) && r.count) || r.duration_us > 500000) { this.close(); throw new Error('Malformed capture response; reconnect.'); }
            if (failure) { failure.message += init ? ` (ADC initialization/calibration, eFuse version ${r.detail})` : ` (capture slot ${r.failed_slot})`; throw failure; }
            const view = new DataView(r.data.buffer, r.data.byteOffset, r.data.byteLength), samples = [], seen = new Set();
            for (let i = 0; i < r.count; i++) {
                const offset = i * 12, pin = view.getUint16(offset, true), kind = view.getUint16(offset + 2, true), value = view.getUint32(offset + 4, true), us = view.getUint32(offset + 8, true);
                if (seen.has(pin) || kind !== (init ? 2 : values.operation === protocol.captureOperations.ADC_SCAN ? 1 : 0) || us > r.duration_us) { this.close(); throw new Error('Invalid capture sample; reconnect.'); }
                seen.add(pin); samples.push({ pin, kind, value, offsetUs: us });
            }
            return { samples, detail: r.detail, durationUs: r.duration_us, startedAt, receivedAt, anchor: (startedAt + receivedAt - r.duration_us / 1000) / 2 };
        }
        captureConfigureGPIO(addresses) {
            const data = new Uint8Array(addresses.length * 4), v = new DataView(data.buffer); addresses.forEach((a, i) => v.setUint32(i * 4, a, true));
            return this.captureRequest('capture_command', { operation: protocol.captureOperations.GPIO_CONFIGURE, count: addresses.length }, data);
        }
        captureConfigureADC(plan) { return this.captureRequest('capture_plan', { ...plan, operation: protocol.captureOperations.ADC_CONFIGURE }); }
        async captureGPIO(selection) {
            const r = await this.captureRequest('capture_command', { operation: protocol.captureOperations.GPIO_SCAN, selection });
            const expected = [0, 1, 2, 3].filter(bank => selection & 1 << bank);
            if (r.samples.length !== expected.length || r.samples.some(s => !expected.includes(s.pin))) { this.close(); throw new Error('GPIO capture selection mismatch.'); }
            return r;
        }
        captureADC(selection) { return this.captureRequest('capture_command', { operation: protocol.captureOperations.ADC_SCAN, selection }); }
        captureRelease() { return this.captureRequest('capture_command', { operation: protocol.captureOperations.RELEASE }); }
        async captureADCInitialize(profile) {
            const cal = profile.hardwareCalibration, a = profile.analog, field = f => f ? [f.address, f.shift, f.bits] : [0, 0, 0];
            const init = [...profile.init, ...a.bus.init], analog = a.init, units = [];
            for (const [id, unit] of Object.entries(cal.units)) {
                const fields = unit.efuses || [unit.efuse], values = fields.flatMap(field); while (values.length < 12) values.push(0);
                units.push(Number(id), unit.offset ?? cal.offset, fields.length, ...values, unit.high.register, unit.high.mask, unit.low.register, unit.low.mask);
            }
            const raw = [...init.flatMap(v => [v.address, v.value, v.mask]), ...analog.flatMap(v => [v.register, v.value, v.mask])];
            const data = new Uint8Array(raw.length * 4), view = new DataView(data.buffer); raw.forEach((v, i) => view.setUint32(i * 4, v >>> 0, true));
            const r = await this.captureRequest('adc_setup', { operation: protocol.captureOperations.ADC_INITIALIZE, init_count: init.length, analog_count: analog.length, unit_count: Object.keys(cal.units).length, bus_control: a.bus.control, bus_select: a.bus.select || 0, bus_select_mask: a.bus.selectBit || 0, bus_command_mask: a.bus.commandMask || 0, block: a.block, major: field(cal.major), minor: field(cal.minor), minor_multiplier: cal.minor ? 100 : 0, version_min: cal.minVersion || 1, version_exact: ['esp32c3', 'esp32s3'].includes(profile.chip) ? 1 : 0, units }, data);
            if (r.samples.length !== Object.keys(cal.units).length || r.samples.some(s => !cal.units[s.pin] || s.value > 4095)) { this.close(); throw new Error('Invalid ADC calibration response.'); }
            return { source: 'efuse / accelerated stub', version: r.detail, codes: Object.fromEntries(r.samples.map(s => [s.pin, s.value])) };
        }
        captureADCRelease() { return this.captureRequest('capture_command', { operation: protocol.captureOperations.ADC_RELEASE }); }
        async peripheral(module, operation, port, args = [], data = new Uint8Array(), timeoutUs = 100000) {
            const pair = protocol.modules[module];
            if (!['I2C', 'SPI', 'PWM'].includes(module) || !this.supports(module)) throw new RPCError(protocol.status.UNSUPPORTED, module);
            let result, failure;
            try { result = await this.request('peripheral_command', { operation, port, timeout_us: timeoutUs, args }, 'peripheral_response', pair.command, pair.response, data); }
            catch (error) { if (!error.response) throw error; result = error.response; failure = error; }
            if (result.operation !== operation || result.port !== port || ((failure || operation !== protocol.operations.TRANSFER) && result.data.length)) { this.closed = true; throw new Error(`${module} RPC correlation mismatch. Reconnect.`); }
            if (failure) {
                const detail = result.error && Object.keys(protocol.peripheralErrors).find(key => protocol.peripheralErrors[key] === result.error);
                if (detail) failure.message += ` · ${detail}`;
                failure.message += ` (${Object.keys(protocol.operations).find(key => protocol.operations[key] === operation) || operation}, port ${port}, args ${args.join(', ')})`;
                throw failure;
            }
            return result;
        }
        async sdmmcRequest(operation, spec = null, argument = 0, timeoutUs = 1500000) {
            if (!this.supports('SDMMC')) throw new RPCError(protocol.status.UNSUPPORTED, 'SDMMC');
            const values = { operation, port: 1, timeout_us: timeoutUs };
            if (spec) Object.assign(values, { command: spec.index, argument: argument >>> 0, response_type: protocol.sdmmcResponseTypes[spec.response.toUpperCase()], data_bytes: spec.dataBytes || 0, application: spec.app ? 1 : 0 });
            let result, failure;
            try { result = await this.request(spec ? 'sdmmc_command' : 'module_command', values, 'sdmmc_response', 'SDMC', 'SDMR'); }
            catch (error) { if (!error.response) throw error; result = error.response; failure = error; }
            if (result.operation !== operation || result.port !== 1 || (spec && (result.command !== spec.index || result.argument !== (argument >>> 0) || result.response_type !== values.response_type)) || result.data.length !== (!failure && spec?.dataBytes ? spec.dataBytes : 0)) {
                this.closed = true; throw new Error('SDMMC RPC correlation/sector length mismatch. Reconnect.');
            }
            if (failure) throw failure;
            return result;
        }
        sdmmcConfigure() { return this.sdmmcRequest(protocol.operations.CONFIGURE); }
        sdmmcRelease() { return this.sdmmcRequest(protocol.operations.RELEASE); }
        sdmmcCommand(spec, argument, timeoutUs) { return this.sdmmcRequest(protocol.operations.TRANSFER, spec, argument, timeoutUs); }
        close() { this.closed = true; }
    }
    async function prepareAccelerated(chip, fetcher = fetch) {
        const bounds = acceleratedTargets[chip];
        if (!bounds) throw new Error(`${chip}: no accelerated stub target is defined.`);
        const response = await fetcher(`../stub/${chip}/stub.json`, { cache: 'no-store' });
        if (!response.ok) throw new Error(`Build stub/${chip} first (HTTP ${response.status}).`);
        const manifest = await response.json();
        if (manifest.format !== 'esp-io-ram-stub-v1' || manifest.chip !== chip || manifest.protocolMajor !== protocol.version.major || manifest.ramOnly !== true || manifest.requiresRom !== true || !Array.isArray(manifest.segments) || manifest.segments.length !== 2) throw new Error('Invalid RAM stub manifest.');
        if (!manifest.ram || ['textStart', 'textBudget', 'dataStart', 'dataBudget', 'stackBytes'].some(key => manifest.ram[key] !== bounds[key]) || !Number.isInteger(manifest.ram.dataUsed) || manifest.ram.dataUsed < bounds.stackBytes || manifest.ram.dataUsed > bounds.dataBudget) throw new Error('Invalid RAM reservation.');
        let entryFound = false;
        for (const [index, segment] of manifest.segments.entries()) {
            const start = index ? bounds.dataStart : bounds.textStart, budget = index ? bounds.dataBudget : bounds.textBudget;
            if (segment.address !== start || !Number.isInteger(segment.length) || segment.length < 1 || segment.length > budget || typeof segment.data !== 'string' || !/^[a-f0-9]{64}$/.test(segment.sha256)) throw new Error('Stub segment outside reserved RAM.');
            const bytes = Uint8Array.from(atob(segment.data), c => c.charCodeAt(0));
            if (bytes.length !== segment.length) throw new Error('Truncated RAM stub segment.');
            if (segment.length & 3) throw new Error('RAM stub segment length is not 32-bit aligned; rebuild the stub.');
            const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('');
            if (hash !== segment.sha256) throw new Error('RAM stub checksum mismatch.');
            if (!index && Number.isInteger(manifest.entry) && manifest.entry >= start && manifest.entry < start + bytes.length && !(manifest.entry & 3)) entryFound = true;
        }
        if (!entryFound) throw new Error('Stub entry is outside executable RAM.');
        return manifest;
    }
    function romCommand(device, opcode, ...words) {
        return device.executeCommand(device.buildCommandPacketU32(opcode, ...words), (resolve, reject, response) => {
            const data = response?.data;
            if (!data || data.length < 4 || data[data.length - 4] || data[data.length - 3]) return reject(new Error(`ROM RAM download failed (opcode ${opcode}).`));
            resolve();
        }, null, 2000);
    }
    async function startAccelerated(device, manifest) {
        if (await device.hardReset(true) === false) throw new Error('Could not reset into ROM download mode. Check BOOT/EN and reconnect.');
        await device.sync();
        if (device.current_chip !== manifest.chip) throw new Error(`ROM chip mismatch: detected ${device.current_chip}, expected ${manifest.chip}.`);
        if (device.stubLoaded === true) throw new Error(`SYNC still reports a legacy stub on ${device.current_chip}; ROM download mode is required. Check BOOT/EN reset before retrying.`);
        // Explicitly check every ROM ACK: the generic downloadMem helper does not.
        for (const segment of manifest.segments) {
            const bytes = device.base64ToByteArray(segment.data), block = 0x1800;
            await romCommand(device, 0x05, bytes.length, Math.ceil(bytes.length / block), block, segment.address);
            for (let offset = 0, sequence = 0; offset < bytes.length; offset += block, sequence++) {
                const chunk = bytes.slice(offset, offset + block);
                await romCommand(device, 0x07, chunk.length, sequence, 0, 0, chunk);
            }
        }
        await romCommand(device, 0x06, 0, manifest.entry);
        const transport = new AcceleratedTransport(device);
        try {
            await transport.sync(manifest.chip);
            return transport;
        } catch (error) { transport.close(); throw error; }
    }
    const api = { AcceleratedTransport, RPCError, acceleratedTargets, prepareAccelerated, startAccelerated, rpcEncode: encode, rpcDecode: decode };
    if (typeof module === 'object' && module.exports) module.exports = api;
    else Object.assign(root.ESPIO ||= {}, api);
})(globalThis);
