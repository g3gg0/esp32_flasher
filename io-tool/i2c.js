(function (root) {
    'use strict';
    const profiles = typeof module === 'object' && module.exports ? require('./configs/i2c.js') : root.ESPIO.i2cProfiles;
    const delay = () => new Promise(resolve => setTimeout(resolve, 0));
    const abort = signal => { if (signal?.aborted) throw new DOMException('I²C-Vorgang abgebrochen.', 'AbortError'); };
    function parseHexBytes(text) {
        if (!text.trim()) return new Uint8Array();
        const parts = text.trim().split(/[\s,;]+/);
        if (parts.some(part => !/^(?:0x)?[0-9a-f]{2}$/i.test(part))) throw new Error('Hex-Bytes eingeben, z. B. 00 A5 FF.');
        return Uint8Array.from(parts.map(part => parseInt(part.replace(/^0x/i, ''), 16)));
    }
    function transactionPlan(profile, address, data = new Uint8Array(), readLength = 0) {
        if (!Number.isInteger(address) || address < 0 || address > 127) throw new Error('I²C benötigt eine 7-Bit-Adresse (0x00–0x7F).');
        if (!(data instanceof Uint8Array) || !Number.isInteger(readLength) || readLength < 0 || readLength > 32) throw new Error('Pro Transaktion sind 0–32 Lesebytes möglich.');
        const tx = [], commands = [], op = profile.opcodes;
        const command = (opcode, count = 0, ackCheck = false, nack = false) => commands.push(opcode << 11 | count | (ackCheck ? 1 << 8 : 0) | (nack ? 1 << 10 : 0));
        command(op.restart);
        if (data.length || !readLength) { tx.push(address << 1, ...data); command(op.write, data.length + 1, true); }
        if (readLength) {
            if (data.length) command(op.restart);
            tx.push(address << 1 | 1); command(op.write, 1, true);
            if (readLength > 1) command(op.read, readLength - 1);
            command(op.read, 1, false, true); // NACK final byte, then STOP
        }
        command(op.stop);
        if (tx.length > profile.fifoSize) throw new Error(`TX-FIFO: maximal ${readLength ? 30 : 31} Schreibbytes${readLength ? ' bei Repeated Start' : ''}.`);
        return { tx, commands, readLength, address, data };
    }
    class I2CHost {
        constructor(controller, { onTransaction = () => {}, timeoutMs = 500 } = {}) {
            this.controller = controller; this.transport = controller.transport;
            this.onTransaction = onTransaction; this.timeoutMs = timeoutMs;
            this.saved = new Map(); this.pinStates = new Map(); this.ready = false; this.touched = false;
        }
        async remember(address, mask = 0xffffffff) {
            mask >>>= 0; const saved = this.saved.get(address) || { value: 0, mask: 0 }, fresh = (mask & ~saved.mask) >>> 0;
            if (fresh) { const value = await this.transport.read(address); saved.value = ((saved.value & ~fresh) | value & fresh) >>> 0; saved.mask = (saved.mask | mask) >>> 0; this.saved.set(address, saved); }
        }
        async set(address, value, mask = 0xffffffff) { await this.remember(address, mask); await this.transport.write(address, value, mask); }
        async wait(address, predicate, signal) {
            const deadline = this.controller.clock() + this.timeoutMs;
            for (let count = 0; count < 512; count++) {
                abort(signal); const value = await this.transport.read(address);
                if (predicate(value)) return value >>> 0;
                if (this.controller.clock() >= deadline) break;
                if (count % 16 === 15) await delay();
            }
            const error = new Error('I²C-Timeout: Bus, Pull-ups und Verdrahtung prüfen.'); error.code = 'I2C_TIMEOUT'; throw error;
        }
        validate(config) {
            const c = this.controller, profile = profiles[c.chip.id]?.ports[config.port];
            if (!profile || !profile.timings[config.speed]) throw new Error('Nur P4 I²C0/1 mit 100 oder 400 kHz ist implementiert.');
            if ([...c.peripheralSessions].some(other => other !== this && other instanceof I2CHost && other.config?.port === config.port)) throw new Error(`I²C${config.port} wird bereits verwendet.`);
            if (config.sda === config.scl) throw new Error('SDA und SCL benötigen verschiedene GPIOs.');
            for (const id of [config.sda, config.scl]) {
                const pin = c.descriptor(id);
                if (!Number.isInteger(id) || !pin.output || !c.pins.has(id) || c.pinOwners.has(id)) throw new Error(`GPIO${id} ist nicht als freier I²C-Pin verfügbar.`);
            }
            return profile;
        }
        open(config, signal) {
            if (this.transport.flasher) return Promise.reject(new Error('Use the accelerated I2C RPC backend.'));
            try { this.validate(config); } catch (error) { return Promise.reject(error); }
            return this.controller.queue.run(async () => {
                const c = this.controller, g = c.chip.gpio;
                if (!c.active || c.fault || c.scanning || this.ready) throw new Error('I²C-Port derzeit nicht verfügbar.');
                this.profile = this.validate(config); this.config = { ...config }; this.name = `I²C${config.port}`;
                const p = this.profile, m = p.matrix;
                try {
                    for (const id of [config.sda, config.scl]) { this.pinStates.set(id, c.pins.get(id)); c.pinOwners.set(id, this.name); }
                    c.peripheralSessions.add(this);
                    for (const id of this.pinStates.keys()) {
                        const pin = c.descriptor(id), bank = g.banks[Math.floor(id / 32)], bit = 2 ** (id % 32);
                        for (const [address, mask] of [[bank.enable, bit], [bank.output, bit], [g.matrix + id * 4, g.matrixMask], [g.pinConfig + id * 4, g.pinConfigMask], [pin.mux, g.muxMask], ...pin.digitalRoute.map(op => [op.address, op.mask])]) await this.remember(address, mask);
                    }
                    abort(signal);
                    for (const op of p.init) await this.set(op.address, op.value, op.mask);
                    await this.set(p.reset.address, p.reset.value, p.reset.mask); await this.set(p.reset.address, 0, p.reset.mask);
                    for (const op of [p.master, p.fifo, p.filter, ...p.timings[config.speed]]) await this.set(op.address, op.value, op.mask);
                    await this.set(p.registers.interruptEnable, 0);
                    this.touched = true;
                    for (const role of ['sda', 'scl']) {
                        const id = config[role], pin = c.descriptor(id), bank = g.banks[Math.floor(id / 32)], bit = 2 ** (id % 32);
                        await this.set(bank.enable, 0, bit);
                        for (const route of pin.digitalRoute) await this.set(route.address, 0, route.mask);
                        await this.set(bank.output, bit, bit);
                        await this.set(g.pinConfig + id * 4, m.openDrain, g.pinConfigMask);
                        await this.set(pin.mux, g.muxGPIO | (config.pullups ? g.pullUp : 0), g.muxMask);
                        await this.set(m.inputBase + m.signals[role] * 4, id | m.inputEnable, m.inputMask);
                        await this.set(g.matrix + id * 4, m.signals[role], g.matrixMask);
                        await this.set(bank.enable, bit, bit);
                        c.pins.set(id, { ...c.pins.get(id), mode: 'i2c', level: null, read: null, adcRaw: null });
                    }
                    await this.transport.write(p.registers.control, p.flags.update, p.flags.update);
                    await this.resetFSM(); this.ready = true;
                } catch (error) {
                    try { await this.closeUnqueued(); } catch (restore) { throw new AggregateError([error, restore], 'I²C-Setup und Freigabe fehlgeschlagen.'); }
                    throw error;
                }
            });
        }
        async resetFSM() {
            const p = this.profile;
            await this.transport.write(p.registers.control, p.flags.reset, p.flags.reset);
            await this.wait(p.registers.control, value => !(value & p.flags.reset));
        }
        async finishNACK() {
            // NACK halts the command sequencer before STOP. Follow IDF's
            // recovery sequence so a scan produces a complete bus transaction.
            const p = this.profile, r = p.registers, f = p.flags;
            await this.transport.write(r.clear, 0x7ffff);
            await this.transport.write(r.command, p.opcodes.stop << 11);
            for (let i = 1; i < 8; i++) await this.transport.write(r.command + i * 4, p.opcodes.end << 11);
            await this.transport.write(r.control, f.update, f.update);
            await this.transport.write(r.control, f.start, f.start);
            const events = await this.wait(r.events, value => !!(value & (128 | 1024 | 256 | 32 | 8192 | 16384)));
            if (!(events & 128) || events & (1024 | 256 | 32 | 8192 | 16384) || !(await this.transport.read(r.command) & f.commandDone)) throw new Error('I²C: STOP nach NACK fehlgeschlagen. Scan gestoppt.');
            await this.wait(r.status, value => !(value & f.busBusy));
        }
        async transaction(plan, signal) {
            const p = this.profile, r = p.registers, f = p.flags;
            const entry = { address: plan.address, write: Array.from(plan.data), readLength: plan.readLength, startedAt: this.controller.clock() };
            try {
                abort(signal);
                await this.wait(r.status, value => !(value & f.busBusy), signal);
                await this.transport.write(r.fifoConfig, f.fifoReset | f.txReset, f.fifoReset | f.txReset);
                await this.transport.write(r.fifoConfig, 0, f.fifoReset | f.txReset);
                await this.transport.write(r.clear, 0x7ffff);
                for (let i = 0; i < 8; i++) await this.transport.write(r.command + i * 4, plan.commands[i] ?? p.opcodes.end << 11);
                for (const byte of plan.tx) await this.transport.write(r.data, byte);
                await this.transport.write(r.control, f.update, f.update);
                abort(signal); await this.transport.write(r.control, f.start, f.start);
                const events = await this.wait(r.events, value => !!(value & (128 | 1024 | 256 | 32 | 8192 | 16384)), signal);
                entry.events = events;
                if (events & (1024 | 256 | 32 | 8192 | 16384)) {
                    const error = new Error(events & 1024 ? `I²C 0x${plan.address.toString(16)}: NACK.` : events & 32 ? 'I²C: Arbitration Lost.' : 'I²C: Bus-/Clock-Stretch-Timeout.');
                    error.code = events & 1024 ? 'I2C_NACK' : 'I2C_BUS_ERROR'; throw error;
                }
                if (!(await this.transport.read(r.command + (plan.commands.length - 1) * 4) & f.commandDone)) throw new Error('I²C: frisches STOP-DONE fehlt.');
                const count = (await this.transport.read(r.status) & p.rxCount.mask) >>> p.rxCount.shift;
                if (count !== plan.readLength) throw new Error(`I²C: ${count} statt ${plan.readLength} RX-Bytes.`);
                const data = new Uint8Array(count);
                for (let i = 0; i < count; i++) { abort(signal); data[i] = await this.transport.read(r.data) & 255; }
                entry.read = Array.from(data); return data;
            } catch (error) {
                entry.error = error.message;
                let recovery;
                try { if (error.code === 'I2C_NACK') await this.finishNACK(); } catch (failure) { recovery = failure; }
                try { await this.resetFSM(); } catch (failure) { recovery = recovery ? new AggregateError([recovery, failure]) : failure; }
                if (recovery) throw new AggregateError([error, recovery], 'I²C-Fehlerbehandlung fehlgeschlagen; Scan gestoppt.');
                throw error;
            } finally { entry.finishedAt = this.controller.clock(); this.onTransaction(entry); }
        }
        run(callback) {
            return this.controller.queue.run(async () => {
                if (!this.ready || !this.controller.active || this.controller.fault) throw new Error('I²C-Port zuerst aktivieren.');
                try { return await callback(); }
                catch (error) { if (error.name === 'AbortError') await this.closeUnqueued(); throw error; }
            });
        }
        transfer(address, data, readLength, signal) {
            let plan; try { plan = transactionPlan(this.profile, address, data, readLength); } catch (error) { return Promise.reject(error); }
            return this.run(() => this.transaction(plan, signal));
        }
        scan({ signal, onProgress = () => {}, onFound = () => {} } = {}) {
            return this.run(async () => {
                const addresses = [];
                for (let address = 3; address <= 0x77; address++) {
                    abort(signal);
                    try { await this.transaction(transactionPlan(this.profile, address), signal); addresses.push(address); onFound(address); }
                    catch (error) { if (error.code !== 'I2C_NACK') throw error; }
                    onProgress(address, addresses.length); if (address % 4 === 0) await delay();
                }
                return addresses;
            });
        }
        close() { return this.controller.queue.run(() => this.closeUnqueued()); }
        async closeUnqueued() {
            const c = this.controller, g = c.chip.gpio, errors = [], attempt = async fn => { try { await fn(); } catch (error) { errors.push(error); } };
            if (this.touched) {
                await attempt(() => this.resetFSM());
                for (const id of this.pinStates.keys()) {
                    await attempt(() => this.transport.write(g.banks[Math.floor(id / 32)].enableClear, 2 ** (id % 32)));
                    await attempt(() => this.transport.write(g.matrix + id * 4, g.matrixGPIO, g.matrixMask));
                }
            }
            const enables = new Set(g.banks.map(bank => bank.enable));
            for (const [address, saved] of [...this.saved].reverse()) if (!enables.has(address)) await attempt(() => this.transport.write(address, saved.value, saved.mask));
            if (!errors.length) for (const [address, saved] of this.saved) if (enables.has(address)) await attempt(() => this.transport.write(address, saved.value, saved.mask));
            if (errors.length) for (const id of this.pinStates.keys()) await attempt(() => this.transport.write(g.banks[Math.floor(id / 32)].enableClear, 2 ** (id % 32)));
            for (const [id, state] of this.pinStates) {
                state.read = null; state.adcRaw = null; state.lastRead = null; state.history.samples = [];
                if (errors.length) { state.mode = 'unknown'; state.level = null; }
                c.pins.set(id, state); c.pinOwners.delete(id);
            }
            this.saved.clear(); this.pinStates.clear(); this.ready = false; this.touched = false; c.peripheralSessions.delete(this);
            if (errors.length) { c.fault = true; c.running = false; clearTimeout(c.timer); throw new AggregateError(errors, 'I²C-Freigabe unvollständig. Neu verbinden.'); }
        }
    }
    function createI2CModel(chip, registers) {
        if (!profiles[chip.id]) return null;
        const ports = profiles[chip.id].ports;
        const state = ports.map(() => ({ tx: [], rx: [], devices: new Map([[0x18, Uint8Array.from({ length: 256 }, (_, i) => i)], [0x50, Uint8Array.from({ length: 256 }, (_, i) => 255 - i)]]), positions: new Map(), transactions: [], timeout: false, arbitration: false, staleDone: false }));
        return { ports: state,
            read(address) {
                const index = ports.findIndex(p => p.registers.data === address); if (index < 0) return undefined;
                const s = state[index], p = ports[index], byte = s.rx.shift() ?? 0;
                registers.set(p.registers.status, s.rx.length << p.rxCount.shift); return byte;
            },
            write(address, value, mask = 0xffffffff) {
                for (const [index, p] of ports.entries()) {
                    const r = p.registers, f = p.flags, s = state[index];
                    if (address === r.data) { s.tx.push(value & 255); return true; }
                    if (address === r.clear) { registers.set(r.events, ((registers.get(r.events) || 0) & ~(value & mask)) >>> 0); return true; }
                    if (address === r.fifoConfig && (value & mask & (f.fifoReset | f.txReset))) { s.tx = []; s.rx = []; registers.set(r.status, 0); return false; }
                    if (address !== r.control) continue;
                    const next = (((registers.get(address) || 0) & ~mask) | value & mask) >>> 0;
                    registers.set(address, next & ~(f.reset | f.update | f.start));
                    if (value & mask & f.reset) { s.tx = []; s.rx = []; registers.set(r.status, 0); return true; }
                    if (!(value & mask & f.start)) return true;
                    const commands = []; let readLength = 0;
                    for (let i = 0; i < 8; i++) {
                        const cmd = registers.get(r.command + i * 4) || 0, opcode = cmd >>> 11 & 7;
                        commands.push(cmd); if (opcode === p.opcodes.read) readLength += cmd & 255;
                        if (opcode === p.opcodes.stop) break;
                    }
                    if (commands[0] >>> 11 === p.opcodes.stop) {
                        s.transactions.push({ recoveryStop: true, commands });
                        registers.set(r.status, 0); registers.set(r.events, 128);
                        registers.set(r.command, (commands[0] | f.commandDone) >>> 0); return true;
                    }
                    const deviceAddress = s.tx[0] >>> 1, memory = s.devices.get(deviceAddress);
                    s.transactions.push({ tx: [...s.tx], commands, readLength });
                    const writeBytes = s.tx.slice(1, readLength && !(s.tx[0] & 1) ? -1 : undefined);
                    let position = s.positions.get(deviceAddress) || 0;
                    if (memory && !(s.tx[0] & 1) && writeBytes.length) { position = writeBytes[0]; for (const byte of writeBytes.slice(1)) memory[position++ % memory.length] = byte; }
                    s.rx = memory ? Array.from({ length: readLength }, () => memory[position++ % memory.length]) : [];
                    s.positions.set(deviceAddress, position);
                    registers.set(r.status, s.rx.length << p.rxCount.shift);
                    registers.set(r.events, s.timeout ? 256 : s.arbitration ? 32 : memory ? 128 : 1024);
                    if (!s.staleDone) for (let i = 0; i < commands.length; i++) registers.set(r.command + i * 4, (commands[i] | f.commandDone) >>> 0);
                    return true;
                }
                return false;
            }
        };
    }
    const api = { I2CHost, i2cProfiles: profiles, parseHexBytes, transactionPlan, createI2CModel };
    if (typeof module === 'object' && module.exports) module.exports = api;
    else Object.assign(root.ESPIO ||= {}, api);
})(globalThis);
