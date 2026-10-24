(function (root) {
    'use strict';
    const protocol = typeof module === 'object' && module.exports ? require('../stub/protocol.js') : root.ESPIO.rpcProtocol;
    const op = protocol.operations;
    const abort = signal => { if (signal?.aborted) throw new DOMException('Vorgang abgebrochen.', 'AbortError'); };
    // One GPIO lease and restoration path for all accelerated peripherals.
    class PeripheralHost {
        constructor(controller, kind) {
            this.controller = controller; this.transport = controller.transport; this.kind = kind;
            this.backend = this.transport;
            this.saved = new Map(); this.pinStates = new Map(); this.ready = false; this.rpcReady = false;
        }
        async remember(address, mask) {
            mask >>>= 0;
            const saved = this.saved.get(address) || { value: 0, mask: 0 }, fresh = (mask & ~saved.mask) >>> 0;
            if (fresh) { const old = await this.transport.read(address); saved.value = ((saved.value & ~fresh) | (old & fresh)) >>> 0; saved.mask = (saved.mask | mask) >>> 0; this.saved.set(address, saved); }
        }
        async set(address, value, mask) { await this.remember(address, mask); await this.transport.write(address, value, mask); }
        call(operation, args = [], data = new Uint8Array()) { return this.backend.peripheral(this.kind, operation, this.config.port, args, data); }
        open(config, signal) {
            const c = this.controller;
            return c.queue.run(async () => {
                abort(signal);
                if (!c.active || c.fault || c.scanning || this.ready || !this.backend.supports?.(this.kind) || typeof this.backend.peripheral !== 'function') throw new Error(`${this.kind}: beschleunigten Stub laden.`);
                this.config = { ...config }; this.config.port ??= this.kind === 'SPI' ? 1 : 0;
                const roles = this.kind === 'I2C' ? ['sda', 'scl'] : this.kind === 'SPI' ? ['clk', 'mosi', 'miso', 'cs'] : ['pin'];
                const used = new Set();
                for (const role of roles) {
                    const id = config[role], pin = c.chip.pins.find(p => p.id === id);
                    if (!Number.isInteger(id) || !c.pins.has(id) || !pin || pin.reserved || (role !== 'miso' && !pin.output) || used.has(id) || c.pinOwners.has(id)) throw new Error(`${role.toUpperCase()}: GPIO nicht verfügbar oder bereits belegt.`);
                    used.add(id);
                }
                for (const session of c.peripheralSessions) if (session.kind === this.kind && session.config.port === this.config.port) throw new Error(`${this.kind}: Controller/Kanal bereits belegt.`);
                const info = await this.call(op.INFO); this.info = info.values;
                const v = this.info, g = c.chip.gpio;
                const routes = this.kind === 'I2C' ? { sda: { out: v[0], input: v[1] }, scl: { out: v[2], input: v[3] } }
                    : this.kind === 'SPI' ? { clk: { out: v[0] }, mosi: { out: v[1] }, miso: { input: v[2] }, cs: { out: v[3] } } : { pin: { out: v[0] } };
                try {
                    for (const id of used) { c.pinOwners.set(id, this.kind === 'I2C' ? 'I²C' : this.kind); this.pinStates.set(id, c.pins.get(id)); }
                    c.peripheralSessions.add(this);
                    // Capture every pad before mutation so partial setup is reversible.
                    for (const role of roles) {
                        const id = config[role], pin = c.descriptor(id), bank = g.banks[Math.floor(id / 32)], bit = 2 ** (id % 32);
                        for (const [address, mask] of [[bank.enable, bit], [bank.output, bit], [g.matrix + id * 4, g.matrixMask], [pin.mux, g.muxMask], [g.pinConfig + id * 4, g.pinConfigMask], ...pin.digitalRoute.map(o => [o.address, o.mask])]) await this.remember(address, mask);
                        if (routes[role].input !== undefined) await this.remember(v[4] + routes[role].input * 4, 255);
                    }
                    // Disconnect pads while resetting/configuring the peripheral.
                    this.padsTouched = true;
                    for (const id of used) {
                        const bank = g.banks[Math.floor(id / 32)], bit = 2 ** (id % 32);
                        await this.transport.write(bank.enable, 0, bit); await this.transport.write(g.matrix + id * 4, g.matrixGPIO, g.matrixMask);
                    }
                    abort(signal); this.rpcReady = true;
                    const args = this.kind === 'I2C' ? [config.speed ?? 100000] : this.kind === 'SPI' ? [config.speed ?? 1000000, config.mode ?? 0, config.lsb ? 1 : 0] : [config.frequency ?? 1000, config.bits ?? 10, config.timer ?? 0, config.duty ?? 500];
                    this.actualHz = (await this.call(op.CONFIGURE, args)).actual_hz;
                    for (const role of roles) {
                        abort(signal);
                        const id = config[role], pin = c.descriptor(id), bank = g.banks[Math.floor(id / 32)], bit = 2 ** (id % 32), route = routes[role];
                        for (const o of pin.digitalRoute) await this.set(o.address, 0, o.mask);
                        await this.set(g.pinConfig + id * 4, this.kind === 'I2C' ? 4 : 0, g.pinConfigMask);
                        await this.set(pin.mux, g.muxGPIO | (this.kind === 'I2C' && config.pullups ? g.pullUp : 0), g.muxMask);
                        if (route.input !== undefined) await this.set(v[4] + route.input * 4, id | 128, 255);
                        await this.set(g.matrix + id * 4, route.out ?? g.matrixGPIO, g.matrixMask);
                        if (route.out !== undefined) await this.set(bank.enable, bit, bit);
                        c.pins.set(id, { ...c.pins.get(id), mode: this.kind.toLowerCase(), level: null, read: null, adcRaw: null });
                    }
                    this.ready = true;
                } catch (error) {
                    try { await this.closeUnqueued(); } catch (restore) { throw new AggregateError([error, restore], 'Initialisierung/Freigabe fehlgeschlagen; neu verbinden.'); }
                    throw error;
                }
            });
        }
        transaction(fn, signal) {
            return this.controller.queue.run(async () => { abort(signal); if (!this.ready || !this.controller.active || this.controller.fault) throw new Error('Port nicht aktiv.'); return fn(); });
        }
        close() { return this.controller.queue.run(() => this.closeUnqueued()); }
        async closeUnqueued() {
            const c = this.controller, g = c.chip.gpio, errors = [], attempt = async fn => { try { await fn(); } catch (e) { errors.push(e); } };
            if (this.rpcReady) { await attempt(() => this.call(op.RELEASE)); this.rpcReady = false; }
            for (const id of this.padsTouched ? this.pinStates.keys() : []) {
                await attempt(() => this.transport.write(g.banks[Math.floor(id / 32)].enableClear, 2 ** (id % 32)));
                await attempt(() => this.transport.write(g.matrix + id * 4, g.matrixGPIO, g.matrixMask));
            }
            const enables = new Set(g.banks.map(b => b.enable));
            for (const [address, s] of [...this.saved].reverse()) if (!enables.has(address)) await attempt(() => this.transport.write(address, s.value, s.mask));
            if (!errors.length) for (const [address, s] of this.saved) if (enables.has(address)) await attempt(() => this.transport.write(address, s.value, s.mask));
            for (const [id, state] of this.pinStates) {
                if (errors.length) { await attempt(() => this.transport.write(g.banks[Math.floor(id / 32)].enableClear, 2 ** (id % 32))); state.mode = 'unknown'; state.level = null; }
                state.read = null; state.adcRaw = null; state.lastRead = null; state.history.samples = [];
                c.pins.set(id, state); c.pinOwners.delete(id);
            }
            this.saved.clear(); this.pinStates.clear(); c.peripheralSessions.delete(this); this.ready = false; this.padsTouched = false;
            if (errors.length) { c.fault = true; c.running = false; clearTimeout(c.timer); throw new AggregateError(errors, 'GPIO-Freigabe fehlgeschlagen; neu verbinden.'); }
        }
        expectData(result, length) {
            if (result.data.length !== length) { this.transport.close(); throw new Error(`${this.kind}: ungültige Antwortlänge; neu verbinden.`); }
            return result.data;
        }
    }
    class RPCI2CHost extends PeripheralHost {
        constructor(controller, { onTransaction = () => {} } = {}) { super(controller, 'I2C'); this.onTransaction = onTransaction; }
        transfer(address, data = new Uint8Array(), read = 0, signal) {
            return this.transaction(async () => {
                const fifo = this.info[5];
                if (!Number.isInteger(address) || address < 0 || address > 127 || !(data instanceof Uint8Array) || !Number.isInteger(read) || read < 0 || read > fifo || data.length + (data.length || !read ? 1 : 0) + (read ? 1 : 0) > fifo) throw new Error(`I²C: 7-Bit-Adresse; RX maximal ${fifo} Bytes, TX inklusive Adressbytes maximal ${fifo}.`);
                const entry = { address, write: Array.from(data), read: [], startedAt: this.controller.clock() };
                try { const r = await this.call(op.TRANSFER, [address, data.length, read], data); const result = this.expectData(r, read); entry.read = Array.from(result); return result; }
                catch (e) { entry.error = e.message; throw e; }
                finally { entry.finishedAt = this.controller.clock(); this.onTransaction(entry); }
            }, signal);
        }
        async scan({ signal, onFound = () => {}, onProgress = () => {} } = {}) {
            const found = [];
            for (let address = 3; address <= 0x77; ++address) {
                abort(signal);
                try { await this.transfer(address, new Uint8Array(), 0, signal); found.push(address); onFound(address); }
                catch (e) { if (e.response?.error !== protocol.peripheralErrors.NACK) throw e; }
                onProgress(address, found.length);
            }
            return found;
        }
    }
    class SPIHost extends PeripheralHost {
        constructor(controller) { super(controller, 'SPI'); }
        transfer(data, signal) { return this.transaction(async () => { if (!(data instanceof Uint8Array) || !data.length || data.length > 64) throw new Error('SPI: 1–64 Bytes pro CS-Transaktion.'); return this.expectData(await this.call(op.TRANSFER, [data.length], data), data.length); }, signal); }
    }
    class PWMHost extends PeripheralHost {
        constructor(controller) { super(controller, 'PWM'); }
        duty(value, signal) { return this.transaction(async () => { if (!Number.isInteger(value) || value < 0 || value > 1000) throw new Error('Tastgrad: 0–1000 ‰.'); const r = await this.call(op.TRANSFER, [value]); this.expectData(r, 0); this.config.duty = value; return r; }, signal); }
    }
    const api = { PeripheralHost, RPCI2CHost, SPIHost, PWMHost };
    if (typeof module === 'object' && module.exports) module.exports = api; else Object.assign(root.ESPIO ||= {}, api);
})(globalThis);
