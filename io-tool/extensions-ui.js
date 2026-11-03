(function (root) {
    'use strict';
    const $ = id => document.getElementById(id);
    const KIND_NAMES = { i2c: 'I²C', spi: 'SPI', rmt: 'RMT', pwm: 'PWM' };
    const EXAMPLES = [
        { file: 'extensions/i2c-analyzer.js', name: 'I²C Analyzer · Scan, Geräteerkennung, Registermap' },
        { file: 'extensions/lattice-machxo2.js', name: 'Lattice MachXO2 · Prüfen & SRAM-Programmierung' },
        { file: 'extensions/ws2812.js', name: 'WS2812 / SK6812 · LED-Streifen mit Farbrad (RMT)' },
        { file: 'extensions/gpio-blink.js', name: 'GPIO Blink · Minimalbeispiel mit eigenem UI-Block' }
    ];
    const el = (tag, attributes = {}, ...children) => {
        const node = document.createElement(tag);
        for (const [key, value] of Object.entries(attributes)) {
            if (key === 'class') node.className = value; else if (key === 'text') node.textContent = value; else if (value !== undefined && value !== false) node.setAttribute(key, value === true ? '' : value);
        }
        node.append(...children.filter(Boolean));
        return node;
    };

    // Widget helpers shared by blocks and rows; every action runs through api.run so it is
    // serialised with the lab's own operations and its errors end up in the block status.
    function container(node, block, api) {
        const self = {
            el: node,
            row() { const row = el('div', { class: 'sd-actions' }); node.append(row); return container(row, block, api); },
            text(message, kind = '') { const p = el('p', { class: `sd-note ${kind}`.trim(), text: message }); node.append(p); return p; },
            button(label, handler, { primary = false, title = '', raw = false } = {}) {
                const button = el('button', { text: label, class: primary ? 'primary' : '', title });
                button.addEventListener('click', async () => {
                    if (button.disabled) return;
                    try {
                        block.setStatus('');
                        if (raw) await handler(); else await api.run(() => handler());
                    } catch (error) {
                        if (error.name !== 'AbortError') { block.setStatus(error.message || String(error), 'error'); api.log(error.message || String(error)); }
                    }
                });
                node.append(button);
                return button;
            },
            field(label, { value = '', type = 'text', options = null, width = '', placeholder = '', title = '' } = {}) {
                const input = options ? el('select') : el('input', { type, spellcheck: 'false', placeholder });
                if (options) for (const option of options) input.add(Array.isArray(option) ? new Option(option[1], option[0]) : new Option(String(option), String(option)));
                if (type === 'checkbox') input.checked = !!value; else input.value = String(value);
                if (width) input.style.width = width;
                node.append(el('label', { title }, `${label} `, input));
                return { input, get value() { return type === 'checkbox' ? input.checked : input.value; }, set value(next) { if (type === 'checkbox') input.checked = !!next; else input.value = String(next); } };
            },
            output(initial = '') {
                const pre = el('pre', { class: 'bus-log ext-output', text: initial });
                node.append(pre);
                return { el: pre, set(text) { pre.textContent = text; }, append(line) { pre.textContent += (pre.textContent ? '\n' : '') + line; pre.scrollTop = pre.scrollHeight; }, clear() { pre.textContent = ''; } };
            },
            table(headers) {
                const table = el('table', { class: 'ext-table' }), body = el('tbody');
                table.append(el('thead', {}, el('tr', {}, ...headers.map(text => el('th', { text })))), body);
                node.append(el('div', { class: 'ext-table-wrap' }, table));
                return {
                    el: table,
                    set(rows) { body.replaceChildren(...rows.map(row => el('tr', {}, ...row.map(cell => cell instanceof Node ? el('td', {}, cell) : el('td', { text: String(cell ?? '') }))))); }
                };
            },
            progress() { const bar = el('progress', { max: '1', value: '0' }); node.append(bar); return { el: bar, set(done, total) { bar.max = total || 1; bar.value = done; } }; }
        };
        return self;
    }

    function createBlock(entry, title, options, api) {
        const root = el('div', { class: 'sd-panel ext-block' });
        const heading = el('h3', { text: title }), status = el('span', { class: 'chip-badge ext-status', hidden: true });
        root.append(el('div', { class: 'sd-heading' }, heading, status));
        const body = el('div', { class: 'ext-body' });
        root.append(body);
        const block = {
            root, body,
            setTitle(text) { heading.textContent = text; },
            setStatus(text, kind = '') { status.hidden = !text; status.textContent = text; status.className = `chip-badge ext-status ${kind}`.trim(); },
            remove() { root.remove(); }
        };
        Object.assign(block, container(body, block, api));
        entry.mount?.append(root);
        return block;
    }

    root.ESPIO.createExtensionPanel = function (ctx) {
        const cards = new Map();
        const manager = new root.ESPIO.ExtensionManager({
            ...ctx,
            parseHex: root.ESPIO.parseHexBytes,
            changed: () => refresh(),
            ui: { block: (entry, title, options, api) => createBlock(entry, title, options, api) }
        });
        const list = $('extension-list'), select = $('extension-example'), note = $('extension-note');
        for (const example of EXAMPLES) select.add(new Option(example.name, example.file));

        function setNote(message, kind = '') { note.textContent = message; note.className = `sd-note ${kind}`.trim(); }
        async function guarded(task) {
            try { await task(); setNote(''); } catch (error) { setNote(error.message || String(error), 'error'); ctx.log('Extension:', error.message || String(error)); }
        }
        async function loadExample() {
            const file = select.value;
            let response;
            try { response = await fetch(file); } catch { throw new Error('Beispiele lassen sich nur über einen HTTP-Server laden (nicht per file://).'); }
            if (!response.ok) throw new Error(`${file}: HTTP ${response.status}`);
            await manager.loadSource(await response.text(), file);
        }
        async function loadFiles(files) {
            for (const file of files) {
                if (!window.confirm(root.ESPIO.i18n.t(`„${file.name}“ wird mit vollem Zugriff auf diese Seite und das verbundene Board ausgeführt. Nur Extensions aus vertrauenswürdiger Quelle laden. Fortfahren?`))) continue;
                await manager.loadSource(await file.text(), file.name);
            }
        }
        $('extension-load-example').addEventListener('click', () => guarded(loadExample));
        $('extension-file').addEventListener('change', event => { const files = [...event.target.files]; event.target.value = ''; guarded(() => loadFiles(files)); });

        function card(entry) {
            if (cards.has(entry.id)) return cards.get(entry.id);
            const parts = {
                title: el('strong'), badge: el('span', { class: 'chip-badge' }), description: el('p', { class: 'sd-note' }), config: el('div', { class: 'bus-config ext-config' }),
                problem: el('p', { class: 'sd-note' }), blocks: el('div', { class: 'ext-blocks' }),
                start: el('button', { class: 'primary', text: 'Starten' }), stop: el('button', { text: 'Stoppen' }), unload: el('button', { class: 'subtle', text: 'Entladen' })
            };
            entry.mount = parts.blocks;
            parts.start.addEventListener('click', () => guarded(() => manager.start(entry.id)));
            parts.stop.addEventListener('click', () => guarded(() => manager.stop(entry.id)));
            parts.unload.addEventListener('click', () => guarded(() => manager.unload(entry.id)));
            parts.node = el('div', { class: 'sd-panel ext-card' },
                el('div', { class: 'sd-heading' }, el('div', {}, parts.title, parts.description), el('div', { class: 'sd-actions' }, parts.badge, parts.start, parts.stop, parts.unload)),
                parts.config, parts.problem, parts.blocks);
            parts.signature = '';
            cards.set(entry.id, parts);
            list.append(parts.node);
            return parts;
        }
        function renderConfig(entry, parts) {
            const interfaces = entry.def.interfaces.map(decl => ({ decl, options: manager.availableInterfaces(decl), chosen: manager.selectedInterface(entry, decl)?.kind || '' }));
            const gpios = entry.def.gpios.map(decl => ({ decl, options: manager.freeGpios(entry, decl), chosen: entry.gpioChoice[decl.id] ?? '' }));
            const locked = entry.state === 'active' || entry.state === 'starting' || ctx.blocked();
            const signature = JSON.stringify([interfaces.map(item => [item.options.map(o => o.label), item.chosen]), gpios.map(item => [item.options, item.chosen]), locked, ctx.chip().id]);
            if (signature === parts.signature) return;
            parts.signature = signature;
            const nodes = [];
            for (const { decl, options, chosen } of interfaces) {
                const input = el('select', { 'aria-label': decl.label, disabled: locked });
                // A single candidate is selected implicitly; the choice is only shown when there is something to choose.
                if (!options.length) input.add(new Option('Nicht aktiv', ''));
                else { if (options.length > 1) input.add(new Option('Bitte wählen …', '')); for (const option of options) input.add(new Option(`${KIND_NAMES[option.kind]} · ${option.label}`, option.kind)); }
                input.value = chosen;
                input.addEventListener('change', () => { entry.interfaceChoice[decl.id] = input.value; refresh(); });
                nodes.push(el('label', {}, `${decl.label} `, input));
            }
            for (const { decl, options, chosen } of gpios) {
                const input = el('select', { 'aria-label': decl.label, disabled: locked, title: decl.hint });
                input.add(new Option(decl.optional ? 'Nicht belegt' : 'Bitte wählen …', ''));
                for (const id of options) input.add(ctx.gpioOption(id));
                input.value = String(chosen);
                input.addEventListener('change', () => { entry.gpioChoice[decl.id] = input.value === '' ? undefined : Number(input.value); refresh(); });
                nodes.push(el('label', {}, `${decl.label} · ${decl.mode === 'output' ? 'Ausgang' : 'Eingang'} `, input));
            }
            parts.config.replaceChildren(...nodes);
            parts.config.hidden = !nodes.length;
        }
        function refresh() {
            const present = new Set(manager.list.map(entry => entry.id));
            for (const [id, parts] of cards) if (!present.has(id)) { parts.node.remove(); cards.delete(id); }
            $('extension-empty').hidden = !!present.size;
            for (const entry of manager.list) {
                const parts = card(entry), active = entry.state === 'active', starting = entry.state === 'starting';
                parts.title.textContent = `${entry.def.name}${entry.def.version ? ' · ' + entry.def.version : ''}`;
                parts.description.textContent = [entry.def.description, entry.origin].filter(Boolean).join(' · ');
                parts.badge.textContent = active ? 'AKTIV' : starting ? 'STARTET …' : entry.state === 'error' ? 'FEHLER' : 'GELADEN';
                const problem = active || starting ? '' : entry.error || manager.missing(entry);
                parts.problem.textContent = problem; parts.problem.className = `sd-note ${entry.error ? 'error' : ''}`.trim(); parts.problem.hidden = !problem;
                parts.start.hidden = active || starting; parts.start.disabled = !!manager.missing(entry) || ctx.blocked();
                parts.stop.hidden = !(active || entry.state === 'error'); parts.stop.disabled = ctx.blocked();
                parts.unload.disabled = ctx.blocked();
                renderConfig(entry, parts);
            }
        }
        return { manager, refresh, update: refresh, reset: () => manager.reset().catch(error => ctx.log('Extension:', error.message)) };
    };
})(globalThis);
