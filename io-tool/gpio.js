(function (root) {
    'use strict';
    const now = () => performance.now();
    const bit = pin => (2 ** (pin % 32)) >>> 0;
    const adcAPI = typeof module === 'object' && module.exports ? require('./adc.js') : root.ESPIO;
    const sdAPI = typeof module === 'object' && module.exports ? require('./sd.js') : root.ESPIO;
    const i2cAPI = typeof module === 'object' && module.exports ? require('./i2c.js') : root.ESPIO;
    const ldoAPI = typeof module === 'object' && module.exports ? require('./ldo4.js') : root.ESPIO;

    // Uses the existing flasher framing/command queue. Status is checked here
    // because the generic flasher readReg helper does not inspect status bytes.
    class RegisterTransport {
        constructor(flasher) { this.flasher = flasher; this.closed = false; }
        command(opcode, ...words) {
            if (this.closed) return Promise.reject(new Error('Verbindung geschlossen.'));
            return this.flasher.executeCommand(this.flasher.buildCommandPacketU32(opcode, ...words), (resolve, reject, response) => {
                const data = response?.data;
                const size = this.flasher.stubLoaded === true ? 2 : 4;
                if (!data || data.length < size) return reject(new Error('Unvollständige Registerantwort.'));
                const status = data[data.length - size], error = data[data.length - size + 1];
                if (status || error) return reject(new Error(`Registerzugriff fehlgeschlagen: Status ${status}, Fehler 0x${error.toString(16)}.`));
                resolve(response.value >>> 0);
            });
        }
        read(address) { return this.command(0x0a, address); }
        write(address, value, mask = 0xffffffff, delayUs = 0) { return this.command(0x09, address, value >>> 0, mask >>> 0, delayUs); }
        close() { this.closed = true; }
    }

    class Queue {
        constructor() { this.tail = Promise.resolve(); this.closed = false; }
        run(callback) {
            const run = () => {
                if (this.closed) throw new Error('Sitzung beendet.');
                return callback();
            };
            const result = this.tail.then(run, run);
            this.tail = result.catch(() => {});
            return result;
        }
        async close() { this.closed = true; await this.tail; }
    }

    // Timestamped states, not assumed equally spaced samples. Keep one sample
    // before the left edge to draw the held value, but never across a long gap.
    class History {
        constructor(windowMs = 1000) { this.windowMs = windowMs; this.samples = []; }
        push(t, read, drive = null, breakRead = false) {
            this.samples.push({ t, read, drive, breakRead });
            this.prune(t);
        }
        prune(t) {
            let count = 0;
            while (count + 1 < this.samples.length && this.samples[count + 1].t < t - this.windowMs) count++;
            if (count) this.samples.splice(0, count);
            // A pathological source must not grow the plot without bound.
            if (this.samples.length > 4096) this.samples.splice(0, this.samples.length - 4096);
        }
    }

    class GPIOController {
        constructor(transport, chip, { clock = now, onSample = () => {}, onError = () => {}, readOnly = transport instanceof RegisterTransport } = {}) {
            this.transport = transport; this.chip = chip; this.clock = clock;
            this.readOnly = readOnly || !!chip.readOnlyGPIO;
            this.onSample = onSample; this.onError = onError;
            this.queue = new Queue(); this.pins = new Map(); this.running = false;
            this.timer = null; this.pollPromise = null; this.interval = 20; this.active = true;
            this.fault = false;
            this.pinOwners = new Map(); this.peripheralSessions = new Set();
            this.readMode = 'digital'; this.scanning = false;
            this.ldo4 = ldoAPI.ldo4Profiles[chip.id] ? new ldoAPI.LDO4(transport, ldoAPI.ldo4Profiles[chip.id]) : null;
            this.adc = adcAPI.adcProfiles[chip.id] ? new adcAPI.ADCReader(transport, adcAPI.adcProfiles[chip.id], { clock }) : null;
        }
        descriptor(id) {
            const pin = this.chip.pins.find(item => item.id === id);
            if (!pin || pin.reserved) throw new Error(`GPIO${id}: ${pin?.reserved || 'nicht verfügbar'}`);
            return pin;
        }
        analogRoute(id) { return (this.readMode === 'adc' || this.adcScanRouting) && this.adc?.channel(id) ? this.adc.profile.padRoute : null; }
        bank(id) { return this.analogRoute(id)?.bank || this.chip.gpio.banks[Math.floor(id / 32)]; }
        async configurePin(id, mode = 'input', pull = 'none', level = 0, driveStrength) {
            if (this.readOnly) throw new Error('Load the accelerated stub to configure GPIO.');
            const pin = this.descriptor(id);
            if (this.pinOwners.has(id)) throw new Error(`GPIO${id} wird von ${this.pinOwners.get(id)} verwendet; zuerst den Port freigeben.`);
            if (!['input', 'output'].includes(mode)) throw new Error('Diese Funktion ist noch nicht implementiert.');
            if (!['none', 'up', 'down'].includes(pull)) throw new Error('Unbekannter Pull-Widerstand.');
            if (mode === 'output' && !pin.output) throw new Error(`GPIO${id} ist nur als Eingang verfügbar.`);
            if (pull !== 'none' && !pin.pulls) throw new Error(`GPIO${id} hat keine internen Pull-Widerstände.`);
            if (driveStrength !== undefined && (!Number.isInteger(driveStrength) || driveStrength < 0 || driveStrength > 3 || !pin.output)) throw new Error('Drive strength requires an output-capable pin and a level from 0 to 3.');
            level = level ? 1 : 0;
            const registers = this.chip.gpio, bank = this.bank(id), mask = bit(id);
            const route = this.analogRoute(id);
            // ESP32 HP and LP IO MUX use FUN_DRV[11:10]. Read the current
            // setting when omitted, so ordinary configuration preserves it.
            const driveMask = 3 << 10, muxAddress = route ? route.mux + id * 4 : pin.mux;
            // Release output before any read/configuration that could fail.
            if (route) {
                await this.transport.write(registers.banks[Math.floor(id / 32)].enableClear, mask);
                await this.adc.set(bank.enable, 0, mask);
            } else {
                if (this.adc?.ready && this.adc.profile.padRoute && this.adc.channel(id)) await this.transport.write(this.adc.profile.padRoute.bank.enableClear, mask);
                await this.transport.write(bank.enableClear, mask);
            }
            const strength = driveStrength ?? ((await this.transport.read(muxAddress) & driveMask) >>> 10);
            const driveValue = strength << 10, writeDriveMask = driveStrength === undefined ? 0 : driveMask;
            if (route) {
                // C6 analog pads belong to LP IO MUX (TRM 7.7.3). Use the
                // LP driver/pulls/readback too, so ADC observes the same pad.
                const output = mode === 'output' ? (level ? mask : 0) : await this.transport.read(bank.output);
                await this.adc.set(bank.output, output, mask);
                await this.adc.set(route.pinConfig + id * 4, 0, route.pinConfigMask);
                const pullValue = pull === 'up' ? route.pullUp : pull === 'down' ? route.pullDown : 0;
                await this.adc.set(muxAddress, route.muxGPIO | pullValue | driveValue, route.muxMask | writeDriveMask);
                await this.adc.set(route.select, mask, mask);
                if (mode === 'output') await this.transport.write(bank.enableSet, mask);
                const old = this.pins.get(id);
                this.pins.set(id, { id, mode, pull, driveStrength: strength, level: mode === 'output' ? level : null, read: null,
                    configuredAt: this.clock(), history: old?.history || new History() });
                return;
            }
            for (const route of pin.digitalRoute) await this.transport.write(route.address, 0, route.mask);
            await this.transport.write(registers.pinConfig + id * 4, 0, registers.pinConfigMask);
            await this.transport.write(registers.matrix + id * 4, registers.matrixGPIO, registers.matrixMask);
            const pullValue = pull === 'up' ? registers.pullUp : pull === 'down' ? registers.pullDown : 0;
            await this.transport.write(muxAddress, registers.muxGPIO | pullValue | driveValue, registers.muxMask | writeDriveMask);
            if (mode === 'output') {
                await this.transport.write(level ? bank.set : bank.clear, mask);
                await this.transport.write(bank.enableSet, mask);
            }
            const old = this.pins.get(id);
            this.pins.set(id, { id, mode, pull, driveStrength: strength, level: mode === 'output' ? level : null, read: null,
                configuredAt: this.clock(), history: old?.history || new History() });
        }
        configure(id, mode, pull = 'none', level = 0, driveStrength) {
            return this.queue.run(async () => {
                if (this.pinOwners.has(id)) throw new Error(`GPIO${id} wird von ${this.pinOwners.get(id)} verwendet; zuerst den Port freigeben.`);
                try { await this.configurePin(id, mode, pull, level, driveStrength); }
                catch (error) {
                    // The old mode cannot be asserted after a partial transaction.
                    const state = this.pins.get(id);
                    if (state) { state.mode = 'unknown'; state.level = null; state.read = null; }
                    this.running = false; clearTimeout(this.timer);
                    this.fault = true;
                    throw error;
                }
            });
        }
        async initialize(ids) {
            return this.queue.run(async () => {
                for (const id of ids) {
                    if (!this.active) break;
                    if (this.readOnly) this.pins.set(id, { id, mode: 'observe', pull: null, level: null, read: null, history: new History() });
                    else await this.configurePin(id, 'input');
                }
                if (this.transport.supports?.('CAPTURE')) await this.transport.captureConfigureGPIO(this.chip.gpio.banks.map(b => b.input));
            });
        }
        updateLDO4(mode) {
            if (this.readOnly) return Promise.reject(new Error('Load the accelerated stub for peripheral operations.'));
            return this.queue.run(async () => {
                if (!this.ldo4 || !this.active || this.fault || this.scanning) throw new Error('LDO4 derzeit nicht verfügbar.');
                if (mode && [...this.pinOwners.keys()].some(id => this.ldo4.affects(id))) throw new Error('Zuerst die Peripherieports der Versorgungsdomäne freigeben.');
                return mode ? this.ldo4.setMode(mode) : this.ldo4.refresh();
            });
        }
        setLevel(id, level) {
            if (this.readOnly) return Promise.reject(new Error('Load the accelerated stub to drive GPIO.'));
            return this.queue.run(async () => {
                const state = this.pins.get(id);
                if (!state || state.mode !== 'output') throw new Error('Zuerst GPIO Output konfigurieren.');
                this.descriptor(id);
                if (this.pinOwners.has(id)) throw new Error(`GPIO${id} wird von ${this.pinOwners.get(id)} verwendet.`);
                const bank = this.bank(id);
                await this.transport.write(level ? bank.set : bank.clear, bit(id));
                state.level = level ? 1 : 0;
                // Record the command ACK time; don't fabricate a new input read.
                state.history.push(this.clock(), null, state.level);
            });
        }
        async sample() {
            return this.queue.run(async () => {
                if (this.transport.supports?.('CAPTURE')) {
                    const states = [...this.pins.values()].filter(s => !this.pinOwners.has(s.id) && (this.readMode !== 'adc' || this.adc?.channel(s.id)));
                    if (!states.length) return;
                    const mask = states.reduce((m, s) => m | 1 << Math.floor(s.id / 32), 0);
                    const result = this.readMode === 'adc' ? await this.adc.capture(states.map(s => s.id)) : await this.transport.captureGPIO(mask);
                    this.captureDurationUs = result.durationUs;
                    const samples = new Map(result.samples.map(s => [s.pin, s]));
                    for (const state of this.pins.values()) {
                        const sample = samples.get(this.readMode === 'adc' ? state.id : Math.floor(state.id / 32));
                        if (!sample || this.pinOwners.has(state.id)) { state.read = null; state.adcRaw = null; continue; }
                        const t = result.anchor + sample.offsetUs / 1000, raw = this.readMode === 'adc' ? sample.value : sample.value >>> (state.id % 32) & 1;
                        state.read = this.readMode === 'adc' ? raw / this.adc.profile.max : raw; state.adcRaw = this.readMode === 'adc' ? raw : null;
                        state.samplePeriod = state.lastRead ? t - state.lastRead : null; state.lastRead = t;
                        state.history.push(t, state.read, state.mode === 'output' ? state.level : null);
                        if (this.readMode === 'adc') this.onSample(this.pins, t, state.id);
                    }
                    if (this.readMode !== 'adc') this.onSample(this.pins, result.anchor, null);
                    return;
                }
                if (this.readMode === 'adc') {
                    for (const state of this.pins.values()) {
                        if (!this.active) break;
                        if (this.pinOwners.has(state.id) || !this.adc?.channel(state.id)) { state.read = null; state.adcRaw = null; continue; }
                        const sample = await this.adc.read(state.id);
                        state.read = sample.value; state.adcRaw = sample.raw;
                        state.samplePeriod = state.lastRead ? sample.t - state.lastRead : null;
                        state.lastRead = sample.t;
                        state.history.push(sample.t, sample.value, state.mode === 'output' ? state.level : null);
                        this.onSample(this.pins, sample.t, state.id);
                    }
                    return;
                }
                const banks = new Set([...this.pins.keys()].map(id => Math.floor(id / 32)));
                const values = new Map();
                // Read each bank once (all GPIOs sampled in one register access).
                for (const bank of banks) {
                    const value = await this.transport.read(this.chip.gpio.banks[bank].input);
                    values.set(bank, { value: value >>> 0, t: this.clock() });
                }
                const overrides = new Map();
                for (const state of this.pins.values()) {
                    const source = this.chip.gpio.inputOverrides?.[state.id];
                    if (source && !overrides.has(source.address)) overrides.set(source.address,
                        { value: (await this.transport.read(source.address)) >>> 0, t: this.clock() });
                }
                for (const state of this.pins.values()) {
                    const source = this.chip.gpio.inputOverrides?.[state.id];
                    const sample = source ? overrides.get(source.address) : values.get(Math.floor(state.id / 32));
                    state.read = (sample.value >>> (source?.bit ?? state.id % 32)) & 1;
                    state.lastRead = sample.t;
                    state.history.push(sample.t, state.read, state.mode === 'output' ? state.level : null);
                }
                this.onSample(this.pins, this.clock(), null);
            });
        }
        setReadMode(mode) {
            if (this.readOnly && mode !== 'digital') return Promise.reject(new Error('Load the accelerated stub for ADC.'));
            return this.queue.run(async () => {
                if (this.fault || !this.active) throw new Error('Sitzung gestoppt; bitte neu verbinden.');
                if (!['digital', 'adc'].includes(mode)) throw new Error('Unbekannte Messquelle.');
                if (mode === 'adc' && !this.adc) throw new Error('Für diesen Chip ist ADC noch nicht implementiert.');
                if (mode === 'adc') await this.adc.open();
                if (mode !== this.readMode) {
                    this.readMode = mode;
                    if (this.adc?.profile.padRoute) {
                        for (const state of [...this.pins.values()]) if (this.adc.channel(state.id)) await this.configurePin(state.id, state.mode, state.pull, state.level, state.driveStrength);
                    }
                }
                if (mode === 'digital') await this.adc?.close();
                for (const state of this.pins.values()) {
                    state.read = null; state.adcRaw = null; state.lastRead = null; state.samplePeriod = null; state.history.samples = [];
                }
            });
        }
        async scanUsage(ids, { method = 'pull', settleMs = 20, loadProfile = false, maxDrive = null, signal, onResult = () => {}, onPhase = () => {} } = {}) {
            if (this.readOnly) throw new Error('Load the accelerated stub for usage scans.');
            if (this.scanning || this.fault || !this.active) throw new Error('Usage-Scan nicht verfügbar.');
            if (!['pull', 'drive', 'compare', 'sweep'].includes(method) || !Number.isFinite(settleMs) || settleMs < 1 || settleMs > 200 || typeof loadProfile !== 'boolean' || (maxDrive !== null && (!Number.isInteger(maxDrive) || maxDrive < 0))) throw new Error('Ungültige Scanparameter.');
            const targets = [...new Set(ids)];
            if (!targets.length || targets.some(id => !this.pins.has(id) || this.descriptor(id).reserved || this.pinOwners.has(id))) throw new Error('Nur verwaltete, verfügbare GPIO-Pins ohne Peripheriezuordnung können gescannt werden.');
            this.scanning = true; const resume = this.running;
            await this.pause();
            try {
                if (this.fault || !this.active) throw new Error('Sitzung während des Anhaltens gestoppt; bitte neu verbinden.');
                return await this.queue.run(async () => {
                    const wasReady = this.adc?.ready, needsADC = targets.some(id => this.adc?.channel(id)), results = [];
                    try {
                        for (const id of targets) {
                            if (signal?.aborted) throw new DOMException('Scan abgebrochen.', 'AbortError');
                            if (this.adc?.channel(id)) await this.adc.open();
                            const result = await adcAPI.scanPin(this, id, { method, settleMs, loadProfile, maxDrive, signal, onPhase });
                            results.push(result); onResult(result);
                        }
                        return results;
                    } finally { if (needsADC && !wasReady) await this.adc.close(); }
                });
            } catch (error) { if (error.name !== 'AbortError') this.fault = true; throw error; }
            finally { this.scanning = false; if (resume && this.active && !this.fault) this.start(); }
        }
        start(interval = this.interval) {
            if (!this.active || this.running || this.fault) return;
            this.interval = interval; this.running = true;
            const poll = async () => {
                if (!this.running || !this.active) return;
                const start = this.clock();
                try { await this.sample(); }
                catch (error) {
                    this.running = false;
                    this.fault = true;
                    this.onError(error);
                    return;
                }
                if (this.running && this.active) this.timer = setTimeout(() => { this.pollPromise = poll(); }, Math.max(0, this.interval - (this.clock() - start)));
            };
            this.pollPromise = poll();
        }
        async pause() {
            const wasRunning = this.running;
            this.running = false; clearTimeout(this.timer);
            await this.pollPromise;
            if (wasRunning) {
                for (const state of this.pins.values()) {
                    state.history.push(this.clock(), null, state.level, true);
                    state.read = null; state.adcRaw = null; state.lastRead = null; state.samplePeriod = null;
                }
            }
        }
        async release() {
            await this.pause();
            return this.queue.run(async () => {
                const errors = [];
                if (this.readOnly) { this.pins.clear(); return; }
                for (const peripheral of [...this.peripheralSessions]) {
                    try { await peripheral.closeUnqueued(); } catch (error) { errors.push(error); }
                }
                for (const id of this.pins.keys()) {
                    try { await this.transport.write(this.bank(id).enableClear, bit(id)); } catch (error) { errors.push(error); }
                }
                try { await this.adc?.close(); } catch (error) { errors.push(error); }
                if (this.transport.supports?.('CAPTURE')) try { await this.transport.captureRelease(); } catch (error) { errors.push(error); }
                if (errors.length) { this.fault = true; throw new AggregateError(errors, 'GPIO-/ADC-Freigabe unvollständig.'); }
                this.pins.clear();
            });
        }
        async close() {
            if (this.peripheralSessions.size && !this.transport.closed) await this.release();
            this.active = false;
            await this.pause();
            await this.queue.close();
        }
    }

    // Explicit offline preview; the UI always labels it as a simulation.
    class DemoTransport {
        constructor(chip, clock = now) { this.chip = chip; this.clock = clock; this.simulation = true; this.registers = new Map(); this.closed = false; this.pinDescriptors = new Map(chip.pins.map(pin => [pin.id, pin])); this.adcModel = adcAPI.createADCModel(chip, this.registers, clock); this.sdModel = sdAPI?.createSDModel(chip, this.registers); this.i2cModel = i2cAPI?.createI2CModel(chip, this.registers); }
        async read(address) {
            if (this.closed) throw new Error('Demo beendet.');
            if (this.chip.gpio.inputOverrides && Object.values(this.chip.gpio.inputOverrides).some(source => source.address === address))
                return Math.floor(this.clock() / 350) % 2;
            const sd = this.sdModel?.read(address); if (sd !== undefined) return sd;
            const i2c = this.i2cModel?.read(address); if (i2c !== undefined) return i2c;
            const banks = [...this.chip.gpio.banks, ...(this.adcModel?.padRoute ? [this.adcModel.padRoute.bank] : [])];
            const bankIndex = banks.findIndex(bank => bank.input === address);
            if (bankIndex >= 0) {
                const bank = banks[bankIndex];
                const enabled = this.registers.get(bank.enable) || 0;
                const out = this.registers.get(bank.output) || 0;
                let inputs = 0;
                for (let offset = 0; offset < 32; offset++) {
                    const pin = (bankIndex < this.chip.gpio.banks.length ? bankIndex * 32 : 0) + offset;
                    const route = bankIndex >= this.chip.gpio.banks.length ? this.adcModel.padRoute : null;
                    const fields = route || this.chip.gpio;
                    const mux = this.registers.get(route ? route.mux + pin * 4 : this.pinDescriptors.get(pin)?.mux) || 0;
                    const high = mux & fields.pullUp ? 1 : mux & fields.pullDown ? 0 : Math.floor(this.clock() / (110 + pin * 43)) % 2;
                    if (high) inputs = (inputs | bit(pin)) >>> 0;
                }
                return ((inputs & ~enabled) | (out & enabled)) >>> 0;
            }
            return this.registers.get(address) || 0;
        }
        async write(address, value, mask = 0xffffffff) {
            if (this.closed) throw new Error('Demo beendet.');
            if (this.sdModel?.write(address, value, mask)) return;
            if (this.i2cModel?.write(address, value, mask)) return;
            if (this.adcModel?.write(address, value, mask)) return;
            for (const bank of [...this.chip.gpio.banks, ...(this.adcModel?.padRoute ? [this.adcModel.padRoute.bank] : [])]) {
                for (const [set, clear, destination] of [[bank.set, bank.clear, bank.output], [bank.enableSet, bank.enableClear, bank.enable]]) {
                    if (address === set || address === clear) {
                        const old = this.registers.get(destination) || 0;
                        this.registers.set(destination, (address === set ? old | value : old & ~value) >>> 0);
                        return;
                    }
                }
            }
            const old = this.registers.get(address) || 0;
            this.registers.set(address, ((old & ~mask) | (value & mask)) >>> 0);
        }
        close() { this.closed = true; }
    }
    const api = { RegisterTransport, GPIOController, History, DemoTransport };
    if (typeof module === 'object' && module.exports) module.exports = api;
    else Object.assign(root.ESPIO ||= {}, api);
})(globalThis);
