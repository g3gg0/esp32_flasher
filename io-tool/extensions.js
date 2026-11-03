(function (root) {
    'use strict';
    // Extension host for the I/O Lab. An extension is a plain JavaScript file
    // that assigns its definition to `module.exports`; see extensions/README.md.
    const INTERFACE_KINDS = ['i2c', 'spi', 'rmt', 'pwm'];
    const KIND_NAMES = { i2c: 'I²C', spi: 'SPI', rmt: 'RMT', pwm: 'PWM' };
    const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,47}$/i;
    const hex = (value, digits = 2) => '0x' + (value >>> 0).toString(16).toUpperCase().padStart(digits, '0');
    const sleep = (ms, signal) => new Promise((resolve, reject) => {
        if (signal?.aborted) return reject(new DOMException('Extension stopped.', 'AbortError'));
        const timer = setTimeout(resolve, ms);
        signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new DOMException('Extension stopped.', 'AbortError')); }, { once: true });
    });

    function parseExtension(source, origin = 'extension') {
        if (typeof source !== 'string' || !source.trim()) throw new Error('Extension file is empty.');
        const module = { exports: {} };
        // Extensions run with the privileges of this page; callers must confirm untrusted files.
        new Function('module', 'exports', `${source}\n//# sourceURL=extension:${origin}`)(module, module.exports);
        return validateDefinition(module.exports, origin);
    }
    function validateDefinition(def, origin) {
        if (!def || typeof def !== 'object') throw new Error(`${origin}: module.exports must be an object.`);
        if (typeof def.id !== 'string' || !ID_PATTERN.test(def.id)) throw new Error(`${origin}: "id" must be 1–48 letters, digits, "-" or "_".`);
        if (typeof def.name !== 'string' || !def.name.trim()) throw new Error(`${origin}: "name" is required.`);
        if (typeof def.load !== 'function') throw new Error(`${origin}: "load(api)" is required.`);
        if (def.unload !== undefined && typeof def.unload !== 'function') throw new Error(`${origin}: "unload" must be a function.`);
        const names = new Set();
        const unique = name => { if (typeof name !== 'string' || !/^[A-Za-z_]\w*$/.test(name) || names.has(name)) throw new Error(`${origin}: invalid or duplicate requirement id "${name}".`); names.add(name); };
        const interfaces = (def.interfaces || []).map(item => {
            unique(item.id);
            const kinds = item.kinds || (item.kind ? [item.kind] : []);
            if (!kinds.length || kinds.some(kind => !INTERFACE_KINDS.includes(kind))) throw new Error(`${origin}: interface "${item.id}" needs kinds from ${INTERFACE_KINDS.join(', ')}.`);
            return { id: item.id, kinds, label: item.label || item.id, optional: !!item.optional };
        });
        const gpios = (def.gpios || []).map(item => {
            unique(item.id);
            const mode = item.mode || 'input';
            if (!['input', 'output'].includes(mode)) throw new Error(`${origin}: GPIO "${item.id}" has an invalid mode.`);
            return { id: item.id, label: item.label || item.id, mode, pull: item.pull || 'none', level: item.level ? 1 : 0, optional: !!item.optional, hint: item.hint || '' };
        });
        return { id: def.id, name: def.name, version: def.version || '', description: def.description || '', author: def.author || '', interfaces, gpios, load: def.load, unload: def.unload };
    }

    class ExtensionManager {
        // ctx: controller(), chip(), board(), pins(), session(), hosts{kind: () => host}, ui, log,
        //      blocked(), setOperation(bool), changed()
        constructor(ctx) { this.ctx = ctx; this.entries = new Map(); this.claims = new Map(); }
        get list() { return [...this.entries.values()]; }
        emit() { try { this.ctx.changed?.(); } catch (error) { this.ctx.log?.('Extension UI:', error.message); } }

        install(source, origin) {
            const def = parseExtension(source, origin);
            if (this.entries.has(def.id)) throw new Error(`Extension "${def.id}" is already loaded.`);
            const entry = { id: def.id, def, origin, state: 'idle', error: '', interfaceChoice: {}, gpioChoice: {}, blocks: new Set(), handles: new Map(), abort: null, controller: null };
            this.entries.set(def.id, entry);
            this.emit();
            return entry;
        }
        async loadSource(source, origin) {
            const entry = this.install(source, origin);
            if (!entry.def.interfaces.length && !entry.def.gpios.length) await this.start(entry.id);
            return entry;
        }

        availableInterfaces(decl) {
            const controller = this.ctx.controller(), found = [];
            for (const kind of decl.kinds) {
                const host = this.ctx.hosts[kind]?.();
                if (host?.ready && host.controller === controller) found.push({ kind, host, label: this.describeHost(kind, host) });
            }
            return found;
        }
        describeHost(kind, host) {
            const config = host.config || {}, pins = Object.entries(config).filter(([key, value]) => ['sda', 'scl', 'clk', 'mosi', 'miso', 'cs', 'pin'].includes(key) && Number.isInteger(value));
            const port = Number.isInteger(config.port) ? (kind === 'spi' ? `SPI${config.port + 1}` : kind === 'i2c' ? `I²C${config.port}` : `${KIND_NAMES[kind]} ${config.port}`) : KIND_NAMES[kind];
            return `${port} · ${pins.map(([key, value]) => `${key.toUpperCase()}=IO${value}`).join(' ')}`.trim();
        }
        selectedInterface(entry, decl) {
            const options = this.availableInterfaces(decl), wanted = entry.interfaceChoice[decl.id];
            return options.find(option => option.kind === wanted) || (options.length === 1 ? options[0] : null);
        }
        freeGpios(entry, decl) {
            const controller = this.ctx.controller();
            return this.ctx.pins().filter(id => {
                const pin = this.ctx.chip().pins.find(item => item.id === id);
                if (!pin || pin.mux == null || (decl.mode === 'output' && !pin.output)) return false;
                if (controller?.pinOwners.has(id)) return false;
                const claim = this.claims.get(id);
                return !claim || claim === entry.id;
            }).sort((a, b) => a - b);
        }
        // Returns the reason the extension cannot start, or '' when all requirements are met.
        missing(entry) {
            if (!this.ctx.controller()) return 'Verbinden oder Demo starten.';
            for (const decl of entry.def.interfaces) if (!decl.optional && !this.selectedInterface(entry, decl)) {
                return this.availableInterfaces(decl).length ? `${decl.label}: Schnittstelle wählen.` : `${decl.label}: ${decl.kinds.map(kind => KIND_NAMES[kind]).join(' / ')} im Peripherie-Block aktivieren.`;
            }
            const chosen = new Set();
            for (const decl of entry.def.gpios) {
                const id = entry.gpioChoice[decl.id];
                if (!Number.isInteger(id)) { if (!decl.optional) return `${decl.label}: GPIO wählen.`; continue; }
                if (chosen.has(id)) return `IO${id} ist doppelt zugewiesen.`;
                chosen.add(id);
            }
            return '';
        }

        async start(id) {
            const entry = this.entries.get(id);
            if (!entry) throw new Error(`Unknown extension "${id}".`);
            if (entry.state === 'active' || entry.state === 'starting') return;
            const problem = this.missing(entry);
            if (problem) throw new Error(problem);
            const controller = this.ctx.controller();
            entry.state = 'starting'; entry.error = ''; entry.controller = controller; entry.abort = new AbortController();
            const claimed = [];
            try {
                const bound = {}, gpios = {};
                for (const decl of entry.def.interfaces) bound[decl.id] = this.selectedInterface(entry, decl);
                for (const decl of entry.def.gpios) {
                    const pin = entry.gpioChoice[decl.id];
                    if (!Number.isInteger(pin)) { gpios[decl.id] = null; continue; }
                    if (this.claims.has(pin) && this.claims.get(pin) !== entry.id) throw new Error(`IO${pin} wird von Extension "${this.claims.get(pin)}" verwendet.`);
                    if (controller.pinOwners.has(pin)) throw new Error(`IO${pin} wird von ${controller.pinOwners.get(pin)} verwendet.`);
                    this.claims.set(pin, entry.id); claimed.push(pin);
                    gpios[decl.id] = this.gpioHandle(entry, pin, decl);
                    // Declared defaults are applied up front, so the extension starts from a known pin state.
                    await gpios[decl.id].configure(decl.mode, decl.pull, decl.level);
                }
                entry.api = this.buildApi(entry, bound, gpios);
                this.emit();
                await entry.def.load(entry.api);
                entry.state = 'active';
            } catch (error) {
                entry.error = error.message || String(error);
                await this.teardown(entry);
                entry.state = 'error';
                this.ctx.log?.(`${entry.def.name}:`, entry.error);
                this.emit();
                throw error;
            }
            this.emit();
        }

        async teardown(entry) {
            entry.abort?.abort();
            try { if (entry.api) await entry.def.unload?.(entry.api); }
            catch (error) { this.ctx.log?.(`${entry.def.name} unload:`, error.message); }
            for (const block of [...entry.blocks]) block.remove();
            entry.blocks.clear();
            const live = entry.controller && entry.controller === this.ctx.controller() && !entry.controller.fault;
            for (const handle of [...entry.handles.values()]) {
                try { await handle.release(live); } catch (error) { this.ctx.log?.(`${entry.def.name} GPIO${handle.id}:`, error.message); }
            }
            entry.handles.clear();
            for (const [pin, owner] of [...this.claims]) if (owner === entry.id) this.claims.delete(pin);
            entry.api = null; entry.abort = null; entry.controller = null;
        }
        async stop(id) {
            const entry = this.entries.get(id);
            if (!entry || (entry.state !== 'active' && entry.state !== 'error' && entry.state !== 'starting')) return;
            await this.teardown(entry);
            entry.state = 'idle'; entry.error = '';
            this.emit();
        }
        async unload(id) {
            const entry = this.entries.get(id);
            if (!entry) return;
            await this.stop(id);
            this.entries.delete(id);
            this.emit();
        }
        // Session, board or chip changed: hosts and pins of running extensions are gone.
        async reset() {
            for (const entry of this.list) if (entry.state !== 'idle') { await this.teardown(entry); entry.state = 'idle'; }
            this.emit();
        }

        gpioHandle(entry, id, decl = {}) {
            const manager = this, controller = entry.controller;
            const handle = {
                id, configured: false,
                async configure(mode = decl.mode || 'input', pull = decl.pull || 'none', level = decl.level || 0) {
                    await controller.configure(id, mode, pull, level);
                    handle.configured = true;
                    return handle;
                },
                write(level) { return controller.setLevel(id, level ? 1 : 0); },
                // Latest polled level; null until the sampler has read the pin.
                read() { return controller.pins.get(id)?.read ?? null; },
                async release(restore = true) {
                    if (restore && handle.configured) await controller.configure(id, 'input', 'none');
                    handle.configured = false; entry.handles.delete(id);
                    if (manager.claims.get(id) === entry.id) manager.claims.delete(id);
                }
            };
            entry.handles.set(id, handle);
            return handle;
        }

        buildApi(entry, bound, gpios) {
            const manager = this, ctx = this.ctx, controller = entry.controller, signal = entry.abort.signal, chip = ctx.chip(), board = ctx.board();
            const first = kind => Object.values(bound).find(item => item?.kind === kind)?.host || ctx.hosts[kind]?.() || null;
            const interfaces = Object.fromEntries(Object.entries(bound).map(([key, item]) => [key, item && { kind: item.kind, host: item.host, label: item.label, config: { ...item.host.config } }]));
            const api = {
                version: 1, signal,
                esp: {
                    chip: { id: chip.id, name: chip.name }, board: { id: board.id, name: board.name }, session: ctx.session(),
                    pins: ctx.pins().slice().sort((a, b) => a - b),
                    capabilities: Object.fromEntries([...INTERFACE_KINDS, 'flash'].map(kind => [kind, !!controller.transport.supports?.(kind.toUpperCase())])),
                    identity: controller.transport.identity || null
                },
                gpios, interfaces,
                // Shortcuts to the first bound/active host of each kind.
                get i2c() { return first('i2c'); }, get spi() { return first('spi'); }, get rmt() { return first('rmt'); }, get pwm() { return first('pwm'); },
                // Any pin that is not owned by a peripheral can be claimed ad hoc.
                gpio(id) {
                    if (!ctx.pins().includes(id)) throw new Error(`IO${id} ist auf diesem Board nicht verfügbar.`);
                    if (controller.pinOwners.has(id)) throw new Error(`IO${id} wird von ${controller.pinOwners.get(id)} verwendet.`);
                    if (manager.claims.has(id) && manager.claims.get(id) !== entry.id) throw new Error(`IO${id} wird von Extension "${manager.claims.get(id)}" verwendet.`);
                    manager.claims.set(id, entry.id);
                    return entry.handles.get(id) || manager.gpioHandle(entry, id);
                },
                // Raw access for everything not wrapped above: register read/write and the GPIO controller.
                controller, registers: { read: address => controller.transport.read(address), write: (address, value, mask) => controller.transport.write(address, value, mask) },
                log: (...parts) => ctx.log(`${entry.def.name}:`, ...parts),
                sleep: ms => sleep(ms, signal),
                util: { hex, sleep: (ms, abort = signal) => sleep(ms, abort), parseHex: ctx.parseHex || (text => Uint8Array.from(text.trim().split(/[\s,;]+/).filter(Boolean), part => parseInt(part.replace(/^0x/i, ''), 16))) },
                // Serialises a long-running task with the lab's own operations and reports failures.
                async run(task) {
                    if (ctx.blocked()) throw new Error('Das Lab ist gerade beschäftigt.');
                    ctx.setOperation(true);
                    try { return await task(signal); }
                    finally { ctx.setOperation(false); }
                },
                ui: {
                    // Blocks are tracked here so unloading removes them even if the extension forgets to.
                    block(title, options) {
                        const block = ctx.ui.block(entry, title, options, api), remove = block.remove.bind(block);
                        block.remove = () => { entry.blocks.delete(block); remove(); };
                        entry.blocks.add(block);
                        return block;
                    }
                }
            };
            return api;
        }
    }

    const api = { ExtensionManager, parseExtension, validateDefinition, extensionInterfaceKinds: INTERFACE_KINDS };
    if (typeof module === 'object' && module.exports) module.exports = api;
    else Object.assign(root.ESPIO ||= {}, api);
})(globalThis);
