(function (root) {
    'use strict';
    const protocol = typeof module === 'object' && module.exports ? require('../stub/protocol.js') : root.ESPIO.rpcProtocol;
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
                bytes.set(array, offset);
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
            result[field] = count ? (type === 'char' ? decoder.decode(bytes.subarray(offset, offset + count)).replace(/\0.*$/s, '') : bytes.slice(offset, offset + count)) : type === 'u32' ? view.getUint32(offset, true) : type === 'u16' ? view.getUint16(offset, true) : bytes[offset];
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
    const acceleratedTargets = {
        esp32c3: { textStart: 0x40380000, textBudget: 0x4000, dataStart: 0x3fc84000, dataBudget: 0x2000 },
        esp32p4: { textStart: 0x4ff50000, textBudget: 0x4000, dataStart: 0x4ff60000, dataBudget: 0x2000 }
    };
    async function prepareAccelerated(chip, fetcher = fetch) {
        const bounds = acceleratedTargets[chip];
        if (!bounds) throw new Error(`${chip}: accelerated build environment prepared; browser loading starts with C3/P4.`);
        const response = await fetcher(`../stub/${chip}/stub.json`, { cache: 'no-store' });
        if (!response.ok) throw new Error(`Build stub/${chip} first (HTTP ${response.status}).`);
        const manifest = await response.json();
        if (manifest.format !== 'esp-io-ram-stub-v1' || manifest.chip !== chip || manifest.protocolMajor !== protocol.version.major || manifest.ramOnly !== true || manifest.requiresRom !== true || !Array.isArray(manifest.segments) || manifest.segments.length !== 2) throw new Error('Invalid RAM stub manifest.');
        if (!manifest.ram || Object.entries(bounds).some(([key, value]) => manifest.ram[key] !== value) || !Number.isInteger(manifest.ram.dataUsed) || manifest.ram.dataUsed < 2048 || manifest.ram.dataUsed > bounds.dataBudget) throw new Error('Invalid RAM reservation.');
        let entryFound = false;
        for (const [index, segment] of manifest.segments.entries()) {
            const start = index ? bounds.dataStart : bounds.textStart, budget = index ? bounds.dataBudget : bounds.textBudget;
            if (segment.address !== start || !Number.isInteger(segment.length) || segment.length < 1 || segment.length > budget || typeof segment.data !== 'string' || !/^[a-f0-9]{64}$/.test(segment.sha256)) throw new Error('Stub segment outside reserved RAM.');
            const bytes = Uint8Array.from(atob(segment.data), c => c.charCodeAt(0));
            if (bytes.length !== segment.length) throw new Error('Truncated RAM stub segment.');
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
        await device.hardReset(true); await device.sync();
        if (device.current_chip !== manifest.chip || device.stubLoaded === true) throw new Error('Expected matching chip in ROM download mode.');
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
