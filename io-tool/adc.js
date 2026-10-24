(function (root) {
    'use strict';
    const profiles = typeof module === 'object' && module.exports ? require('./configs/adc.js') : root.ESPIO.adcProfiles;
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    const abortError = () => new DOMException('Scan abgebrochen.', 'AbortError');
    const checkAbort = signal => { if (signal?.aborted) throw abortError(); };

    // All operations run under GPIOController.queue. Save only modified fields;
    // never replay read-only status or W1C bits when restoring shared registers.
    class ADCReader {
        constructor(transport, profile, { clock = () => performance.now() } = {}) {
            this.transport = transport; this.profile = profile; this.clock = clock;
            this.saved = new Map(); this.ready = false; this.lastChannel = null;
            this.analogSaved = new Map(); this.calibration = null; this.busAddress = null;
        }
        channel(id) { return this.profile.channels[id] || null; }
        async set(address, value, mask = 0xffffffff, delayUs = 0) {
            mask >>>= 0;
            const previous = this.saved.get(address) || { value: 0, mask: 0 };
            const fresh = (mask & ~previous.mask) >>> 0;
            if (fresh) {
                const original = await this.transport.read(address);
                previous.value = ((previous.value & ~fresh) | (original & fresh)) >>> 0;
                previous.mask = (previous.mask | mask) >>> 0;
                this.saved.set(address, previous);
            }
            await this.transport.write(address, value, mask, delayUs);
        }
        async open() {
            if (this.ready) return;
            try {
                for (const op of this.profile.init) await this.set(op.address, op.value, op.mask);
                await this.openAnalog();
                // Register transactions already exceed the analog power-up delay.
                await sleep(2);
                this.ready = true;
            } catch (error) {
                try { await this.close(); } catch (restore) { throw new AggregateError([error, restore], 'ADC-Initialisierung und Wiederherstellung fehlgeschlagen.'); }
                throw error;
            }
        }
        async busIdle() {
            const start = this.clock();
            for (let attempt = 0; attempt < 24; attempt++) {
                const value = await this.transport.read(this.busAddress);
                if (!(value & (1 << 25))) return value;
                if (this.clock() - start > 350) break;
            }
            throw new Error('ADC Analog-I²C: BUSY-Timeout.');
        }
        async analogRead(register) {
            await this.busIdle();
            await this.transport.write(this.busAddress, this.profile.analog.block | register << 8 | (this.profile.analog.bus.commandMask || 0));
            return (await this.busIdle() >>> 16) & 255;
        }
        async analogWrite(register, value) {
            await this.busIdle();
            await this.transport.write(this.busAddress, this.profile.analog.block | register << 8 | (value & 255) << 16 | 1 << 24 | (this.profile.analog.bus.commandMask || 0));
            await this.busIdle();
        }
        async analogSet({ register, mask, value }) {
            const old = await this.analogRead(register);
            const saved = this.analogSaved.get(register) || { value: 0, mask: 0 };
            const fresh = mask & ~saved.mask;
            saved.value |= old & fresh; saved.mask |= mask; this.analogSaved.set(register, saved);
            await this.analogWrite(register, (old & ~mask) | (value & mask));
            if ((await this.analogRead(register) & mask) !== (value & mask)) throw new Error(`ADC Analog-I²C: Register ${register} wurde nicht übernommen.`);
        }
        async efuse(field) {
            let value = BigInt(await this.transport.read(field.address)) >> BigInt(field.shift);
            if (field.shift + field.bits > 32) value |= BigInt(await this.transport.read(field.address + 4)) << BigInt(32 - field.shift);
            return Number(value & ((1n << BigInt(field.bits)) - 1n));
        }
        async openAnalog() {
            const { analog, hardwareCalibration: cal } = this.profile;
            const major = await this.efuse(cal.major), minor = cal.minor ? await this.efuse(cal.minor) : 0;
            const version = cal.minor ? major * 100 + minor : major;
            // P4 ESP-IDF v5.5.2 removes v5.5.1's obsolete <100 bound;
            // block major >=1 does not mean missing ADC factory trim.
            const exactVersionOne = ['esp32c3', 'esp32s3'].includes(this.profile.chip);
            const minVersion = cal.minVersion || 1;
            const valid = exactVersionOne ? version === 1 : version >= minVersion;
            if (!valid) throw new Error(`ADC: ${this.profile.chip.toUpperCase()} eFuse-Blockversion ${major}.${minor} (${version}) wird nicht unterstützt. ${exactVersionOne ? 'Erwartet Version 1.' : `Erwartet eine Version ab ${minVersion}.`} Hardware-Selbstkalibrierung ohne passende eFuse-Daten ist noch nicht implementiert.`);
            for (const op of analog.bus.init) await this.set(op.address, op.value, op.mask);
            this.busAddress = analog.bus.control;
            if (analog.bus.select && !(await this.transport.read(analog.bus.select) & analog.bus.selectBit)) this.busAddress += 4;
            for (const op of analog.init) await this.analogSet(op);
            this.calibration = { source: 'efuse', version, blockVersion: { major, minor }, codes: {} };
            for (const [unit, info] of Object.entries(cal.units)) {
                let code = info.offset ?? cal.offset;
                for (const field of info.efuses || [info.efuse]) code += await this.efuse(field);
                if (code > 4095) throw new Error(`ADC${unit}: eFuse-Hardwarekalibrierung außerhalb von 12 Bit: ${code}.`);
                this.calibration.codes[unit] = code;
                await this.analogSet({ ...info.high, value: code >>> 8 });
                await this.analogSet({ ...info.low, value: code & 255 });
            }
        }
        async waitDone(address, mask, signal, asserted = true) {
            const start = this.clock();
            for (let attempt = 0; attempt < 24; attempt++) {
                checkAbort(signal);
                const value = await this.transport.read(address);
                if (!!(value & mask) === asserted) return value >>> 0;
                if (this.clock() - start > 350) break;
            }
            throw new Error(asserted ? 'ADC-Konvertierung: kein frisches DONE-Signal. Messung gestoppt.' : 'ADC-Konvertierung: RTC-SAR bleibt belegt. Messung gestoppt.');
        }
        async convert(channel, signal) {
            checkAbort(signal);
            const p = this.profile;
            if (p.kind === 'digital-sar') {
                const s = p.sample;
                const value = ((channel.channel << s.channel.shift) | (p.attenuation << s.attenuation.shift)) >>> 0;
                const mask = (s.channel.mask | s.attenuation.mask | s.start | s.disableMask) >>> 0;
                let completed = false;
                try {
                    // WRITE_REG delay establishes a minimum start-low interval
                    // even on native USB. It is not a GPIO pulse timer.
                    await this.set(s.address, value, mask, 10);
                    await this.transport.write(s.clear, s.done); // W1C, never snapshot
                    checkAbort(signal);
                    const startedAt = this.clock();
                    await this.set(s.address, value | s.enable | s.start, mask);
                    await this.waitDone(s.status, s.done, signal);
                    this.lastTiming = { startedAt, doneAt: this.clock() };
                    // H2 needs five SAR clocks for data synchronization after
                    // DONE. Mask zero leaves the sample register unchanged;
                    // WRITE_REG's device-side delay avoids relying on USB lag.
                    if (s.dataDelayUs) await this.transport.write(s.address, 0, 0, s.dataDelayUs);
                    checkAbort(signal);
                    const raw = (await this.transport.read(s.data)) & p.max;
                    completed = true; return raw;
                } finally { if (!completed) await this.set(s.address, 0, s.start | s.disableMask); }
            }
            const unit = p.units[channel.unit], padIndex = channel.channel + unit.channelOffset;
            const attenMask = (3 << (padIndex * 2)) >>> 0;
            const pad = (2 ** padIndex << unit.pad.shift) >>> 0;
            let completed = false;
            try {
                if (unit.idle) await this.waitDone(unit.idle.address, unit.idle.mask, signal, false);
                await this.set(unit.attenuation, p.attenuation << (padIndex * 2), attenMask);
                await this.set(unit.control, unit.force | pad, unit.force | unit.pad.mask | unit.start);
                checkAbort(signal);
                const startedAt = this.clock();
                await this.set(unit.control, unit.start, unit.start);
                const data = await this.waitDone(unit.control, unit.done, signal);
                this.lastTiming = { startedAt, doneAt: this.clock() };
                const raw = data & 0xffff;
                if (raw & (unit.invalidMask || 0)) throw new Error(`ADC${channel.unit}: ungültiges RTC-SAR-Ergebnis (Arbiter-Status).`);
                if (raw > p.max) throw new Error(`ADC-Rohwert außerhalb von ${p.bits} Bit: ${raw}.`);
                completed = true; return raw;
            } finally { if (!completed) await this.set(unit.control, 0, unit.start | unit.pad.mask); }
        }
        async read(id, signal) {
            const channel = this.channel(id);
            if (!channel) throw new Error(`GPIO${id}: kein unterstützter ADC-Kanal.`);
            await this.open(); checkAbort(signal);
            const key = `${channel.unit}:${channel.channel}`;
            if (key !== this.lastChannel) {
                // Discard first conversion after switching the sample capacitor.
                await this.convert(channel, signal); this.lastChannel = key;
            }
            const raw = await this.convert(channel, signal);
            const timing = this.lastTiming;
            return { raw, value: raw / this.profile.max, t: (timing.startedAt + timing.doneAt) / 2,
                ...timing, receivedAt: this.clock(), unit: channel.unit, channel: channel.channel };
        }
        async close() {
            const errors = [];
            // Restore analog state while its power/clock/master selection is
            // still available. Command/status words must never be replayed.
            for (const [register, state] of [...this.analogSaved].reverse()) {
                try {
                    const old = await this.analogRead(register);
                    await this.analogWrite(register, (old & ~state.mask) | (state.value & state.mask));
                    if ((await this.analogRead(register) & state.mask) !== (state.value & state.mask)) throw new Error(`ADC Analog-I²C: Wiederherstellung von Register ${register} fehlgeschlagen.`);
                }
                catch (error) { errors.push(error); }
            }
            this.analogSaved.clear(); this.busAddress = null;
            for (const [address, state] of [...this.saved].reverse()) {
                try { await this.transport.write(address, state.value, state.mask); }
                catch (error) { errors.push(error); }
            }
            this.ready = false; this.lastChannel = null; this.saved.clear();
            if (errors.length) throw new AggregateError(errors, 'ADC-Register konnten nicht vollständig wiederhergestellt werden.');
        }
    }

    function classifyUsage(result, max = 4095) {
        if (result.method === 'observe') return { label: 'Nur Eingangsmessung', interpretation: 'Dieser Pin unterstützt die gewählte Testansteuerung nicht; nur den Istwert beobachtet.', span: null, drift: null, saturated: false, note: 'Keine Last- oder Richtungsanalyse.' };
        if (result.measurement === 'digital') return { label: 'Nur digital gemessen', interpretation: 'GPIO-Istwerte unter der Testansteuerung; kein ADC-Messwert verfügbar.', span: null, drift: null, saturated: false, note: 'Keine analoge Last- oder Pull-Widerstands-Analyse.' };
        const low = result.low.at(-1).raw, high = result.high.at(-1).raw;
        const span = (high - low) / max;
        const drift = Math.max(Math.abs(result.low.at(-1).raw - result.low[0].raw), Math.abs(result.high.at(-1).raw - result.high[0].raw)) / max;
        const saturated = [...result.low, ...result.high].some(sample => sample.raw <= 8 || sample.raw >= max - 8);
        let label, interpretation;
        if (span < -.08) { label = 'Widersprüchliche Reaktion'; interpretation = 'Signal wechselte extern oder Messung ist unzuverlässig.'; }
        else if (span >= .65) { label = 'Folgt deutlich'; interpretation = result.method === 'pull' ? 'Hohe Impedanz / schwache Last ist plausibel.' : 'Pin folgt der Ansteuerung; geringe Last ist möglich, aber nicht bewiesen.'; }
        else if (span >= .18) { label = 'Folgt teilweise'; interpretation = 'Last, Pull-Widerstand oder externe Ansteuerung möglich.'; }
        else { label = 'Kaum Reaktion'; interpretation = 'Starke Last, externe Ansteuerung oder ungeeignete ADC-Messung möglich.'; }
        const assessment = { label, interpretation, span, drift, saturated,
            note: `${drift > .12 ? 'Deutliche Änderung im Messfenster. ' : ''}${saturated ? 'ADC am Messbereichsrand: Lastunterschiede können verdeckt sein. ' : ''}Zeitauflösung durch Registertransport begrenzt; keine eindeutige Input-/Output-Erkennung.` };
        const pull = result.runs?.find(run => run.method === 'pull'), drive = result.runs?.find(run => run.method === 'drive');
        if (pull && drive) {
            const tail = (run, phase) => run[phase]?.at(-1)?.raw / max;
            const driveFollows = tail(drive, 'low') <= .18 && tail(drive, 'high') >= .82 && tail(drive, 'returnLow') <= .18;
            if (driveFollows && tail(pull, 'low') >= .65 && tail(pull, 'returnLow') >= .65 && tail(pull, 'high') >= .82) {
                assessment.label = 'Pull-up plausibel';
                assessment.interpretation = 'Interner Pull-down lässt den Pegel hoch; Output LOW zieht ihn herunter. Das passt zu einem externen Pull-up. Eine andere externe Ansteuerung ist ebenfalls möglich.';
            } else if (driveFollows && tail(pull, 'high') <= .35 && tail(pull, 'low') <= .18 && tail(pull, 'returnLow') <= .18) {
                assessment.label = 'Pull-down plausibel';
                assessment.interpretation = 'Interner Pull-up hebt den Pegel kaum an; Output HIGH erreicht einen hohen Pegel. Das passt zu einem externen Pull-down. Eine andere externe Ansteuerung ist ebenfalls möglich.';
            } else if (driveFollows && tail(pull, 'low') <= .18 && tail(pull, 'high') >= .82 && tail(pull, 'returnLow') <= .18) {
                assessment.label = 'Folgt auch schwachen Pulls';
                assessment.interpretation = 'LOW und HIGH werden schon mit internen Pulls erreicht. Hohe Impedanz / geringe Last ist plausibel.';
            }
            assessment.comparedMethods = true;
            assessment.saturated ||= [...pull.low, ...pull.high, ...pull.returnLow].some(sample => sample.raw <= 8 || sample.raw >= max - 8);
        }
        return assessment;
    }

    // Called inside the controller queue with polling paused. Work on one pin
    // at a time and restore physical register values rather than UI defaults.
    async function scanPin(controller, id, { method, settleMs, signal, onPhase = () => {} }) {
        const pin = controller.descriptor(id), adc = controller.adc;
        const hasADC = !!adc?.channel(id);
        const requestedMethods = method === 'compare' ? ['pull', 'drive'] : [method];
        const methods = requestedMethods.filter(mode => mode === 'pull' ? pin.pulls : pin.output);
        const skippedMethods = requestedMethods.filter(mode => !methods.includes(mode));
        if (!methods.length) methods.push('observe');
        const actualMethod = methods.length > 1 ? 'compare' : methods[0];
        const padRoute = hasADC ? adc.profile.padRoute : null, previousRouting = controller.adcScanRouting;
        const bank = padRoute?.bank || controller.bank(id), bit = (2 ** (id % 32)) >>> 0, gpio = controller.chip.gpio;
        const testGPIO = padRoute || gpio, testMux = padRoute ? padRoute.mux + id * 4 : pin.mux;
        const hpBank = gpio.banks[Math.floor(id / 32)];
        // FUN_DRV[11:10] is shared by every pinned GPIO profile's IO MUX.
        const strength = adc?.profile.driveStrength || { mask: 3 << 10, shift: 10 };
        const snapshots = [];
        for (const [address, mask] of [[pin.mux, gpio.muxMask | strength.mask], [gpio.matrix + id * 4, gpio.matrixMask], [gpio.pinConfig + id * 4, gpio.pinConfigMask], ...pin.digitalRoute.map(op => [op.address, op.mask])]) {
            snapshots.push({ address, mask: mask >>> 0, value: await controller.transport.read(address) });
        }
        if (padRoute) {
            for (const [address, mask] of [[testMux, padRoute.muxMask | strength.mask], [padRoute.pinConfig + id * 4, padRoute.pinConfigMask]]) snapshots.push({ address, mask, value: await controller.transport.read(address) });
        }
        const originalEnable = (await controller.transport.read(bank.enable)) & bit;
        const originalOutput = (await controller.transport.read(bank.output)) & bit;
        const hpEnable = padRoute ? (await controller.transport.read(hpBank.enable)) & bit : 0;
        const originalState = controller.pins.get(id);
        const result = { id, method: actualMethod, requestedMethod: method, skippedMethods, measurement: hasADC ? 'adc' : 'digital',
            baseline: null, low: [], high: [], returnLow: [], runs: [], startedAt: controller.clock(),
            calibration: hasADC ? structuredClone(adc.calibration) : null, timing: 'Host intervals around serial commands; no device clock timestamps.' };
        let primaryError, restoreErrors = [];
        const readSample = async () => {
            checkAbort(signal);
            const analog = hasADC ? await adc.read(id, signal) : null;
            const ioStartedAt = controller.clock();
            const io = (await controller.transport.read(bank.input) & bit) ? 1 : 0;
            const ioDoneAt = controller.clock();
            return { ...(analog || { raw: null, value: null, t: (ioStartedAt + ioDoneAt) / 2, startedAt: ioStartedAt, doneAt: ioDoneAt, receivedAt: ioDoneAt }), io, ioStartedAt, ioDoneAt };
        };
        const collect = async (run, phase) => {
            onPhase(id, `${run.method} ${phase.name}`); checkAbort(signal);
            const samples = [];
            // No poll delay, no channel changes, no animation work in the
            // sampling loop. Two samples minimum, bounded memory/work in demo.
            do {
                checkAbort(signal);
                const read = await readSample();
                const sample = { ...read, elapsedMs: read.t - phase.ackAt, phase: phase.name };
                samples.push(sample); run.samples.push(sample);
                // In-memory simulation would otherwise starve browser events.
                if (samples.length % 16 === 0) await sleep(0);
            } while (samples.length < 2 || (samples.length < 256 && controller.clock() - phase.ackAt < settleMs));
            return samples;
        };
        try {
            controller.adcScanRouting = hasADC;
            checkAbort(signal);
            await controller.configurePin(id, 'input', 'none');
            result.baseline = await readSample();
            // Warm up the selected ADC channel before switching the test signal.
            for (const mode of methods) {
                checkAbort(signal);
                await controller.configurePin(id, 'input', 'none');
                if (mode === 'drive') {
                    if (padRoute) await adc.set(testMux, 0, strength.mask);
                    else await controller.transport.write(testMux, 0, strength.mask);
                    await controller.configurePin(id, 'output', 'none', 0);
                }
                const run = { method: mode, measurement: result.measurement, startedAt: controller.clock(), samples: [], phases: [], initialLevel: mode === 'drive' ? 0 : null };
                result.runs.push(run);
                // Acquisition starts before the edge; plots show actual samples
                // and command uncertainty, not an invented instantaneous slope.
                const before = await readSample();
                run.samples.push({ ...before, phase: 'before' });
                for (const [name, level] of mode === 'observe' ? [['observe', null]] : [['low', 0], ['high', 1], ['return-low', 0]]) {
                    checkAbort(signal);
                    const phase = { name, level, sentAt: controller.clock() };
                    if (mode === 'pull') await controller.transport.write(testMux, level ? testGPIO.pullUp : testGPIO.pullDown, testGPIO.pullUp | testGPIO.pullDown);
                    else if (mode === 'drive') await controller.transport.write(level ? bank.set : bank.clear, bit);
                    phase.ackAt = controller.clock(); run.phases.push(phase);
                    const samples = await collect(run, phase);
                    phase.finishedAt = controller.clock();
                    if (name === 'low') run.low = samples;
                    else if (name === 'high') run.high = samples;
                    else if (name === 'return-low') run.returnLow = samples;
                }
                await controller.transport.write(bank.enableClear, bit);
                run.finishedAt = controller.clock();
                run.assessment = classifyUsage(run, adc?.profile.max);
                // Preserve summary fields for consumers of the original export.
                result.low = run.low || []; result.high = run.high || []; result.returnLow = run.returnLow || [];
                if (mode === 'drive') {
                    result.lowDriveMs = run.phases[1].ackAt - run.phases[0].ackAt + run.finishedAt - run.phases[2].ackAt;
                    result.highDriveMs = run.phases[2].ackAt - run.phases[1].ackAt;
                }
            }
            result.finishedAt = controller.clock();
            result.assessment = classifyUsage(result, adc?.profile.max);
        } catch (error) { primaryError = error; }
        finally {
            // Always first release test drive, even on cancel/ADC timeout. Try
            // all restoration steps if one fails; never claim successful restore.
            const restore = async callback => { try { await callback(); } catch (error) { restoreErrors.push(error); } };
            await restore(() => controller.transport.write(bank.enableClear, bit));
            if (padRoute) await restore(() => controller.transport.write(hpBank.enableClear, bit));
            for (const state of snapshots.reverse()) await restore(() => controller.transport.write(state.address, state.value, state.mask));
            await restore(() => controller.transport.write(originalOutput ? bank.set : bank.clear, bit));
            if (originalEnable && !restoreErrors.length) await restore(() => controller.transport.write(bank.enableSet, bit));
            if (hpEnable && !restoreErrors.length) await restore(() => controller.transport.write(hpBank.enableSet, bit));
            controller.adcScanRouting = previousRouting;
            if (originalState) {
                controller.pins.set(id, originalState);
                originalState.read = null; originalState.adcRaw = null; originalState.lastRead = null;
                originalState.history.samples = [];
                if (restoreErrors.length) { originalState.mode = 'unknown'; originalState.level = null; }
            }
        }
        if (restoreErrors.length) throw new AggregateError([...(primaryError ? [primaryError] : []), ...restoreErrors], `GPIO${id}: Wiederherstellung unvollständig; Verbindung neu starten.`);
        if (primaryError) throw primaryError;
        result.restoredAt = controller.clock();
        return result;
    }

    // Register-level demo model, also used behind the simulated flasher in QA.
    function createADCModel(chip, registers, clock) {
        const p = profiles[chip.id]; if (!p) return null;
        const analogRegisters = new Map();
        // Simulate valid, nonzero factory trim. Tests can overwrite shadows.
        const seedField = (field, value) => {
            const bits = BigInt(value) << BigInt(field.shift);
            registers.set(field.address, ((registers.get(field.address) || 0) | Number(bits & 0xffffffffn)) >>> 0);
            if (field.shift + field.bits > 32) registers.set(field.address + 4, Number(bits >> 32n));
        };
        const cal = p.hardwareCalibration;
        seedField(cal.minor || cal.major, cal.minVersion || 1);
        for (const info of Object.values(cal.units)) {
            if (info.efuses) info.efuses.forEach((field, index) => seedField(field, [17, 23, 31, 43][index]));
            else seedField(info.efuse, 350);
        }
        const model = {
            neverDone: false, sources: new Map(), analogRegisters, busBusy: false, padRoute: p.padRoute,
            sample(id) {
                if (model.sources.has(id)) return Math.round(model.sources.get(id)() * p.max);
                const pin = chip.pins.find(pin => pin.id === id), mask = 2 ** (id % 32);
                const route = p.padRoute && ((registers.get(p.padRoute.select) || 0) & mask) ? p.padRoute : null;
                const bank = route?.bank || chip.gpio.banks[Math.floor(id / 32)], fields = route || chip.gpio;
                const mux = registers.get(route ? route.mux + id * 4 : pin.mux) || 0, enabled = (registers.get(bank.enable) || 0) & mask;
                const high = (registers.get(bank.output) || 0) & mask;
                let value;
                if (id % 3 === 2) value = .33; // external stiff signal
                else if (enabled) value = id % 3 === 1 ? (high ? .63 : .12) : (high ? .98 : .015);
                else if (mux & fields.pullUp) value = id % 3 === 1 ? .55 : .94;
                else if (mux & fields.pullDown) value = id % 3 === 1 ? .30 : .04;
                else value = .45 + .3 * Math.sin(clock() / (190 + id * 17));
                return Math.round(Math.max(0, Math.min(1, value)) * p.max);
            },
            write(address, value, mask = 0xffffffff) {
                if ([p.analog.bus.control, p.analog.bus.control + 4].includes(address)) {
                    const register = (value >>> 8) & 255;
                    if (value & (1 << 24)) analogRegisters.set(register, (value >>> 16) & 255);
                    const data = analogRegisters.get(register) || 0;
                    registers.set(address, ((value & 0x1ffffff & ~(255 << 16)) | data << 16 | (model.busBusy ? 1 << 25 : 0)) >>> 0);
                    return true;
                }
                const old = registers.get(address) || 0;
                const next = ((old & ~mask) | (value & mask)) >>> 0;
                if (p.kind === 'digital-sar') {
                    const s = p.sample;
                    if (address === s.clear) { registers.set(s.status, ((registers.get(s.status) || 0) & ~value) >>> 0); return true; }
                    if (address === s.address) {
                        registers.set(address, next);
                        if ((next & s.start) && !(old & s.start) && (next & s.enable) && !model.neverDone) {
                            const chan = (next & s.channel.mask) >>> s.channel.shift;
                            const id = Object.keys(p.channels).find(id => p.channels[id].channel === chan);
                            registers.set(s.data, model.sample(Number(id)));
                            registers.set(s.status, s.done >>> 0);
                        }
                        return true;
                    }
                } else {
                    for (const [unitId, unit] of Object.entries(p.units)) {
                        if (address !== unit.control) continue;
                        registers.set(address, (next & ~unit.done) >>> 0);
                        if ((next & unit.start) && !(old & unit.start) && !model.neverDone) {
                            const pads = (next & unit.pad.mask) >>> unit.pad.shift;
                            const index = Math.log2(pads) - unit.channelOffset;
                            const id = Object.keys(p.channels).find(id => p.channels[id].unit === Number(unitId) && p.channels[id].channel === index);
                            registers.set(address, ((next & ~0xffff) | model.sample(Number(id)) | unit.done) >>> 0);
                        }
                        return true;
                    }
                }
                return false;
            }
        };
        return model;
    }
    const api = { ADCReader, adcProfiles: profiles, scanPin, classifyUsage, createADCModel };
    if (typeof module === 'object' && module.exports) module.exports = api;
    else Object.assign(root.ESPIO ||= {}, api);
})(globalThis);
