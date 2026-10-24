(function (root) {
    'use strict';
    const sdProfiles = typeof module === 'object' && module.exports ? require('./configs/sd.js') : root.ESPIO.sdProfiles;
    const roles = ['d0', 'd1', 'd2', 'd3', 'cmd', 'clk'];
    const specs = {
        cmd0: { index: 0, response: 'none', name: 'CMD0 · Reset / Idle', argument: 0 },
        cmd8: { index: 8, response: 'r7', name: 'CMD8 · Interface Condition', argument: 0x1aa },
        acmd41: { index: 41, response: 'r3', app: true, name: 'ACMD41 · OCR / Power-up', argument: 0x40ff8000 },
        cmd2: { index: 2, response: 'r2', name: 'CMD2 · All Send CID', argument: 0 },
        cmd3: { index: 3, response: 'r6', name: 'CMD3 · RCA zuweisen', argument: 0 },
        cmd9: { index: 9, response: 'r2', name: 'CMD9 · CSD lesen', rca: true },
        cmd7: { index: 7, response: 'r1b', name: 'CMD7 · Karte auswählen', rca: true },
        cmd13: { index: 13, response: 'r1', name: 'CMD13 · Kartenstatus', rca: true },
        cmd55: { index: 55, response: 'r1', name: 'CMD55 · APP_CMD', rca: true },
    };
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    const abort = signal => { if (signal?.aborted) throw new DOMException('SD-Vorgang abgebrochen.', 'AbortError'); };
    const hex = value => '0x' + (value >>> 0).toString(16).padStart(8, '0');
    class SDError extends Error {
        constructor(message, code = 'SD_PROTOCOL') { super(message); this.name = 'SDError'; this.code = code; }
    }
    // Bounded disk writes avoid one File System Access call per 512-byte RPC.
    // On a write failure truncate to the last acknowledged batch, then close.
    class SDFileWriter {
        constructor(file) { this.file = file; this.buffer = new Uint8Array(64 * 1024); this.pending = 0; this.saved = 0; this.failed = false; }
        async write(data) {
            if (this.failed) throw new Error('SD-Dateiausgabe ist fehlgeschlagen.');
            if (!(data instanceof Uint8Array) || data.length !== 512) throw new Error('Nur vollständige 512-Byte-Sektoren speichern.');
            this.buffer.set(data, this.pending); this.pending += data.length;
            if (this.pending === this.buffer.length) await this.flush();
        }
        async flush() {
            if (!this.pending || this.failed) return;
            try { await this.file.write(this.buffer.subarray(0, this.pending)); this.saved += this.pending; this.pending = 0; }
            catch (error) { this.failed = true; throw error; }
        }
        async close() {
            try { await this.flush(); }
            finally {
                try { if (this.failed) await this.file.truncate(this.saved); }
                finally { await this.file.close(); }
            }
        }
    }
    function validateSDConfig(chip, pins, config) {
        if (!sdProfiles[chip.id]) throw new Error('SD-Steuerung für diesen Chip noch nicht implementiert.');
        if (![1, 4].includes(config.width)) throw new Error('SD-Busbreite muss 1 oder 4 sein.');
        if (config.power && config.power !== 'external') throw new Error('Versorgung separat im LDO4-Block und über GPIO steuern; SDMMC schaltet keine Versorgung.');
        const mapped = {}, used = new Set();
        for (const role of roles) {
            const id = config.pins?.[role];
            if (id === null || id === undefined || id === '') {
                if (['d0', 'cmd', 'clk'].includes(role) || config.width === 4) throw new Error(`${role.toUpperCase()} muss zugewiesen sein.`);
                continue;
            }
            const pin = chip.pins.find(pin => pin.id === id);
            if (!Number.isInteger(id) || !pin || pin.reserved || !pin.output || !pins.has(id)) throw new Error(`${role.toUpperCase()}: GPIO${id} ist nicht verfügbar.`);
            if (used.has(id)) throw new Error(`GPIO${id} ist mehrfach zugewiesen.`);
            used.add(id); mapped[role] = id;
        }
        const clockHz = config.clockHz ?? 400000;
        if (![400000, 1000000, 5000000, 20000000].includes(clockHz) || (chip.id !== 'esp32p4' && clockHz !== 400000)) throw new Error('Lesetakt für diesen Chip nicht unterstützt.');
        return { pins: mapped, width: config.width, clockHz };
    }
    function responseBits(words, shift, length) {
        let value = 0n;
        words.forEach((word, index) => { value |= BigInt(word >>> 0) << BigInt(index * 32); });
        return Number((value >> BigInt(shift)) & ((1n << BigInt(length)) - 1n));
    }
    function decodeCID(words) {
        const b = (shift, length) => responseBits(words, shift, length), revision = b(56, 8), date = b(8, 12);
        return { manufacturer: b(120, 8), oem: String.fromCharCode(b(112, 8), b(104, 8)),
            product: [96, 88, 80, 72, 64].map(shift => String.fromCharCode(b(shift, 8))).join(''),
            revision: `${revision >>> 4}.${revision & 15}`, serial: hex(b(24, 32)),
            year: 2000 + (date >>> 4), month: date & 15 };
    }
    function decodeCSD(words) {
        const b = (shift, length) => responseBits(words, shift, length), version = b(126, 2);
        let capacityBytes = null;
        if (version === 0) capacityBytes = (b(62, 12) + 1) * 2 ** (b(47, 3) + 2) * 2 ** b(80, 4);
        if (version === 1) capacityBytes = (b(48, 22) + 1) * 512 * 1024;
        return { version, capacityBytes, permanentWriteProtect: !!b(13, 1), temporaryWriteProtect: !!b(12, 1) };
    }
    function sectorRange(card, first = 0, last = 'max') {
        const size = card?.csd?.capacityBytes;
        if (!Number.isSafeInteger(size) || size < 512 || size % 512) throw new Error('Zuerst eine Karte mit bekannter Sektorkapazität identifizieren.');
        const maximum = size / 512 - 1;
        const parse = value => typeof value === 'number' ? value : /^\d+$/.test(String(value).trim()) ? Number(value) : NaN;
        const start = parse(first), end = String(last).trim().toLowerCase() === 'max' ? maximum : parse(last);
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end > maximum) throw new Error(`Sektorbereich muss zwischen 0 und ${maximum} liegen; Ende ist inklusive.`);
        return { start, end, sectors: end - start + 1, bytes: (end - start + 1) * 512, maximum };
    }
    const r1Errors = [
        [31, 'OUT_OF_RANGE'], [30, 'ADDRESS_ERROR'], [29, 'BLOCK_LEN_ERROR'], [28, 'ERASE_SEQ_ERROR'],
        [27, 'ERASE_PARAM'], [26, 'WP_VIOLATION'], [25, 'CARD_IS_LOCKED'], [24, 'LOCK_UNLOCK_FAILED'],
        [23, 'COM_CRC_ERROR'], [22, 'ILLEGAL_COMMAND'], [21, 'CARD_ECC_FAILED'], [20, 'CC_ERROR'],
        [19, 'ERROR'], [16, 'CSD_OVERWRITE'], [15, 'WP_ERASE_SKIP'], [13, 'ERASE_RESET'], [3, 'AKE_SEQ_ERROR'],
    ];
    function checkR1(value, name) {
        const errors = r1Errors.filter(([bit]) => value & 2 ** bit).map(([, text]) => text);
        if (errors.length) throw new SDError(`${name}: ${errors.join(', ')} (${hex(value)}).`, 'SD_CARD_STATUS');
    }

    // The GPIO controller owns the single register queue and all pin leases.
    // Accelerated P4 executes complete commands/DMA locally in the RAM stub.
    // Legacy transports retain the register backend. No card block writes.
    class SDHost {
        constructor(controller, { onCommand = () => {}, timeoutMs = 1500 } = {}) {
            this.controller = controller; this.transport = controller.transport;
            this.profile = sdProfiles[controller.chip.id]; this.onCommand = onCommand;
            this.timeoutMs = timeoutMs; this.saved = new Map(); this.pinStates = new Map();
            this.config = null; this.ready = false; this.card = null; this.rca = 0; this.width = 1;
            this.needsReset = false; this.padsTouched = false;
            this.rpcSD = controller.chip.id === 'esp32p4' && !!this.transport.supports?.('SDMMC');
            this.rpcReady = false;
            this.clockHz = this.profile?.clockHz;
        }
        async remember(address, mask = 0xffffffff) {
            mask >>>= 0;
            const saved = this.saved.get(address) || { value: 0, mask: 0 };
            const fresh = (mask & ~saved.mask) >>> 0;
            if (fresh) {
                const old = await this.transport.read(address);
                saved.value = ((saved.value & ~fresh) | (old & fresh)) >>> 0;
                saved.mask = (saved.mask | mask) >>> 0; this.saved.set(address, saved);
            }
        }
        async set(address, value, mask = 0xffffffff) {
            await this.remember(address, mask);
            await this.transport.write(address, value, mask);
        }
        async wait(address, predicate, label, signal) {
            const deadline = this.controller.clock() + this.timeoutMs;
            for (let count = 0; count < 512; count++) {
                abort(signal);
                const value = await this.transport.read(address);
                if (predicate(value)) return value >>> 0;
                if (this.controller.clock() >= deadline) break;
                if (count % 16 === 15) await sleep(0);
            }
            throw new SDError(`${label}: Timeout. CLK/CMD/D0, Versorgung und Pull-ups prüfen.`, 'SD_TIMEOUT');
        }
        async reset(signal) {
            const r = this.profile.registers;
            // Self-clearing reset bits must never be saved or replayed.
            await this.transport.write(r.control, 7, 7);
            await this.wait(r.control, value => !(value & 7), 'SD-Controller-Reset', signal);
            await this.set(r.control, 0, 1 << 4 | 1 << 5 | 1 << 25); // raw polling, no interrupts or DMA
            await this.set(r.interruptMask, 0);
            await this.set(r.dma, 0, 1 << 7);
            await this.set(r.timeout, 0xffffffff);
            await this.transport.write(r.events, 0xffff); // W1C, not a restorable configuration
        }
        async updateClock(signal) {
            const { registers: r, flags: f, slot } = this.profile;
            await this.transport.write(r.events, 1 << 12);
            await this.transport.write(r.command, f.start | f.hold | f.clockUpdate | f.waitData | slot << 16);
            await this.wait(r.command, value => !(value & f.start), 'SD-Taktübernahme', signal);
            if (await this.transport.read(r.events) & 1 << 12) throw new SDError('SD-Taktübernahme: Hardware Lock Error.');
        }
        async clockOn(signal, clockHz = this.profile.clockHz) {
            const r = this.profile.registers;
            await this.set(r.clockEnable, 0, 2 | 2 << 16);
            await this.updateClock(signal);
            await this.set(r.clockSource, 1 << 2, 3 << 2);
            const divider = this.profile.cardDivider * this.profile.clockHz / clockHz;
            await this.set(r.clockDivider, divider << 8, 255 << 8);
            await this.updateClock(signal);
            this.clockHz = clockHz;
            await this.set(r.clockEnable, 2, 2 | 2 << 16); // continuous clock, including idle initialization clocks
            await this.updateClock(signal);
        }
        open(config, signal) {
            const c = this.controller;
            if (!c.active || c.fault || c.scanning) return Promise.reject(new Error('SD-Port ist in dieser Sitzung nicht verfügbar.'));
            let checked;
            try { checked = validateSDConfig(c.chip, c.pins, config); } catch (error) { return Promise.reject(error); }
            return c.queue.run(async () => {
                if (!c.active || c.fault) throw new Error('Sitzung gestoppt.');
                validateSDConfig(c.chip, c.pins, checked);
                if (this.ready) throw new Error('SD-Port zuerst freigeben.');
                for (const id of Object.values(checked.pins)) if (c.pinOwners.has(id)) throw new Error(`GPIO${id} wird bereits verwendet.`);
                this.config = checked; this.card = null; this.rca = 0; this.width = 1;
                try {
                    for (const id of Object.values(checked.pins)) {
                        c.pinOwners.set(id, 'SD'); this.pinStates.set(id, c.pins.get(id));
                    }
                    c.peripheralSessions.add(this);
                    abort(signal);
                    // Snapshot all pads before any mutation, including the
                    // matrix/OE fields needed to release a partial setup.
                    const g = c.chip.gpio;
                    for (const [role, id] of Object.entries(checked.pins)) {
                        // Supply availability is enforced by the GPIO controller.
                        const pin = c.descriptor(id), bank = g.banks[Math.floor(id / 32)], bit = 2 ** (id % 32);
                        for (const [address, mask] of [[bank.enable, bit], [g.matrix + id * 4, g.matrixMask], [pin.mux, g.muxMask], [g.pinConfig + id * 4, g.pinConfigMask], ...pin.digitalRoute.map(op => [op.address, op.mask])]) await this.remember(address, mask);
                        if (role === 'd3') await this.remember(bank.output, bit);
                    }
                    for (const op of this.profile.init) await this.set(op.address, op.value, op.mask);
                    const latch = this.profile.latchClock;
                    if (latch) {
                        await this.set(latch.address, latch.value, latch.mask);
                        await this.set(latch.address, 0, latch.mask);
                    }
                    const hostClock = this.profile.hostClock;
                    if (hostClock) await this.remember(hostClock.address, hostClock.mask);
                    const reset = this.profile.reset;
                    await this.set(reset.address, reset.value, reset.mask);
                    await this.set(reset.address, 0, reset.mask);
                    if (hostClock) await this.set(hostClock.address, hostClock.value, hostClock.mask);
                    await this.reset(signal);
                    const { matrix: m } = this.profile;
                    // Disable host clocks before routing outputs to pads.
                    await this.set(this.profile.registers.clockEnable, 0, 2 | 2 << 16);
                    this.padsTouched = true;
                    for (const [role, id] of Object.entries(checked.pins)) {
                        const pin = c.descriptor(id), bank = g.banks[Math.floor(id / 32)], bit = 2 ** (id % 32);
                        await this.set(bank.enable, 0, bit);
                        for (const op of pin.digitalRoute) await this.set(op.address, 0, op.mask);
                        await this.set(g.pinConfig + id * 4, 0, g.pinConfigMask);
                        await this.set(pin.mux, g.muxGPIO | (role !== 'clk' ? g.pullUp : 0), g.muxMask);
                        if (role !== 'clk') await this.set(m.inputBase + m.signals[role] * 4, id | m.inputEnable, m.inputMask);
                        // D3 stays HIGH during CMD0, ensuring native SD mode.
                        if (role === 'd3') {
                            await this.set(bank.output, bit, bit);
                            await this.set(g.matrix + id * 4, g.matrixGPIO, g.matrixMask);
                        } else await this.set(g.matrix + id * 4, m.signals[role], g.matrixMask);
                        await this.set(bank.enable, bit, bit);
                        c.pins.set(id, { ...c.pins.get(id), mode: 'sd', level: null, read: null, adcRaw: null });
                    }
                    for (const [index, value] of [[m.detect, m.constantLow], [m.writeProtect, m.constantLow], [m.cardInterrupt, m.constantHigh]]) {
                        await this.set(m.inputBase + index * 4, value | m.inputEnable, m.inputMask);
                    }
                    await this.set(this.profile.registers.width, 0, 2 | 2 << 16);
                    await this.clockOn(signal); await sleep(10); abort(signal);
                    if (this.rpcSD) {
                        // Keep the same leases/restoration path; reserve every
                        // configuration register touched by the local DMA driver.
                        const r = this.profile.registers;
                        for (const [address, mask] of [[r.blockSize, 0xffff], [r.byteCount, 0xffffffff], [r.fifoThreshold, 0xffffffff], [r.descriptorList, 0xffffffff], [r.dma, 0xfffffffe], [r.dmaStatus + 4, 0xffffffff]]) await this.remember(address, mask);
                        await this.transport.sdmmcConfigure(); this.rpcReady = true;
                    }
                    this.ready = true; this.needsReset = false;
                } catch (error) {
                    try { await this.closeUnqueued(); } catch (restore) { throw new AggregateError([error, restore], 'SD-Initialisierung und Freigabe fehlgeschlagen.'); }
                    throw error;
                }
            });
        }
        async command(spec, argument, signal) {
            abort(signal);
            if (spec.index === 7 && argument === 0) spec = { ...spec, response: 'none' };
            if (this.rpcSD) return this.commandRPC(spec, argument, signal);
            const { registers: r, flags: f, slot } = this.profile;
            let flags = f.start | f.hold | slot << 16 | spec.index;
            flags |= spec.index === 0 ? f.initialClocks : f.waitData;
            if (spec.response !== 'none') flags |= f.response;
            if (spec.response === 'r2') flags |= f.longResponse;
            if (spec.dataBytes) flags |= f.dataExpected;
            if (!['none', 'r3'].includes(spec.response)) flags |= f.crc;
            const entry = { command: `${spec.app ? 'ACMD' : 'CMD'}${spec.index}`, argument: argument >>> 0, responseType: spec.response, startedAt: this.controller.clock() };
            try {
                await this.wait(r.command, value => !(value & f.start), 'SD-Kommandoregister', signal);
                await this.transport.write(r.events, 0xffff);
                await this.transport.write(r.argument, argument);
                await this.transport.write(r.command, flags);
                await this.wait(r.command, value => !(value & f.start), `${entry.command} Übernahme`, signal);
                const event = await this.wait(r.events, value => !!(value & (4 | 2 | 64 | 256 | 4096)), entry.command, signal);
                entry.events = event;
                if (event & 256) throw new SDError(`${entry.command}: keine Kartenantwort (Response Timeout).`, 'SD_RESPONSE_TIMEOUT');
                if (event & 4096) throw new SDError(`${entry.command}: Hardware Lock Error.`, 'SD_HOST_ERROR');
                if (event & 2) throw new SDError(`${entry.command}: ungültige Antwort.`, 'SD_RESPONSE_ERROR');
                if ((flags & f.crc) && (event & 64)) throw new SDError(`${entry.command}: Antwort-CRC fehlerhaft.`, 'SD_CRC');
                if (!(event & 4)) throw new SDError(`${entry.command}: frisches CMD_DONE fehlt.`, 'SD_HOST_ERROR');
                entry.response = [];
                for (let word = 0; word < (spec.response === 'none' ? 0 : spec.response === 'r2' ? 4 : 1); word++) entry.response.push(await this.transport.read(r.response + word * 4));
                const response = entry.response[0];
                if (spec.response === 'r1' || spec.response === 'r1b') checkR1(response, entry.command);
                if (spec.response === 'r6' && (response & 0xe000)) throw new SDError(`${entry.command}: RCA-/R6-Fehler ${hex(response)}.`, 'SD_CARD_STATUS');
                if (spec.response === 'r1b') await this.wait(r.status, value => !(value & (1 << 9)), `${entry.command} DAT0 Busy`, signal);
                if (spec.dataBytes) entry.data = await this.receiveData(spec.dataBytes, signal, entry);
                return entry;
            } catch (error) { entry.error = error.message; this.needsReset = true; throw error; }
            finally { entry.finishedAt = this.controller.clock(); this.onCommand(entry); }
        }
        async commandRPC(spec, argument, signal) {
            const entry = { command: `${spec.app ? 'ACMD' : 'CMD'}${spec.index}`, argument: argument >>> 0, responseType: spec.response, startedAt: this.controller.clock(), accelerated: true };
            const capture = result => {
                entry.events = result.events;
                entry.response = spec.response === 'none' ? [] : spec.response === 'r2' ? [result.response0, result.response1, result.response2, result.response3] : [result.response0];
                if (spec.dataBytes) { entry.dataEvents = result.data_events; entry.dma = { transferred: result.transferred, descriptor: result.descriptor, status: result.dma_status }; }
            };
            try {
                const result = await this.transport.sdmmcCommand(spec, argument, Math.min(1500000, Math.max(100, Math.round(this.timeoutMs * 1000))));
                capture(result); abort(signal);
                if (spec.response === 'r1' || spec.response === 'r1b') checkR1(result.response0, entry.command);
                if (spec.response === 'r6' && (result.response0 & 0xe000)) throw new SDError(`${entry.command}: R6-Fehler.`, 'SD_CARD_STATUS');
                if (spec.dataBytes) {
                    if (result.transferred !== spec.dataBytes || result.descriptor & 0xc0000000 || result.data.length !== spec.dataBytes || !(result.data_events & 8) || result.data_events & 0xae80 || result.dma_status & 0x34) throw new SDError('SD-DMA unvollständig/fehlerhaft. Sektor wird nicht gespeichert.', 'SD_SHORT_DATA');
                    entry.data = result.data;
                }
                return entry;
            } catch (error) {
                if (error.response) {
                    capture(error.response);
                    const e = (typeof module === 'object' && module.exports ? require('../stub/protocol.js') : root.ESPIO.rpcProtocol).sdmmcErrors;
                    const codes = { [e.RESPONSE_TIMEOUT]: 'SD_RESPONSE_TIMEOUT', [e.COMMAND_TIMEOUT]: 'SD_TIMEOUT', [e.RESPONSE_CRC]: 'SD_CRC', [e.DATA_CRC]: 'SD_DATA', [e.DATA_TIMEOUT]: 'SD_DATA', [e.SHORT_DATA]: 'SD_SHORT_DATA', [e.CARD_STATUS]: 'SD_CARD_STATUS', [e.BUSY_TIMEOUT]: 'SD_TIMEOUT', [e.DMA]: 'SD_DATA', [e.HOST]: 'SD_HOST_ERROR', [e.NOT_CONFIGURED]: 'SD_HOST_ERROR' };
                    error = new SDError(`${entry.command}: SDMMC RPC ${codes[error.response.sd_error] || error.message} · IRQ ${hex(entry.events)}${entry.dma ? ` · ${entry.dma.transferred}/${spec.dataBytes} Bytes` : ''}`, codes[error.response.sd_error] || 'SD_HOST_ERROR');
                }
                entry.error = error.message; this.needsReset = true; throw error;
            } finally { entry.finishedAt = this.controller.clock(); this.onCommand(entry); }
        }
        async appCommand(spec, argument, signal) {
            const prefix = await this.command(specs.cmd55, this.rca << 16, signal);
            if (!(prefix.response[0] & 32)) throw new SDError('CMD55: APP_CMD wird nicht bestätigt; keine unterstützte SD-Speicherkarte.');
            return this.command(spec, argument, signal);
        }
        // One IDMAC descriptor (DW-MSHC, as in ESP-IDF) receives a sector into a
        // fixed RAM buffer; the FIFO itself is never read by the CPU.
        async armDMA(bytes, signal) {
            const r = this.profile.registers, { address, cpuOffset } = this.profile.dmaBuffer;
            await this.transport.write(r.control, 6, 6); // FIFO + DMA reset (self-clearing)
            await this.wait(r.control, value => !(value & 6), 'SD-FIFO/DMA-Reset', signal);
            await this.transport.write(r.dma, 1, 1); // IDMAC software reset
            await this.wait(r.dma, value => !(value & 1), 'SD-DMA-Reset', signal);
            await this.transport.write(address + cpuOffset + 4, bytes);
            await this.transport.write(address + cpuOffset + 8, address + 64);
            await this.transport.write(address + cpuOffset + 12, address);
            await this.transport.write(address + cpuOffset, 0x8000002e); // OWN | ER | FS | LD | DIC
            await this.transport.write(r.dmaStatus, 0x3ff);
            await this.transport.write(r.dma, 1 << 7 | 1 << 1); // IDMAC enable, fixed burst
            await this.transport.write(r.descriptorList, address);
            await this.transport.write(r.control, 1 << 5 | 1 << 25, 1 << 5 | 1 << 25);
            await this.transport.write(r.pollDemand, 1);
        }
        async disarmDMA() {
            await this.transport.write(this.profile.registers.control, 0, 1 << 5 | 1 << 25);
            await this.transport.write(this.profile.registers.dma, 0);
        }
        async receiveData(bytes, signal, entry = {}) {
            const r = this.profile.registers, errorMask = 1 << 7 | 1 << 9 | 1 << 10 | 1 << 11 | 1 << 13 | 1 << 15;
            const event = await this.wait(r.events, value => !!(value & (8 | errorMask)), 'SD-Datenphase', signal);
            entry.dataEvents = event;
            if (event & errorMask) throw new SDError(`SD-Datenfehler: ${event & 128 ? 'Daten-CRC' : event & 512 ? 'Daten-Timeout' : event & 2048 ? 'FIFO-Überlauf' : 'Start-/Endbit oder Host-Timeout'} (${hex(event)}).`, 'SD_DATA');
            const { address, cpuOffset } = this.profile.dmaBuffer;
            const transferred = await this.transport.read(r.transferred) >>> 0, descriptor = await this.transport.read(address + cpuOffset) >>> 0;
            entry.dma = { transferred, descriptor };
            if (transferred !== bytes || descriptor & 0x80000000) {
                entry.dma.status = await this.transport.read(r.dmaStatus) >>> 0;
                throw new SDError(`SD-DMA unvollständig: ${transferred}/${bytes} Bytes, DES0=${hex(descriptor)}, IDSTS=${hex(entry.dma.status)}. Sektor wird nicht gespeichert.`, 'SD_SHORT_DATA');
            }
            const data = new Uint8Array(bytes), view = new DataView(data.buffer);
            for (let word = 0; word < bytes / 4; word++) {
                abort(signal);
                view.setUint32(word * 4, await this.transport.read(address + cpuOffset + 64 + word * 4), true);
            }
            return data;
        }
        async download({ start = 0, end = 'max', signal, write, onProgress = () => {} } = {}) {
            if (this.downloading) throw new Error('SD-Download läuft bereits.');
            const range = sectorRange(this.card, start, end);
            if (typeof write !== 'function') throw new Error('Kein Dateiziel für den SD-Download.');
            const c = this.controller, resume = c.running;
            this.downloading = true; let completed = 0;
            const startedAt = c.clock();
            const report = () => {
                const elapsedMs = Math.max(0, c.clock() - startedAt), bytes = completed * 512;
                const bytesPerSecond = elapsedMs > 0 ? bytes / elapsedMs * 1000 : 0;
                onProgress({ ...range, completed, bytesWritten: bytes, elapsedMs, bytesPerSecond,
                    etaSeconds: bytesPerSecond > 0 ? (range.bytes - bytes) / bytesPerSecond : null });
            };
            try {
                await c.pause();
                return await this.run(async () => {
                    if (!this.card || this.needsReset) throw new Error('Karte vor dem Download erneut identifizieren.');
                    const r = this.profile.registers;
                    if (!this.rpcSD) await this.set(r.fifoThreshold, 1, 0x77ff0fff); // DMA request per word, single transfers
                    if (!(this.card.ocr & 0x40000000)) await this.command({ index: 16, response: 'r1' }, 512, signal);
                    if (!this.rpcSD) { await this.set(r.blockSize, 512, 0xffff); await this.set(r.byteCount, 512); }
                    report();
                    try {
                        for (let sector = range.start; sector <= range.end; sector++) {
                            abort(signal);
                            const argument = this.card.ocr & 0x40000000 ? sector : sector * 512;
                            if (argument > 0xffffffff) throw new Error('SD-Byteadresse überschreitet 32 Bit.');
                            if (!this.rpcSD) await this.armDMA(512, signal);
                            const entry = await this.command({ index: 17, response: 'r1', dataBytes: 512 }, argument, signal);
                            abort(signal);
                            await write(entry.data); // backpressure; never buffer the entire card
                            completed++; report();
                            if (completed % 8 === 0) await sleep(0);
                        }
                    } finally { if (this.ready && !this.rpcSD) await this.disarmDMA(); }
                    return { ...range, completed, bytesWritten: completed * 512 };
                }, signal);
            } finally {
                this.downloading = false;
                if (resume && c.active && !c.fault) c.start();
            }
        }
        run(callback, signal) {
            return this.controller.queue.run(async () => {
                if (!this.ready || !this.controller.active || this.controller.fault) throw new Error('SD-Port zuerst aktivieren.');
                try { return await callback(); }
                catch (error) {
                    if (error.name === 'AbortError') await this.closeUnqueued();
                    throw error;
                }
            });
        }
        send(key, argument, signal) {
            const spec = specs[key];
            if (!spec || !Number.isInteger(argument) || argument < 0 || argument > 0xffffffff) return Promise.reject(new Error('Ungültiges SD-Kommando oder 32-Bit-Argument.'));
            return this.run(async () => {
                if (this.needsReset && key !== 'cmd0') throw new Error('Nach einem SD-Fehler zuerst die Karte erneut identifizieren.');
                if (key === 'cmd0') await this.holdD3High();
                const result = await (spec.app ? this.appCommand(spec, argument, signal) : this.command(spec, argument, signal));
                if (key === 'cmd0') { this.card = null; this.rca = 0; this.width = 1; this.needsReset = false; await this.set(this.profile.registers.width, 0, 2 | 2 << 16); }
                if (key === 'cmd3') this.rca = result.response[0] >>> 16;
                return result;
            }, signal);
        }
        identify(signal) {
            return this.run(async () => {
                this.card = null; this.rca = 0; this.width = 1;
                if (this.needsReset) { await this.reset(signal); await this.clockOn(signal); }
                else if (this.clockHz !== this.profile.clockHz) await this.clockOn(signal);
                if (this.rpcSD) await this.transport.sdmmcConfigure();
                this.needsReset = false;
                await this.set(this.profile.registers.width, 0, 2 | 2 << 16);
                await this.holdD3High();
                await this.command(specs.cmd0, 0, signal); await sleep(10);
                let v2 = true;
                try {
                    const condition = (await this.command(specs.cmd8, 0x1aa, signal)).response[0];
                    if (condition & 1 << 22) v2 = false;
                    else if ((condition & 0xfff) !== 0x1aa) throw new SDError(`CMD8: Spannungs-/Prüfmuster stimmt nicht (${hex(condition)}).`);
                } catch (error) { if (error.code === 'SD_RESPONSE_TIMEOUT') v2 = false; else throw error; }
                this.needsReset = false; // CMD8 timeout is expected for legacy SD cards
                const deadline = this.controller.clock() + 3000; let ocr = 0;
                do {
                    abort(signal);
                    ocr = (await this.appCommand(specs.acmd41, (v2 ? 0x40000000 : 0) | 0x00ff8000, signal)).response[0];
                    if (ocr & 0x80000000) break;
                    if (this.controller.clock() >= deadline) throw new SDError('ACMD41: Karte wird nicht bereit.', 'SD_POWER_TIMEOUT');
                    await sleep(10);
                } while (true);
                if (!(ocr & 0x00ff8000)) throw new SDError('OCR: kein gemeinsamer Spannungsbereich für 3,3-V-SD.');
                const cid = (await this.command(specs.cmd2, 0, signal)).response;
                this.rca = (await this.command(specs.cmd3, 0, signal)).response[0] >>> 16;
                if (!this.rca) throw new SDError('CMD3: keine gültige RCA erhalten.');
                const csd = (await this.command(specs.cmd9, this.rca << 16, signal)).response;
                await this.command(specs.cmd7, this.rca << 16, signal);
                if (this.config.width === 4) {
                    await this.appCommand({ index: 6, response: 'r1', app: true }, 2, signal);
                    await this.set(this.profile.registers.width, 2, 2 | 2 << 16);
                    this.width = 4;
                    const d3 = this.config.pins.d3, g = this.controller.chip.gpio;
                    await this.set(g.matrix + d3 * 4, this.profile.matrix.signals.d3, g.matrixMask);
                }
                const status = (await this.command(specs.cmd13, this.rca << 16, signal)).response[0];
                if (((status >>> 9) & 15) !== 4 || !(status & 256)) throw new SDError(`Karte nicht bereit im Transferzustand: ${hex(status)}.`);
                if (this.config.clockHz !== this.profile.clockHz) await this.clockOn(signal, this.config.clockHz);
                return this.card = { rca: this.rca, ocr, type: ocr & 0x40000000 ? 'SDHC / SDXC' : 'SDSC',
                    cid: decodeCID(cid), csd: decodeCSD(csd), rawCID: cid, rawCSD: csd,
                    status, width: this.width, clockHz: this.clockHz };
            }, signal);
        }
        close() { return this.controller.queue.run(() => this.closeUnqueued()); }
        async holdD3High() {
            const id = this.config.pins.d3; if (id === undefined) return;
            const g = this.controller.chip.gpio, bank = g.banks[Math.floor(id / 32)], bit = 2 ** (id % 32);
            await this.set(bank.output, bit, bit);
            await this.set(g.matrix + id * 4, g.matrixGPIO, g.matrixMask);
            await this.set(bank.enable, bit, bit);
        }
        async closeUnqueued() {
            const c = this.controller, errors = [], attempt = async fn => { try { await fn(); } catch (error) { errors.push(error); } };
            if (this.rpcReady) {
                await attempt(() => this.transport.sdmmcRelease());
                this.rpcReady = false;
            }
            // Disconnect peripheral OE before touching/restoring any pad state.
            for (const id of this.padsTouched ? this.pinStates.keys() : []) {
                const bank = c.chip.gpio.banks[Math.floor(id / 32)], bit = 2 ** (id % 32);
                await attempt(() => this.transport.write(bank.enableClear, bit));
                await attempt(() => this.transport.write(c.chip.gpio.matrix + id * 4, c.chip.gpio.matrixGPIO, c.chip.gpio.matrixMask));
            }
            if (this.saved.has(this.profile.registers.clockEnable)) await attempt(() => this.transport.write(this.profile.registers.clockEnable, 0, 2));
            // Restore shared register fields; never replay CMD, W1C status or reset bits.
            const enables = new Set(c.chip.gpio.banks.map(bank => bank.enable));
            for (const [address, saved] of [...this.saved].reverse()) if (!enables.has(address)) await attempt(() => this.transport.write(address, saved.value, saved.mask));
            if (!errors.length) for (const [address, saved] of this.saved) if (enables.has(address)) await attempt(() => this.transport.write(address, saved.value, saved.mask));
            if (errors.length) for (const id of this.pinStates.keys()) {
                const bank = c.chip.gpio.banks[Math.floor(id / 32)];
                await attempt(() => this.transport.write(bank.enableClear, 2 ** (id % 32)));
            }
            for (const [id, state] of this.pinStates) {
                state.read = null; state.adcRaw = null; state.lastRead = null; state.history.samples = [];
                if (errors.length) { state.mode = 'unknown'; state.level = null; }
                c.pins.set(id, state); c.pinOwners.delete(id);
            }
            this.saved.clear(); this.pinStates.clear(); c.peripheralSessions.delete(this);
            this.ready = false; this.card = null; this.rca = 0; this.padsTouched = false;
            if (errors.length) { c.fault = true; c.running = false; clearTimeout(c.timer); throw new AggregateError(errors, 'SD-Pins/Controller konnten nicht vollständig freigegeben werden. Neu verbinden.'); }
        }
    }

    function createSDModel(chip, registers) {
        const p = sdProfiles[chip.id]; if (!p) return null;
        const r = p.registers, f = p.flags;
        const words = value => Array.from({ length: 4 }, (_, i) => Number(value >> BigInt(i * 32) & 0xffffffffn));
        const cid = words(3n << 120n | 0x5344n << 104n | 0x44454d4f34n << 64n | 0x12n << 56n | 0x12345678n << 24n | 0x19an << 8n);
        const csd = words(1n << 126n | 0x32n << 96n | 9n << 80n | 16383n << 48n);
        const model = { present: true, legacy: false, neverReady: false, stuckStart: false, crcError: false,
            busy: false, pendingApp: false, attempts: 0, state: 0, width: 1, rca: 0x1234, commands: [],
            dataCRCError: false, shortData: false, dataTimeout: false,
            read() { return undefined; },
            write(address, value, mask = 0xffffffff) {
                if (address === r.events || address === r.dmaStatus) { registers.set(address, ((registers.get(address) || 0) & ~(value & mask)) >>> 0); return true; }
                if ((address === r.control && (value & mask & 7)) || (address === r.dma && (value & mask & 1))) {
                    registers.set(address, (((registers.get(address) || 0) & ~mask | value & mask) & ~(address === r.dma ? 1 : 7)) >>> 0);
                    if (address === r.control && (value & 1)) registers.set(r.command, 0);
                    if (address === r.control && (value & 2)) registers.set(r.status, (registers.get(r.status) || 0) & ~p.fifo.countMask);
                    if (address === r.dma) registers.set(r.transferred, 0);
                    return true;
                }
                if (address !== r.command) return false;
                registers.set(address, (value & ~(model.stuckStart ? 0 : f.start)) >>> 0);
                if (!(value & f.start) || model.stuckStart || (value & f.clockUpdate)) return true;
                const index = value & 63, argument = registers.get(r.argument) || 0, app = model.pendingApp;
                model.pendingApp = false; model.commands.push({ index, argument, app, value: value >>> 0 });
                let response = [256 | model.state << 9], event = 4;
                if ((!model.present && (value & f.response)) || (index === 8 && model.legacy)) event = 256;
                else if (model.crcError) event = 4 | 64;
                else if (index === 0) { model.state = 0; model.width = 1; model.attempts = 0; response = []; }
                else if (index === 8) response = [0x1aa];
                else if (index === 55) { model.pendingApp = true; response[0] |= 32; }
                else if (index === 41 && app) {
                    model.attempts++; const ready = !model.neverReady && model.attempts >= 2;
                    if (ready) model.state = 1;
                    response = [(0x00ff8000 | (!model.legacy ? 0x40000000 : 0) | (ready ? 0x80000000 : 0)) >>> 0];
                } else if (index === 2) { response = cid; model.state = 2; }
                else if (index === 3) { model.state = 3; response = [model.rca << 16 | 3 << 9 | 256]; }
                else if (index === 9) response = model.legacy ? words(4095n << 62n | 7n << 47n | 9n << 80n | 0x32n << 96n) : csd;
                else if (index === 7) { model.state = argument ? 4 : 3; response = [256 | model.state << 9]; }
                else if (index === 6 && app) model.width = argument === 2 ? 4 : 1;
                else if (index === 16) { if (argument !== 512) response[0] |= 1 << 29; }
                else if (index === 17 && (value & f.dataExpected)) {
                    const sector = model.legacy ? argument / 512 : argument, b = p.dmaBuffer;
                    const armed = (registers.get(r.dma) & 1 << 7) && (registers.get(r.control) & 1 << 25) && registers.get(r.descriptorList) === b.address;
                    const cpu = b.address + b.cpuOffset, descriptor = registers.get(cpu) >>> 0;
                    if (armed && (descriptor & 0x80000000) && !model.dataTimeout && !model.dataCRCError) {
                        const count = model.shortData ? 127 : 128;
                        for (let word = 0; word < count; word++) {
                            let data = 0; for (let byte = 0; byte < 4; byte++) data |= ((sector * 17 + word * 4 + byte) & 255) << (byte * 8);
                            registers.set(registers.get(cpu + 8) + b.cpuOffset + word * 4, data >>> 0);
                        }
                        registers.set(r.transferred, count * 4);
                        if (!model.shortData) registers.set(cpu, (descriptor & ~0x80000000) >>> 0);
                    }
                    event |= model.dataTimeout ? 1 << 9 : model.dataCRCError ? 1 << 7 : 8;
                }
                else if (index !== 13) response[0] |= 1 << 22;
                for (let i = 0; i < 4; i++) registers.set(r.response + i * 4, (response[i] || 0) >>> 0);
                registers.set(r.status, model.busy ? 1 << 9 : 0); registers.set(r.events, event);
                return true;
            }
        };
        return model;
    }
    const api = { SDHost, SDFileWriter, sdProfiles, sdCommands: specs, sdRoles: roles, validateSDConfig, decodeCID, decodeCSD, sectorRange, createSDModel };
    if (typeof module === 'object' && module.exports) module.exports = api;
    else Object.assign(root.ESPIO ||= {}, api);
})(globalThis);
