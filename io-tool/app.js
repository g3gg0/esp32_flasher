(function () {
    'use strict';
    const { chips, boardConfigs, GPIOController, RegisterTransport, DemoTransport, adcProfiles, SDHost, sdProfiles, sdCommands, sdRoles } = ESPIO;
    const $ = id => document.getElementById(id);
    const NS = 'http://www.w3.org/2000/svg';
    const hex = value => `0x${(value >>> 0).toString(16).padStart(8, '0')}`;
    const labels = { input: 'INPUT', output: 'OUTPUT', unknown: 'FEHLER', sd: 'SD', i2c: 'I²C' };
    const functions = [
        { id: 'i2c', name: 'I²C', blocks: ['i2c'] },
        { id: 'spi', name: 'SPI', blocks: ['spi'] },
        { id: 'sd', name: 'SD', blocks: ['sdmmc', 'spi'] },
        { id: 'rmt', name: 'RMT', blocks: ['rmt'] },
        { id: 'pwm', name: 'PWM / LEDC', blocks: ['ledc'] },
        { id: 'adc', name: 'ADC', blocks: ['apb_saradc', 'saradc', 'lp_adc', 'sens'] },
        { id: 'uart', name: 'UART', blocks: ['uart'] },
        { id: 'i2s', name: 'I²S', blocks: ['i2s'] }
    ];
    let chip = chips.esp32c3, board = boardConfigs.boards[0], selectedPin = 0;
    let flasher = null, transport = null, controller = null;
    let session = 'offline', busy = false, operation = false, disconnecting = false;
    let planned = null, peripheral = 'gpio', layout = [], mapHeight = 560;
    let catalog = null, catalogRequest = 0, boardRequest = 0, renderedFrame = 0;
    let sampleTimes = [], lastPoll = null, lastUI = 0, lastPerfClear = 0, logs = [];
    let lastFrame = 0;
    let scanAbort = null, scanResults = [], scanMetadata = null;
    let sdHost = null, sdAbort = null, sdLog = [], sdCardResult = null;
    let sdDownloadActive = false;
    const sdDrafts = new Map();
    function sdDraft() {
        const key = `${chip.id}:${board.id}`;
        if (!sdDrafts.has(key)) sdDrafts.set(key, { pins: Object.fromEntries(sdRoles.map(role => [role, null])), width: 1, power: 'external' });
        return sdDrafts.get(key);
    }
    function sdRole(id) { return Object.entries(sdHost?.ready ? sdHost.config.pins : { ...sdDraft().pins, enable: sdDraft().power === 'p4-eth' ? 45 : null }).find(([, pin]) => pin === id)?.[0]; }
    const isAnalog = () => controller?.readMode === 'adc';
    const adcChannel = id => adcProfiles[chip.id]?.channels[id];
    const i2cPanel = ESPIO.createI2CPanel({ controller: () => controller, chip: () => chip, board: () => board, pins: exposedPins,
        session: () => session, blocked: () => busy || operation, gpioOption, log,
        setOperation: value => { operation = value; updateControls(); }, update: updateControls });

    function gpioOption(id) {
        const pin = chip.pins.find(pin => pin.id === id);
        const text = [`GPIO ${id}`, board.notes?.[id], pin.reserved ? 'reserviert' : !pin.output ? 'nur Input' : ''].filter(Boolean).join(' · ');
        const option = new Option(text, String(id)); option.title = text; option.disabled = !!pin.reserved || !pin.output; return option;
    }
    function peripheralRole(id) { return controller?.pinOwners.get(id)?.startsWith('I²C') ? i2cPanel.role(id) : sdRole(id) || i2cPanel.role(id); }

    function log(...parts) {
        const message = parts.map(part => typeof part === 'string' ? part : JSON.stringify(part)).join(' ');
        logs.push(`${new Date().toLocaleTimeString('de-DE')}  ${message}`);
        if (logs.length > 250) logs.shift();
        $('log').textContent = logs.join('\n');
        $('log-count').textContent = String(logs.length);
    }
    function status(message, kind = session === 'demo' ? 'demo' : '') {
        $('status').textContent = message; $('status').className = kind;
    }
    function svg(tag, attributes, parent, content) {
        const node = document.createElementNS(NS, tag);
        for (const [key, value] of Object.entries(attributes || {})) node.setAttribute(key, value);
        if (content !== undefined) node.textContent = content;
        if (parent) parent.append(node);
        return node;
    }
    function photo(target, config, x, y, width, height) {
        const crop = config.crop;
        const nested = svg('svg', { x, y, width, height, viewBox: `${crop.x} ${crop.y} ${crop.width} ${crop.height}`, preserveAspectRatio: 'none', overflow: 'hidden' }, target);
        // Explicit source dimensions prevent implicit SVG image scaling.
        svg('image', { href: config.image, x: 0, y: 0, width: config.imageSize.width, height: config.imageSize.height }, nested);
    }
    function availableBoards() { return [...boardConfigs.boards.filter(item => item.chip === chip.id), boardConfigs.raw(chip)]; }
    function pinReason(id) { return chip.pins.find(pin => pin.id === id)?.reserved || ''; }
    function exposedPins() { return [...new Set([...board.pins.map(pin => pin.gpio), ...(board.extra || [])].filter(id => id !== null))]; }
    function supported(fn) { return chip.peripherals.some(block => fn.blocks.includes(block.id)); }

    function renderDevices() {
        $('preview-chip').value = chip.id;
        $('preview-chip').disabled = session !== 'offline' || busy;
        $('chip-badge').textContent = `${chip.name} · ${session === 'offline' ? 'Vorschau' : session === 'demo' ? 'Simulation' : 'RAM-Stub'}`;
        $('board-cards').replaceChildren();
        for (const config of availableBoards()) {
            const button = document.createElement('button');
            button.className = 'board-card' + (board.id === config.id ? ' selected' : '');
            button.dataset.board = config.id; button.setAttribute('aria-pressed', String(board.id === config.id));
            button.disabled = busy || operation;
            const thumb = document.createElement('span'); thumb.className = 'board-thumb';
            if (config.image) {
                const drawing = svg('svg', { viewBox: '0 0 64 72', 'aria-hidden': 'true' }, thumb);
                const ratio = config.crop.width / config.crop.height;
                photo(drawing, config, (64 - 66 * ratio) / 2, 3, 66 * ratio, 66);
            } else {
                const icon = document.createElement('span'); icon.className = 'raw-icon'; icon.textContent = 'IC'; thumb.append(icon);
            }
            const title = document.createElement('span');
            const strong = document.createElement('strong'); strong.textContent = config.name;
            const small = document.createElement('small'); small.textContent = config.subtitle;
            title.append(strong, small); button.append(thumb, title);
            button.addEventListener('click', () => chooseBoard(config));
            $('board-cards').append(button);
        }
        $('board-description').textContent = board.description;
        $('board-source').href = board.source;
        $('board-source').textContent = `${board.attribution} ↗`;
        $('pin-count').textContent = `${exposedPins().length} GPIOs`;
    }

    function renderMap() {
        const drawing = $('board-svg'); drawing.replaceChildren();
        $('quick-controls').replaceChildren(); layout = [];
        let bx, by, bw, bh;
        if (board.image) {
            bw = board.id === 'p4-eth' ? 190 : 300;
            bh = bw * board.crop.height / board.crop.width;
            bx = (1000 - bw) / 2; by = 45;
            mapHeight = by + bh + (board.extra ? 65 + Math.ceil(board.extra.length / 2) * 34 : 55);
            photo(drawing, board, bx, by, bw, bh);
        } else {
            bw = 260; bx = 370; by = 45;
            const rows = Math.ceil(board.pins.length / 2);
            bh = Math.max(360, rows * 34 + 30); mapHeight = bh + 90;
            svg('rect', { x: bx, y: by, width: bw, height: bh, rx: 14, fill: '#182127', stroke: '#44535f', 'stroke-width': 2 }, drawing);
            svg('rect', { x: bx + 30, y: by + bh / 2 - 60, width: bw - 60, height: 120, rx: 7, fill: '#0c1217', stroke: '#354451' }, drawing);
            svg('text', { x: 500, y: by + bh / 2 - 7, 'text-anchor': 'middle', fill: '#b6c6d2', 'font-size': 20, 'font-family': 'Consolas, monospace' }, drawing, chip.name);
            svg('text', { x: 500, y: by + bh / 2 + 18, 'text-anchor': 'middle', fill: '#718494', 'font-size': 11 }, drawing, 'LOGISCHE GPIO-ANSICHT');
        }
        drawing.setAttribute('viewBox', `0 0 1000 ${mapHeight}`);
        $('pinmap').style.aspectRatio = `1000 / ${mapHeight}`;
        for (const pad of board.pins) {
            const x = board.image ? bx + (pad.x - board.crop.x) / board.crop.width * bw : bx + pad.x / 100 * bw;
            const y = board.image ? by + (pad.y - board.crop.y) / board.crop.height * bh : by + 28 + pad.y / 12 * 34;
            addPin(drawing, pad, x, y, y);
        }
        if (board.extra) {
            const startY = by + bh + 34;
            svg('text', { x: 500, y: startY - 8, fill: '#8e9ba8', 'text-anchor': 'middle', 'font-size': 11 }, drawing, 'ZUSATZPADS · SCHEMATISCH');
            board.extra.forEach((id, index) => {
                const side = index % 2 === 0 ? 'left' : 'right';
                const y = startY + 22 + Math.floor(index / 2) * 34;
                addPin(drawing, { gpio: id, label: String(id), side }, side === 'left' ? 405 : 595, y, y);
            });
        }
        updateMapState();
    }
    function addPin(drawing, pad, x, y, traceY) {
        const left = pad.side === 'left', edge = left ? 309 : 691;
        if (pad.gpio === null) {
            const g = svg('g', { class: 'power-pad' }, drawing);
            svg('circle', { cx: x, cy: y, r: 6 }, g);
            svg('text', { x: left ? x - 18 : x + 18, y: y + 3, 'text-anchor': left ? 'end' : 'start' }, g, pad.label);
            return;
        }
        const id = pad.gpio;
        svg('path', { class: 'pin-connector', d: `M${edge} ${traceY} L${left ? x - 14 : x + 14} ${y}` }, drawing);
        const g = svg('g', { class: 'pin-hit', tabindex: 0, role: 'button', 'aria-label': `GPIO ${id}`, 'data-pin': id }, drawing);
        svg('title', {}, g, `GPIO${id}${pinReason(id) ? ` · ${pinReason(id)}` : ''}`);
        // Large transparent hit area remains comfortable even on dense headers.
        svg('circle', { cx: x, cy: y, r: 15, style: 'fill:transparent;stroke:none' }, g);
        svg('circle', { cx: x, cy: y, r: 8 }, g);
        svg('text', { x: left ? edge - 5 : edge + 5, y: traceY + 4, 'text-anchor': left ? 'end' : 'start' }, g, `IO${id}`);
        g.addEventListener('click', () => selectPin(id));
        g.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); selectPin(id); } });
        const toggle = document.createElement('button'); toggle.className = 'quick-toggle'; toggle.hidden = true;
        toggle.style.left = left ? '0.7%' : '96%'; toggle.style.top = `${traceY / mapHeight * 100}%`;
        toggle.setAttribute('aria-label', `GPIO ${id} Ausgang umschalten`);
        toggle.addEventListener('click', () => { const state = controller?.pins.get(id); if (state) changeLevel(id, state.level ? 0 : 1); });
        $('quick-controls').append(toggle);
        layout.push({ id, x: left ? 45 : 750, y: traceY - 12, width: 205, height: 24, g, toggle });
    }
    function updateMapState() {
        for (const pin of layout) {
            const state = controller?.pins.get(pin.id);
            pin.g.classList.toggle('selected', selectedPin === pin.id);
            pin.g.classList.toggle('high', state?.read != null && state.read >= .5);
            pin.g.classList.toggle('reserved-pin', !!pinReason(pin.id));
            const role = peripheralRole(pin.id);
            pin.g.classList.toggle('sd-pin', !!sdRole(pin.id)); pin.g.classList.toggle('i2c-pin', !!i2cPanel.role(pin.id));
            const label = pin.g.querySelector('text'); if (label) label.textContent = `IO${pin.id}${role ? ` · ${role.toUpperCase()}` : ''}`;
            pin.g.setAttribute('aria-pressed', String(selectedPin === pin.id));
            pin.toggle.hidden = state?.mode !== 'output'; pin.toggle.disabled = busy || operation || !controller?.running || controller?.pinOwners.has(pin.id);
            pin.toggle.textContent = state?.level ? '1' : '0';
        }
    }
    function renderFunctions() {
        const select = $('pin-function'); select.replaceChildren();
        const pin = chip.pins.find(item => item.id === selectedPin);
        for (const [id, name] of [['input', 'GPIO · Input'], ['output', 'GPIO · Output']]) {
            const option = new Option(name, id); option.disabled = id === 'output' && !pin?.output; select.add(option);
        }
        for (const fn of functions) {
            const implemented = fn.id === 'adc' && !!adcProfiles[chip.id], sd = fn.id === 'sd', i2c = fn.id === 'i2c' && !!ESPIO.i2cProfiles[chip.id];
            const option = new Option(`${fn.name} · ${i2c ? 'im I²C-Block konfigurieren' : sd ? 'im SD-Block konfigurieren' : implemented ? 'über Messquelle' : supported(fn) ? 'geplant' : 'nicht verfügbar'}`, fn.id);
            option.disabled = !supported(fn) || implemented || sd || i2c; select.add(option);
        }
    }
    function selectPin(id) { selectedPin = id; planned = null; sampleTimes = []; renderFunctions(); updateInspector(); updateMapState(); updateScanControls(); }
    function updateInspector() {
        const pin = chip.pins.find(item => item.id === selectedPin);
        if (!pin) return;
        const state = controller?.pins.get(selectedPin), reason = pinReason(selectedPin), owner = controller?.pinOwners.get(selectedPin);
        $('pin-name').textContent = `GPIO ${selectedPin}`;
        $('pin-subtitle').textContent = owner ? `${owner}-Port · ${peripheralRole(selectedPin)?.toUpperCase() || ''}` : reason ? 'Reservierter Pin · keine Konfiguration' : pin.output ? 'Digitaler Ein- / Ausgang' : 'Nur digitaler Eingang';
        $('pin-state').textContent = reason ? 'RESERVIERT' : state ? labels[state.mode] : 'VORSCHAU';
        const stale = !controller?.running || state?.read == null || performance.now() - (state?.lastRead || 0) > Math.max(250, (state?.samplePeriod || Number($('interval').value)) * 4);
        $('read-label').textContent = isAnalog() ? 'ADC · ROHWERT / 4095' : 'GELESEN';
        $('read-level').textContent = isAnalog() && !adcChannel(selectedPin) ? 'kein ADC' : stale ? '—' : isAnalog() ? String(state.adcRaw) : state.read ? '1 / HIGH' : '0 / LOW';
        $('drive-level').textContent = state?.mode === 'output' ? state.level ? '1 / HIGH' : '0 / LOW' : '—';
        $('pin-function').value = planned || (state?.mode === 'output' ? 'output' : 'input');
        $('pin-pull').value = state?.pull || 'none';
        $('pin-note').textContent = [reason, pin.strap ? 'Strapping-Pin: Pegel wird beim Reset ausgewertet.' : '', board.notes?.[selectedPin] || '', !pin.pulls ? 'Keine internen Pull-Widerstände.' : '', adcChannel(selectedPin) ? `ADC${adcChannel(selectedPin).unit}, Kanal ${adcChannel(selectedPin).channel}.` : isAnalog() ? 'Kein unterstützter ADC-Kanal; keine Analogmessung.' : ''].filter(Boolean).join(' ');
        const disabled = busy || operation || !!reason || !!owner || !controller || !controller.running;
        $('pin-function').disabled = disabled;
        $('pin-pull').disabled = disabled || !pin.pulls || !!planned;
        $('planned-function').hidden = !planned;
        if (planned) $('planned-function').textContent = `${functions.find(fn => fn.id === planned)?.name}: vorbereitet, noch ohne Steuerung. Die aktuelle GPIO-Konfiguration bleibt aktiv.`;
        $('output-controls').hidden = state?.mode !== 'output';
        for (const [id, level] of [['set-low', 0], ['set-high', 1]]) {
            $(id).disabled = disabled || state?.mode !== 'output';
            $(id).classList.toggle('active', state?.mode === 'output' && state.level === level);
        }
        $('inspector-help').textContent = owner ? `${owner} steuert diesen Pin. Zum Umkonfigurieren zuerst den Port freigeben.` : reason ? 'Dieser Pin wird vom Tool nicht umkonfiguriert.' : !controller ? 'Zum Steuern mit Hardware verbinden oder die Demo starten.' : controller.scanning ? 'Usage-Scan läuft. Die vorherige Konfiguration wird anschließend wiederhergestellt.' : !controller.running ? 'Messung angehalten. Fortsetzen, um Pins zu bedienen.' : isAnalog() ? 'Grün: ADC-Rohwert. Rot: Output-Sollwert 0/1 als Skalenenden, keine kalibrierte Spannung.' : 'Änderungen werden sofort angewendet. Grün liest immer den tatsächlichen digitalen Pinpegel zurück.';
        const bank = chip.gpio.banks[Math.floor(selectedPin / 32)];
        $('pin-registers').replaceChildren();
        for (const [name, value] of [['IO MUX', pin.mux], ['MATRIX OUT', chip.gpio.matrix + selectedPin * 4], ['GPIO PIN', chip.gpio.pinConfig + selectedPin * 4], ['INPUT BANK', bank.input], ['OUT SET', bank.set], ['OUT CLEAR', bank.clear]]) {
            const dt = document.createElement('dt'), dd = document.createElement('dd'); dt.textContent = name; dd.textContent = value == null ? '—' : hex(value); $('pin-registers').append(dt, dd);
        }
    }
    function renderPeripherals() {
        $('peripherals').replaceChildren();
        for (const fn of [{ id: 'gpio', name: 'GPIO' }, ...functions.filter(supported)]) {
            const button = document.createElement('button'); button.textContent = fn.name; button.dataset.peripheral = fn.id;
            button.className = fn.id === peripheral ? 'active' : '';
            const small = document.createElement('small'); small.textContent = fn.id === 'gpio' || (fn.id === 'adc' && adcProfiles[chip.id]) || (fn.id === 'sd' && sdProfiles[chip.id]) || (fn.id === 'i2c' && ESPIO.i2cProfiles[chip.id]) ? 'AKTIV' : 'GEPLANT'; button.append(small);
            button.addEventListener('click', () => {
                peripheral = ['sd', 'i2c'].includes(fn.id) && peripheral === fn.id ? 'gpio' : fn.id;
                $('register-block').value = fn.id === 'gpio' ? 'gpio' : chip.peripherals.find(block => fn.blocks.includes(block.id))?.id || '*';
                $('peripheral-description').textContent = fn.id === 'i2c' && ESPIO.i2cProfiles[chip.id] ? 'I²C-Port: SDA/SCL zuordnen, Adressen scannen und Bytes übertragen.' : fn.id === 'sd' ? 'SD-Port: Pins zuordnen und die Karte über den nativen Host identifizieren.' : fn.id === 'gpio' ? 'GPIO Input / Output: Registerzugriffe aktiv.' : fn.id === 'adc' && adcProfiles[chip.id] ? 'ADC verfügbar: Messquelle im Live-Pinout auf ADC umschalten. 12-Bit-Rohwerte, sequenziell, ohne Spannungskalibrierung.' : `${fn.name} ist als Erweiterung vorgesehen. Der Registerkatalog ist verfügbar; es werden keine Peripherieregister geschrieben.`;
                renderPeripherals(); renderCatalog();
            });
            $('peripherals').append(button);
        }
        $('catalog-count').textContent = `${chip.peripherals.length} Registerblöcke`;
        const previous = $('register-block').value;
        $('register-block').replaceChildren(new Option('Alle Registerblöcke', '*'));
        for (const block of chip.peripherals) $('register-block').add(new Option(`${block.name} (${block.registerCount})`, block.id));
        $('register-block').value = chip.peripherals.some(block => block.id === previous) ? previous : 'gpio';
        renderSD();
        i2cPanel.render(peripheral === 'i2c');
    }
    async function loadCatalog() {
        const request = ++catalogRequest;
        if (catalog?.chip === chip.id) return renderCatalog();
        $('register-list').textContent = 'Registerkatalog wird geladen …';
        try {
            const response = await fetch(`configs/registers/${chip.id}.json`);
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const data = await response.json();
            if (request !== catalogRequest) return;
            catalog = data; renderCatalog();
        } catch (error) {
            if (request !== catalogRequest) return;
            $('register-list').textContent = `Registerkatalog nicht geladen (${error.message}). Bei file:// bitte über localhost öffnen; siehe README.`;
        }
    }
    function renderCatalog() {
        if (!$('catalog-details').open) return;
        if (catalog?.chip !== chip.id) { loadCatalog(); return; }
        const filter = $('register-filter').value.trim().toUpperCase();
        const selectedBlock = $('register-block').value;
        const rows = catalog.blocks.flatMap(block => {
            if (!filter && selectedBlock !== '*' && block.id !== selectedBlock) return [];
            return block.registers.filter(reg => !filter || reg.name.includes(filter)).map(reg => ({ ...reg, block: block.id, source: block.source }));
        });
        const table = document.createElement('table'); table.className = 'register-table';
        const head = table.createTHead().insertRow();
        for (const label of ['Register', 'Adresse / Ausdruck']) { const th = document.createElement('th'); th.textContent = label; head.append(th); }
        for (const reg of rows.slice(0, 250)) {
            const row = table.insertRow(), name = row.insertCell(), value = row.insertCell();
            const link = document.createElement('a'); link.href = reg.source; link.target = '_blank'; link.rel = 'noreferrer'; link.textContent = reg.name + (reg.parameters === undefined ? '' : `(${reg.parameters})`); name.append(link);
            value.textContent = reg.address === undefined ? reg.expression : hex(reg.address);
        }
        const count = document.createElement('p'); count.className = 'muted'; count.textContent = `${rows.length} Register${rows.length > 250 ? ' · erste 250 angezeigt; Suche verfeinern' : ''}. Symbolische Ausdrücke werden nur dokumentiert.`;
        $('register-list').replaceChildren(count, table);
    }

    function updateControls() {
        $('connect').hidden = session !== 'offline'; $('connect').disabled = busy;
        $('disconnect').hidden = session === 'offline'; $('disconnect').disabled = busy || operation;
        $('disconnect').textContent = session === 'demo' ? 'Demo beenden' : 'Trennen & Reset';
        $('demo').hidden = session !== 'offline'; $('demo').disabled = busy;
        $('baud').disabled = session !== 'offline' || busy;
        $('session-badge').className = `session-badge ${session === 'hardware' ? 'live' : session === 'demo' ? 'demo' : ''}`;
        $('session-badge').textContent = session === 'hardware' ? '● LIVE / RAM' : session === 'demo' ? '● DEMO / SIMULATION' : 'OFFLINE';
        $('pause').disabled = !controller || busy || operation || controller.fault;
        $('pause').textContent = controller?.running ? 'Ⅱ Pause' : '▶ Fortsetzen';
        $('preview-chip').disabled = session !== 'offline' || busy;
        $('interval').disabled = busy || operation;
        $('read-mode').disabled = !controller || busy || operation || controller.fault;
        $('read-mode').options[1].disabled = !adcProfiles[chip.id];
        $('read-mode').value = controller?.readMode || 'digital';
        $('adc-info').hidden = !isAnalog();
        $('measurement-note').textContent = isAnalog() ? 'Grün zeigt ADC-Rohwerte 0–4095, keine kalibrierte Spannung. ADC-fremde Pins haben keine Messkurve.' : 'Grün zeigt den digitalen Pinpegel, keine Spannung. Kurze Pulse zwischen Abtastungen können fehlen.';
        renderDevices(); updateInspector(); updateMapState();
        updateScanControls();
        updateSDControls();
        i2cPanel.update();
    }
    async function initializeBoard() {
        const token = ++boardRequest;
        sampleTimes = []; lastPoll = null;
        if (controller) { await controller.release(); await controller.close(); controller = null; }
        sdHost = null; clearSDResults(); renderSD(); i2cPanel.reset(); i2cPanel.render(peripheral === 'i2c');
        if (!transport || session === 'offline') return;
        const current = new GPIOController(transport, chip, {
            onSample: (_, time, id) => {
                lastPoll = time;
                if (id == null || id === selectedPin) sampleTimes.push(time);
                while (sampleTimes.length > 1 && sampleTimes[0] < time - 2000) sampleTimes.shift();
                if (time - lastPerfClear > 2000) {
                    lastPerfClear = time;
                    for (const name of ['esp32_flasher_receive_start', 'esp32_flasher_receive_end', 'esp32_flasher_send_start', 'esp32_flasher_send_end']) performance.clearMarks(name);
                    for (const name of ['esp32_flasher_receive', 'esp32_flasher_send', 'esp32_flasher_latency']) performance.clearMeasures(name);
                }
            },
            onError: error => {
                if (controller !== current) return;
                status(`Messung gestoppt: ${error.message || error}. Verbindung prüfen und neu verbinden.`, 'error');
                log('Polling-Fehler:', error.message || error); updateControls();
            }
        });
        controller = current;
        await current.initialize(exposedPins().filter(id => !pinReason(id)));
        if (token !== boardRequest || !transport || session === 'offline') { await current.close(); return; }
        current.start(Number($('interval').value));
    }
    async function chooseBoard(config) {
        if (busy || operation) return;
        busy = true; board = config; planned = null;
        clearScan();
        const ids = exposedPins(); selectedPin = ids.find(id => !pinReason(id)) ?? ids[0];
        renderDevices(); renderMap(); renderFunctions(); updateControls();
        try {
            await initializeBoard();
            status(session === 'offline' ? `${board.name} · Vorschau. Mit ESP verbinden oder Demo starten.` : `${session === 'demo' ? 'DEMO / SIMULATION · ' : ''}${board.name} · ${controller.pins.size} GPIOs als Input konfiguriert. Polling läuft.`);
        } catch (error) { await failure(error); }
        finally { busy = false; updateControls(); }
    }
    async function failure(error) {
        await controller?.pause();
        if (controller) controller.fault = true;
        status(error.message || String(error), 'error'); log('Fehler:', error.message || error);
    }
    async function connect() {
        if (busy || session !== 'offline') return;
        if (!navigator.serial || !isSecureContext) { status('Web Serial benötigt Chrome/Edge und einen sicheren Kontext (localhost oder HTTPS).', 'error'); return; }
        busy = true; updateControls();
        let device;
        try {
            status('Seriellen Port auswählen …');
            device = new ESPFlasher({ initialBaudRate: Number($('baud').value), logMessage: log, logWarning: log, logError: log });
            flasher = device;
            // Invoke the port chooser within the original click's user activation.
            await device.openPort();
            device.disconnected = () => { if (!disconnecting && flasher === device) unexpectedDisconnect(); };
            status('ESP in den Bootloader starten und Chip erkennen …');
            await device.hardReset(true); await device.sync();
            if (!device.chip_descriptions[device.current_chip]?.stub) throw new Error(`Für ${device.current_chip} ist kein RAM-Stub vorhanden.`);
            if (!chips[device.current_chip]) throw new Error(`${device.current_chip}: Noch kein geprüftes GPIO-Registerprofil vorhanden. Es werden keine GPIO-Register geschrieben.`);
            log(`Erkannt: ${device.current_chip}`);
            status(`${device.current_chip}: RAM-Stub wird geladen …`);
            if (device.stubLoaded !== true && !await device.isStubLoader()) {
                if (!await device.downloadStub()) throw new Error('RAM-Stub konnte nicht gestartet werden.');
            }
            // isStubLoader in the existing flasher stores a Promise on some chips.
            device.stubLoaded = true;
            transport = new RegisterTransport(device); session = 'hardware';
            const changed = chip.id !== device.current_chip;
            chip = chips[device.current_chip];
            clearScan();
            if (changed) board = availableBoards()[0];
            const ids = exposedPins(); selectedPin = ids.find(id => !pinReason(id)) ?? ids[0];
            catalog = null; ++catalogRequest; peripheral = 'gpio'; planned = null;
            renderDevices(); renderMap(); renderFunctions(); renderPeripherals(); renderCatalog();
            await initializeBoard();
            status(`${chip.name} erkannt · RAM-Stub aktiv · ${board.name} · ${controller.pins.size} GPIOs als Input. Polling läuft.`);
            log('Stub aktiv. Kein Flash-Schreib- oder Löschbefehl wird verwendet.');
        } catch (error) {
            const cancelled = error?.name === 'NotFoundError';
            await shutdown(false);
            status(cancelled ? 'Portauswahl abgebrochen.' : `${error.message || error} Falls nötig: BOOT halten, RESET drücken und erneut verbinden.`, cancelled ? '' : 'error');
            if (!cancelled) log('Verbindungsfehler:', error.message || error);
        } finally { busy = false; updateControls(); }
    }
    async function demo() {
        if (busy || session !== 'offline') return;
        busy = true; session = 'demo'; transport = new DemoTransport(chip); clearScan(); updateControls();
        try { await initializeBoard(); status(`DEMO / SIMULATION · ${board.name} · Signale werden lokal simuliert. Keine Hardware verbunden.`, 'demo'); }
        catch (error) { await failure(error); }
        finally { busy = false; updateControls(); }
    }
    async function shutdown(reset = true) {
        disconnecting = true; ++boardRequest;
        const oldController = controller, oldTransport = transport, device = flasher;
        // Mark offline immediately so another UI operation cannot queue a write.
        controller = null; transport = null; flasher = null; session = 'offline';
        if (oldController) {
            try { await oldController.release(); } catch (error) { log('GPIO-Freigabe:', error.message || error); }
            await oldController.close();
        }
        oldTransport?.close();
        sdHost = null;
        if (device?.port) {
            if (reset) { try { await device.hardReset(false); } catch (error) { log('Reset:', error.message || error); } }
            await device.disconnect();
        }
        disconnecting = false; sampleTimes = []; lastPoll = null;
    }
    async function unexpectedDisconnect() {
        log('USB-/Serial-Verbindung verloren.');
        const current = controller; controller = null;
        transport?.close(); transport = null; flasher = null; session = 'offline'; ++boardRequest;
        sdHost = null;
        await current?.close();
        status('Verbindung verloren. Messung gestoppt; erneut verbinden.', 'error'); updateControls();
    }
    async function changePin(mode, pull) {
        if (!controller || operation || busy || !controller.running) return;
        const current = controller, id = selectedPin, old = current.pins.get(id);
        operation = true; updateControls();
        try {
            await current.configure(id, mode, pull, old?.level ?? 0);
            status(`GPIO${id} · ${labels[mode]} · ${pull === 'none' ? 'Floating' : pull === 'up' ? 'Pull-up' : 'Pull-down'}${mode === 'output' ? ` · ${current.pins.get(id).level ? 'HIGH' : 'LOW'}` : ''}`);
        } catch (error) { await failure(error); }
        finally { operation = false; updateControls(); }
    }
    async function changeLevel(id, level) {
        if (!controller || operation || busy || !controller.running) return;
        operation = true; updateControls();
        try { await controller.setLevel(id, level); status(`${session === 'demo' ? 'DEMO / SIMULATION · ' : ''}GPIO${id} · OUTPUT · ${level ? 'HIGH' : 'LOW'} geschrieben. Grün zeigt den rückgelesenen Pinpegel.`); }
        catch (error) { await failure(error); }
        finally { operation = false; updateControls(); }
    }

    function clearSDResults() {
        sdLog = []; sdCardResult = null;
        $('sd-progress').textContent = ''; $('sd-progress').className = '';
        renderSDLog(); renderSDCard();
        $('sd-download-progress').value = 0; $('sd-download-status').textContent = 'Noch kein Download.';
    }
    function renderSD() {
        $('sd-panel').hidden = peripheral !== 'sd';
        const profile = sdProfiles[chip.id];
        $('sd-configuration').hidden = !profile;
        $('sd-backend').textContent = profile ? `${chip.name} · nativer SDMMC-Host · Slot ${profile.slot} / GPIO-Matrix · 400 kHz · 3,3 V` : chip.peripherals.some(p => p.id === 'sdmmc') ? 'Nativer SDMMC-Host vorhanden. Die Steuerung ist bisher für P4 und S3 implementiert.' : 'SD über SPI vorgesehen: CLK = SCK, CMD = MOSI, D0 = MISO, D3 = CS. Für diesen Chip noch nicht implementiert.';
        const draft = sdDraft();
        for (const role of sdRoles) {
            const select = $(`sd-${role}`);
            select.replaceChildren(new Option(['d0', 'cmd', 'clk'].includes(role) ? 'Bitte wählen …' : 'Nicht verbunden', ''));
            for (const id of exposedPins().sort((a, b) => a - b)) {
                select.add(gpioOption(id));
            }
            select.value = draft.pins[role] === null ? '' : String(draft.pins[role]);
        }
        $('sd-width').value = String(draft.width);
        $('sd-power').replaceChildren(new Option('Vorhandene / externe 3,3 V', 'external'));
        if (board.sd?.power === 'p4-eth') $('sd-power').add(new Option('P4-ETH · LDO4 3,3 V + GPIO45 LOW', 'p4-eth'));
        $('sd-power').value = draft.power;
        $('sd-board-preset').hidden = !board.sd;
        updateSDControls(); renderSDCard();
    }
    function updateSDControls() {
        const ready = !!sdHost?.ready, blocked = !controller || controller.fault || busy || operation;
        let invalid = '';
        try { ESPIO.validateSDConfig(chip, new Set(exposedPins()), sdDraft()); } catch (error) { invalid = error.message; }
        for (const role of sdRoles) $(`sd-${role}`).disabled = ready || busy || operation;
        $('sd-width').disabled = ready || busy || operation;
        $('sd-power').disabled = ready || busy || operation; $('sd-board-preset').disabled = ready || busy || operation;
        $('sd-power-note').textContent = sdDraft().power === 'p4-eth' ? 'Onboard-Versorgung: LDO4 im 3,3-V-Rail-Bypass, GPIO45 LOW. Betrifft die I/O-Domäne GPIO39–48. Pin- und LDO-Felder werden bei Freigabe wiederhergestellt.' : 'Vorhandene / externe 3,3 V, gemeinsame Masse und externe 10-kΩ-Pull-ups an CMD und DAT0–DAT3, auch unverbundenen DAT-Pins im 1-Bit-Modus. Die Versorgung wird nicht geschaltet. Weitere Pins sind in der Chipansicht wählbar.';
        $('sd-apply').disabled = blocked || ready || !!invalid;
        $('sd-release').hidden = !ready; $('sd-release').disabled = blocked;
        $('sd-identify').disabled = blocked || !!invalid;
        $('sd-send').disabled = blocked || !ready;
        $('sd-command').disabled = busy || operation; $('sd-argument').disabled = busy || operation;
        $('sd-cancel').hidden = !sdAbort || sdDownloadActive; $('sd-cancel').disabled = sdAbort?.signal.aborted || false;
        $('sd-state').textContent = sdAbort ? 'LÄUFT' : ready ? `${session === 'demo' ? 'SIMULATION · ' : ''}AKTIV · ${sdHost.width} BIT` : 'NICHT AKTIV';
        $('sd-config-note').textContent = ready ? 'Pins sind dem SD-Port zugewiesen. GPIO-Steuerung, ADC-Abtastung und Usage-Scan dieser Pins sind ausgesetzt.' : invalid || 'Pinzuordnung vollständig. Aktivieren oder direkt die Karte identifizieren.';
        $('sd-config-note').className = 'sd-note';
        $('sd-clear').disabled = !!sdAbort;
        let rangeError = '', range;
        try { range = ESPIO.sectorRange(sdHost?.card, $('sd-download-start').value, $('sd-download-end').value); }
        catch (error) { rangeError = error.message; }
        if (range && !window.showSaveFilePicker && range.bytes > 64 * 1024 * 1024) rangeError = 'Für große Abbilder Chrome/Edge mit direkter Dateiausgabe verwenden; dieser Browser kann bis 64 MiB puffern.';
        $('sd-download-range').textContent = rangeError || `LBA ${range.start.toLocaleString('de-DE')}–${range.end.toLocaleString('de-DE')} · ${range.sectors.toLocaleString('de-DE')} Sektoren · ${range.bytes.toLocaleString('de-DE')} Bytes · Rohabbild${!window.showSaveFilePicker ? ' · Browserpuffer bis 64 MiB' : ' · direkte Dateiausgabe'}`;
        $('sd-download').disabled = blocked || !ready || !!rangeError;
        for (const id of ['sd-download-start', 'sd-download-end', 'sd-download-all']) $(id).disabled = busy || operation;
        $('sd-download-cancel').hidden = !sdDownloadActive;
        $('sd-download-cancel').disabled = sdAbort?.signal.aborted || false;
    }
    function renderSDLog() {
        $('sd-log').textContent = sdLog.length ? sdLog.map(entry => {
            const response = entry.response?.length ? entry.response.map((word, i) => `RESP${i}=${hex(word)}`).join(' ') : 'keine Antwortdaten';
            return `${entry.simulation ? '[SIMULIERT] ' : ''}${entry.command}  ARG=${hex(entry.argument)}  ${entry.responseType.toUpperCase()}  ${(entry.finishedAt - entry.startedAt).toFixed(1)} ms\n  ${response}${entry.events === undefined ? '' : `  IRQ(raw)=${hex(entry.events)}`}${entry.dma ? `\n  DMA: ${entry.dma.transferred} Bytes · DES0=${hex(entry.dma.descriptor)}` : ''}${entry.dataEvents === undefined ? '' : `  IRQ(Daten)=${hex(entry.dataEvents)}`}${entry.error ? `\n  FEHLER: ${entry.error}` : ''}`;
        }).join('\n\n') : 'Noch keine Kommandos.';
        $('sd-log').scrollTop = $('sd-log').scrollHeight;
    }
    function renderSDCard() {
        const target = $('sd-card'); target.replaceChildren(); target.hidden = !sdCardResult;
        if (!sdCardResult) return;
        const card = sdCardResult, heading = document.createElement('strong');
        heading.textContent = `${card.simulation ? 'SIMULIERTE KARTE · ' : ''}${card.cid.product} · ${card.type}`;
        if (card.simulation) heading.className = 'simulation'; target.append(heading);
        const dl = document.createElement('dl');
        const capacity = card.csd.capacityBytes === null ? `CSD-Struktur ${card.csd.version} noch nicht dekodiert` : `${(card.csd.capacityBytes / 2 ** 30).toFixed(2)} GiB · ${card.csd.capacityBytes.toLocaleString('de-DE')} Bytes`;
        for (const [label, value] of [['Hersteller-ID', hex(card.cid.manufacturer)], ['OEM', card.cid.oem], ['Produkt / Revision', `${card.cid.product} / ${card.cid.revision}`], ['Seriennummer', card.cid.serial], ['Herstellung', `${String(card.cid.month).padStart(2, '0')}/${card.cid.year}`], ['Kapazität', capacity], ['RCA / OCR', `${hex(card.rca)} / ${hex(card.ocr)}`], ['Bus', `${card.width} Bit · ${card.clockHz / 1000} kHz`], ['Status', hex(card.status)]]) {
            const dt = document.createElement('dt'), dd = document.createElement('dd'); dt.textContent = label; dd.textContent = value; dl.append(dt, dd);
        }
        target.append(dl);
    }
    function sdCommandArgument() {
        const spec = sdCommands[$('sd-command').value];
        $('sd-argument').value = hex(spec?.rca ? (sdHost?.rca || 0) << 16 : spec?.argument || 0);
    }
    async function sdAction(action) {
        if (!controller || operation || busy || controller.fault) return;
        operation = true; sdAbort = new AbortController();
        const signal = sdAbort.signal;
        $('sd-progress').className = ''; $('sd-progress').textContent = action === 'release' ? 'SD-Port wird freigegeben …' : 'SD-Port vorbereiten …';
        updateControls();
        try {
            if (action === 'release') {
                await sdHost?.close(); sdHost = null;
                $('sd-progress').textContent = 'SD-Port freigegeben. Vorherige GPIO-Konfiguration wiederhergestellt.';
            } else {
                if (!sdHost?.ready) {
                    sdHost = new SDHost(controller, { onCommand: entry => {
                        sdLog.push({ ...entry, simulation: session === 'demo' }); if (sdLog.length > 150) sdLog.shift();
                        renderSDLog(); $('sd-progress').textContent = `${entry.command}${entry.error ? ' fehlgeschlagen' : ' abgeschlossen'} …`;
                    } });
                    await sdHost.open(sdDraft(), signal);
                }
                if (action === 'identify') {
                    const card = await sdHost.identify(signal);
                    sdCardResult = { ...card, simulation: session === 'demo' };
                    $('sd-command').value = 'cmd13'; sdCommandArgument();
                    $('sd-progress').textContent = `${session === 'demo' ? 'SIMULATION · ' : ''}Karte identifiziert · ${card.cid.product} · ${card.width} Bit.`;
                } else if (action === 'send') {
                    const input = $('sd-argument').value.trim();
                    if (!/^(?:0x[0-9a-f]{1,8}|[0-9]{1,10})$/i.test(input) || Number(input) > 0xffffffff) throw new Error('Argument als 32-Bit-Zahl eingeben, z. B. 0x000001AA.');
                    const key = $('sd-command').value, result = await sdHost.send(key, Number(input), signal);
                    if (key === 'cmd0') sdCardResult = null;
                    $('sd-progress').textContent = `${session === 'demo' ? 'SIMULATION · ' : ''}${result.command} abgeschlossen.`;
                } else $('sd-progress').textContent = 'SD-Port aktiv · bereit für Kartenkommandos.';
            }
        } catch (error) {
            $('sd-progress').textContent = error.message || String(error);
            $('sd-progress').className = error.name === 'AbortError' ? '' : 'error';
            log('SD:', error.message || error);
        } finally {
            sdAbort = null; operation = false; renderSD(); updateControls();
        }
    }
    async function downloadSD() {
        if (!sdHost?.ready || operation || busy || controller?.fault) return;
        let range;
        try { range = ESPIO.sectorRange(sdHost.card, $('sd-download-start').value, $('sd-download-end').value); }
        catch (error) { $('sd-download-status').textContent = error.message; return; }
        const filename = `${session === 'demo' ? 'SIMULATION-' : ''}sd-${sdHost.card.cid.serial}-ab-LBA${range.start}.img`;
        // Invoke the picker synchronously in the click activation. A writable
        // file stream keeps full-card images out of browser RAM.
        let picker;
        try {
            if (window.showSaveFilePicker) picker = window.showSaveFilePicker({ suggestedName: filename, types: [{ description: 'SD-Rohabbild', accept: { 'application/octet-stream': ['.img', '.bin'] } }] });
            else if (range.bytes > 64 * 1024 * 1024) throw new Error('Ohne direkte Dateiausgabe ist der Browserpuffer auf 64 MiB begrenzt.');
        } catch (error) { $('sd-download-status').textContent = error.message; return; }
        operation = true; sdDownloadActive = true; sdAbort = new AbortController();
        const signal = sdAbort.signal, chunks = [], prefix = session === 'demo' ? 'SIMULATION · ' : '';
        let file, saved = 0, finished = false, failure = null, lastUI = 0;
        $('sd-download-progress').max = range.bytes; $('sd-download-progress').value = 0;
        $('sd-download-status').textContent = `${prefix}Dateiziel wählen …`; updateControls();
        const eta = seconds => seconds == null || !Number.isFinite(seconds) ? 'wird ermittelt' : `${Math.floor(seconds / 3600)}:${String(Math.floor(seconds / 60) % 60).padStart(2, '0')}:${String(Math.ceil(seconds) % 60).padStart(2, '0')}`;
        try {
            if (picker) file = await (await picker).createWritable();
            if (signal.aborted) throw new DOMException('SD-Download abgebrochen.', 'AbortError');
            await sdHost.download({ start: range.start, end: range.end, signal,
                write: async data => { if (file) await file.write(data); else chunks.push(data); saved += data.length; },
                onProgress: p => {
                    const now = performance.now(); if (now - lastUI < 100 && p.completed !== p.sectors) return; lastUI = now;
                    $('sd-download-progress').value = p.bytesWritten;
                    $('sd-download-status').textContent = `${prefix}${(p.bytesWritten / p.bytes * 100).toFixed(2)} % · ${p.completed.toLocaleString('de-DE')} / ${p.sectors.toLocaleString('de-DE')} Sektoren · ${(p.bytesPerSecond / 1024).toFixed(1)} KiB/s · ETA ${eta(p.etaSeconds)}`;
                }
            });
            finished = true;
        } catch (error) { failure = error; }
        finally {
            let committed = false;
            try {
                if (file) { await file.close(); committed = true; }
                else if (saved) {
                    const url = URL.createObjectURL(new Blob(chunks, { type: 'application/octet-stream' }));
                    const link = document.createElement('a'); link.href = url; link.download = filename.replace('.img', finished ? '.img' : '-TEILABBILD.img'); link.click(); setTimeout(() => URL.revokeObjectURL(url), 60000);
                    committed = true;
                }
            } catch (error) { failure = new Error(`Datei konnte nicht abgeschlossen werden: ${error.message}`); finished = false; }
            const count = saved / 512;
            $('sd-download-progress').value = saved;
            $('sd-download-status').textContent = `${prefix}${finished ? 'Fertig' : failure?.name === 'AbortError' ? 'Abgebrochen' : 'Fehler'} · ${committed ? `${finished ? 'Abbild' : 'Teilabbild'} gespeichert: ${saved.toLocaleString('de-DE')} Bytes${count ? ` · LBA ${range.start}–${range.start + count - 1}` : ''}` : 'kein vollständiger Sektor gespeichert'}${failure && failure.name !== 'AbortError' ? ` · ${failure.message}` : ''}`;
            sdAbort = null; sdDownloadActive = false; operation = false; renderSD(); updateControls();
        }
    }

    function clearScan() {
        scanResults = []; scanMetadata = null;
        renderPinScope();
        $('scan-progress').textContent = '';
        $('scan-state').textContent = 'BEREIT';
        $('scan-results').replaceChildren();
        const p = document.createElement('p'); p.textContent = 'Noch kein Scan. Die bisherige Konfiguration wird nach jedem getesteten Pin wiederhergestellt.'; $('scan-results').append(p);
    }
    function scanTargets() {
        const ids = $('scan-target').value === 'all' ? [...(controller?.pins.keys() || [])] : [selectedPin];
        return ids.filter(id => controller?.pins.has(id) && !pinReason(id) && !controller.pinOwners.has(id));
    }
    function updateScanControls() {
        const active = !!scanAbort, targets = scanTargets();
        const analogCount = targets.filter(id => adcChannel(id)).length;
        const blocked = !controller || controller.fault || busy || operation || !targets.length;
        $('scan-start').disabled = blocked; $('scan-start').hidden = active;
        $('scan-cancel').hidden = !active;
        $('scan-target').disabled = active || busy || operation;
        $('scan-method').disabled = active || busy || operation;
        $('scan-settle').disabled = active || busy || operation;
        $('scan-export').disabled = !scanResults.length || active;
        $('scan-info').textContent = !targets.length ? 'Einen verfügbaren GPIO wählen oder alle GPIOs des Boards scannen.' : `${targets.length} GPIOs · ${analogCount} mit ADC, ${targets.length - analogCount} nur digital · LOW → HIGH → LOW ohne Poll-Pause. Grün: Pull-Test, Blau: OUT-Test, Rot: Sollwert. Pins ohne passende Treiber/Pulls werden nur beobachtet. Vorherige Konfiguration wird wiederhergestellt.`;
    }
    let lastPinScope = null;
    function renderPinScope() {
        const result = scanResults.find(result => result.id === selectedPin);
        if (lastPinScope === result) return;
        lastPinScope = result;
        $('pin-scope').hidden = !result;
        $('pin-scope').querySelector('strong').textContent = result?.method === 'observe' ? 'Usage-Scope · Eingangsmessung' : 'Usage-Scope · LOW → HIGH → LOW';
        $('pin-scope-plot').innerHTML = result ? ESPIO.scopeLegend(result) + ESPIO.scopeSVG(result) : '';
        $('pin-scope-stats').textContent = result ? ESPIO.scopeStats(result) : '';
    }
    function renderScanResults() {
        if (!scanResults.length) return;
        const table = document.createElement('table'); table.className = 'register-table scan-table';
        const header = table.createTHead().insertRow();
        for (const label of ['Pin / Messung', 'Basis', 'LOW / Pull-down', 'HIGH / Pull-up', 'Δ / Skala', 'Beobachtung']) {
            const th = document.createElement('th'); th.textContent = label; header.append(th);
        }
        for (const result of scanResults) {
            const row = table.insertRow();
            const digital = result.measurement === 'digital', value = sample => sample ? digital ? String(sample.io) : String(sample.raw) : '—';
            const name = run => run.method === 'pull' ? 'Pull' : run.method === 'drive' ? 'OUT' : 'IN';
            const phase = key => result.runs.map(run => `${name(run)}: ${value(run[key]?.[0])} → ${value(run[key]?.at(-1))}`).join('\n');
            const delta = digital ? '—' : result.runs.map(run => `${name(run)}: ${run.assessment.span == null ? '—' : (run.assessment.span * 100).toFixed(1) + ' %'}`).join('\n');
            for (const text of [`GPIO${result.id} · ${result.method === 'compare' ? 'Pull + Output' : result.method === 'drive' ? 'Output' : result.method === 'pull' ? 'Pull' : 'Input'} · ${digital ? 'GPIO 0/1' : 'ADC'}`, value(result.baseline),
                phase('low'), phase('high'), delta, result.assessment.label]) row.insertCell().textContent = text;
            const detail = table.insertRow().insertCell(); detail.colSpan = 6; detail.className = 'scan-detail';
            const note = document.createElement('p'); note.textContent = `${result.assessment.interpretation} ${result.assessment.note}`;
            if (result.skippedMethods?.length) note.textContent += ` Nicht verfügbar: ${result.skippedMethods.map(mode => mode === 'pull' ? 'interne Pulls' : 'Output-Treiber').join(', ')}.`;
            const chart = document.createElement('div'); chart.className = 'scope-plot'; chart.innerHTML = ESPIO.scopeLegend(result) + ESPIO.scopeSVG(result);
            const times = document.createElement('small'); times.textContent = `${ESPIO.scopeStats(result)}${digital ? ' · Nur digital; keine Analogbewertung' : ` · ADC-Hardwaretrim: ${result.calibration?.source || '—'}`} · Zeitachse pro Durchlauf, keine zeitliche Streckung.`;
            detail.append(note, chart, times);
        }
        const source = document.createElement('p');
        source.className = scanMetadata?.simulation ? 'simulation-label' : '';
        source.textContent = `${scanMetadata?.simulation ? 'SIMULATION · keine Hardwaremessung' : 'Hardwaremessung'} · ${scanMetadata?.chip} · ${scanResults.some(result => result.measurement === 'adc') ? 'ADC raw 0–4095 / GPIO 0–1; ADC nicht spannungskalibriert.' : 'GPIO 0/1 · ohne ADC-Messung.'} Pull- und OUT-Werte getrennt.`;
        $('scan-results').replaceChildren(source, table);
        renderPinScope();
    }
    async function startScan() {
        if (!controller || busy || operation || scanAbort) return;
        const method = $('scan-method').value;
        const ids = scanTargets(); if (!ids.length) return;
        const current = controller;
        scanMetadata = { chip: chip.id, board: board.id, simulation: session === 'demo', capturedAt: new Date().toISOString() };
        scanAbort = new AbortController(); scanResults = []; operation = true; updateControls();
        $('scan-results').replaceChildren(); renderPinScope(); $('scan-progress').textContent = 'Polling anhalten, Scan vorbereiten …';
        try {
            await current.scanUsage(ids, { method, settleMs: Number($('scan-settle').value), signal: scanAbort.signal,
                onPhase: (id, phase) => { $('scan-state').textContent = `GPIO${id} · ${phase.toUpperCase()}`; $('scan-progress').textContent = `GPIO${id}: ${phase.toUpperCase()} messen …`; },
                onResult: result => { scanResults.push(result); renderScanResults(); }
            });
            $('scan-state').textContent = 'FERTIG';
            $('scan-progress').textContent = `${scanResults.length} Pin(s) getestet. Vorherige Pin-Konfiguration wiederhergestellt.`;
            status(`${session === 'demo' ? 'DEMO / SIMULATION · ' : ''}Usage-Scan abgeschlossen. Ergebnisse sind Reaktionshinweise, kein Nachweis der Pinrichtung.`);
        } catch (error) {
            if (error.name === 'AbortError') {
                $('scan-state').textContent = 'ABGEBROCHEN';
                $('scan-progress').textContent = 'Scan abgebrochen. Getesteter Pin wurde wiederhergestellt.';
            } else {
                $('scan-state').textContent = 'FEHLER'; $('scan-progress').textContent = error.message || String(error);
                await failure(error);
            }
        } finally {
            scanAbort = null; operation = false; sampleTimes = []; updateControls();
        }
    }
    async function changeReadMode(mode) {
        if (!controller || busy || operation) return;
        const current = controller, resume = current.running;
        operation = true; updateControls();
        try {
            await current.pause(); await current.setReadMode(mode);
            sampleTimes = []; lastPoll = null;
            if (resume) current.start(Number($('interval').value));
            status(`${session === 'demo' ? 'DEMO / SIMULATION · ' : ''}${mode === 'adc' ? 'ADC-Modus aktiv: Kanäle werden sequenziell gelesen. Rohwerte 0–4095; tatsächliche Rate pro ausgewähltem Pin beachten.' : 'Digitale GPIO-Messung aktiv. ADC-Register wiederhergestellt.'}`);
        } catch (error) { await failure(error); }
        finally { operation = false; updateControls(); }
    }

    function canvasContext(canvas) {
        const rect = canvas.getBoundingClientRect();
        const scale = Math.min(devicePixelRatio || 1, 2);
        const width = Math.round(rect.width * scale), height = Math.round(rect.height * scale);
        if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
        const context = canvas.getContext('2d'); context.setTransform(scale, 0, 0, scale, 0, 0);
        context.clearRect(0, 0, rect.width, rect.height);
        return { context, width: rect.width, height: rect.height };
    }
    function plot(context, history, t, x, y, width, height, detail = false, analog = false, period = 20) {
        context.save(); context.beginPath(); context.rect(x, y, width, height); context.clip();
        context.strokeStyle = '#293740'; context.lineWidth = .6;
        for (const fraction of [.2, .8]) { context.beginPath(); context.moveTo(x, y + height * fraction); context.lineTo(x + width, y + height * fraction); context.stroke(); }
        if (!history) { context.restore(); return; }
        history.prune(t);
        const gap = Math.max(Number($('interval').value) * 4, period * 3, 150);
        const opacity = context.createLinearGradient(x, y, x + width, y);
        // Both edges fade; the most recent sample is slightly inset at the right.
        const stroke = (key, rgb, lineWidth) => {
            opacity.addColorStop(0, `rgba(${rgb},0)`);
            opacity.addColorStop(.22, `rgba(${rgb},0.65)`);
            opacity.addColorStop(.82, `rgba(${rgb},1)`);
            opacity.addColorStop(1, `rgba(${rgb},0.12)`);
            context.strokeStyle = opacity; context.lineWidth = lineWidth; context.beginPath();
            let previous = null;
            for (const sample of history.samples) {
                const value = sample[key];
                if (value === null) {
                    if (key === 'drive') previous = null;
                    continue;
                }
                const px = x + (sample.t - (t - 1000)) / 1000 * width;
                const py = y + (value ? .2 : .8) * height;
                if (!previous || sample.t - previous.t > gap) context.moveTo(px, py);
                else { context.lineTo(px, previous.py); context.lineTo(px, py); }
                previous = { t: sample.t, py };
            }
            if (previous && t - previous.t <= gap) context.lineTo(x + width, previous.py);
            context.stroke();
        };
        // Draw the requested value wider, so overlapping readback stays visible.
        stroke('drive', '255,119,134', detail ? 4 : 3.4);
        // A separate gradient prevents the red trace's stops changing green.
        context.restore();
        context.save(); context.beginPath(); context.rect(x, y, width, height); context.clip();
        const green = context.createLinearGradient(x, y, x + width, y);
        green.addColorStop(0, 'rgba(104,232,165,0)'); green.addColorStop(.22, 'rgba(104,232,165,.65)'); green.addColorStop(.82, '#68e8a5'); green.addColorStop(1, 'rgba(104,232,165,.12)');
        context.strokeStyle = green; context.lineWidth = detail ? 1.7 : 1.4; context.beginPath();
        let previous = null;
        for (const sample of history.samples) {
            if (sample.breakRead) { previous = null; continue; }
            if (sample.read === null) continue;
            const px = x + (sample.t - (t - 1000)) / 1000 * width, py = y + (.8 - Math.max(0, Math.min(1, sample.read)) * .6) * height;
            if (!previous || sample.t - previous.t > gap) context.moveTo(px, py);
            else { if (!analog) context.lineTo(px, previous.py); context.lineTo(px, py); }
            previous = { t: sample.t, py };
        }
        if (previous && t - previous.t <= gap) context.lineTo(x + width, previous.py);
        context.stroke(); context.restore();
    }
    function frame(t) {
        renderedFrame = requestAnimationFrame(frame);
        if (document.hidden || t - lastFrame < 30) return;
        lastFrame = t;
        const map = canvasContext($('map-traces'));
        const sx = map.width / 1000, sy = map.height / mapHeight;
        for (const pin of layout) {
            const state = controller?.pins.get(pin.id);
            plot(map.context, state?.history, t, pin.x * sx, pin.y * sy, pin.width * sx, pin.height * sy, false, isAnalog(), state?.samplePeriod || 20);
        }
        const detail = canvasContext($('detail-trace'));
        const selectedState = controller?.pins.get(selectedPin);
        plot(detail.context, selectedState?.history, t, 8, 12, detail.width - 16, detail.height - 24, true, isAnalog(), selectedState?.samplePeriod || 20);
        if (t - lastUI > 100) {
            lastUI = t; updateMapState(); updateInspector(); renderPinScope();
            if (controller) {
                const count = sampleTimes.length;
                const hz = count > 1 ? (count - 1) * 1000 / (sampleTimes[count - 1] - sampleTimes[0]) : 0;
                const last = isAnalog() ? selectedState?.lastRead : lastPoll;
                const age = last == null ? null : Math.round(t - last);
                const adcCount = [...controller.pins.keys()].filter(id => adcChannel(id)).length;
                $('sampling').textContent = `${session === 'demo' ? 'SIMULIERT · ' : ''}${controller.running ? '●' : 'Ⅱ'} ${hz.toFixed(1)} Samples/s${isAnalog() ? ` an GPIO${selectedPin} · ${adcCount} ADC-Kanäle` : ` · ${controller.pins.size} Pins`}${age == null ? '' : ` · ${age} ms alt`}`;
            } else $('sampling').textContent = 'Vorschau · keine Messwerte';
        }
    }

    for (const config of Object.values(chips)) $('preview-chip').add(new Option(config.name, config.id));
    $('connect').addEventListener('click', connect);
    $('demo').addEventListener('click', demo);
    $('disconnect').addEventListener('click', async () => {
        if (busy) return; busy = true; updateControls();
        try { await shutdown(); status('Getrennt. Bei Hardware: Neustart der vorhandenen Firmware angefordert.'); }
        catch (error) { status(`Trennen fehlgeschlagen: ${error.message || error}`, 'error'); }
        finally { busy = false; updateControls(); }
    });
    $('preview-chip').addEventListener('change', () => {
        if (session !== 'offline' || busy) return;
        chip = chips[$('preview-chip').value]; board = availableBoards()[0];
        clearScan();
        selectedPin = board.pins.find(pin => pin.gpio !== null && !pinReason(pin.gpio))?.gpio ?? 0;
        planned = null; peripheral = 'gpio'; catalog = null; ++catalogRequest;
        renderDevices(); renderMap(); renderFunctions(); renderPeripherals(); updateInspector(); renderCatalog();
        status(`${chip.name} · Vorschau. Hardware wird beim Verbinden automatisch erkannt.`);
    });
    $('pin-function').addEventListener('change', () => {
        const value = $('pin-function').value;
        if (value === 'input' || value === 'output') { planned = null; changePin(value, controller?.pins.get(selectedPin)?.pull || 'none'); }
        else { planned = value; updateInspector(); }
    });
    $('pin-pull').addEventListener('change', () => changePin(controller?.pins.get(selectedPin)?.mode || 'input', $('pin-pull').value));
    $('set-low').addEventListener('click', () => changeLevel(selectedPin, 0));
    $('set-high').addEventListener('click', () => changeLevel(selectedPin, 1));
    $('pause').addEventListener('click', async () => {
        if (!controller || busy || operation) return;
        operation = true; updateControls();
        try {
            if (controller.running) { await controller.pause(); status('Messung pausiert. Ausgangspegel bleiben aktiv.'); }
            else { sampleTimes = []; controller.start(Number($('interval').value)); status(`${session === 'demo' ? 'DEMO / SIMULATION · ' : ''}Messung fortgesetzt.`); }
        } finally { operation = false; updateControls(); }
    });
    $('interval').addEventListener('change', async () => {
        if (!controller || busy || operation) return;
        operation = true; const wasRunning = controller.running; updateControls();
        try { await controller.pause(); controller.interval = Number($('interval').value); sampleTimes = []; if (wasRunning) controller.start(controller.interval); }
        finally { operation = false; updateControls(); }
    });
    $('read-mode').addEventListener('change', () => changeReadMode($('read-mode').value));
    $('scan-start').addEventListener('click', startScan);
    $('scan-cancel').addEventListener('click', () => { scanAbort?.abort(); $('scan-progress').textContent = 'Abbruch angefordert; laufenden Zugriff beenden und Pin wiederherstellen …'; });
    for (const id of ['scan-target', 'scan-method']) $(id).addEventListener('change', updateScanControls);
    $('scan-export').addEventListener('click', () => {
        const data = { format: 'esp-io-usage-scan-v2', ...scanMetadata, rawMax: 4095, calibrated: false, results: scanResults };
        const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
        const link = document.createElement('a'); link.href = url; link.download = `usage-scan-${chip.id}.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
    for (const role of sdRoles) $(`sd-${role}`).addEventListener('change', () => {
        if (sdHost?.ready || busy || operation) return;
        sdDraft().pins[role] = $(`sd-${role}`).value === '' ? null : Number($(`sd-${role}`).value);
        updateSDControls(); updateMapState();
    });
    $('sd-width').addEventListener('change', () => { sdDraft().width = Number($('sd-width').value); updateSDControls(); });
    $('sd-power').addEventListener('change', () => { if (sdHost?.ready || busy || operation) return; sdDraft().power = $('sd-power').value; updateSDControls(); updateMapState(); });
    $('sd-board-preset').addEventListener('click', () => {
        if (sdHost?.ready || busy || operation || !board.sd) return;
        Object.assign(sdDraft(), { pins: { ...board.sd.pins }, power: board.sd.power });
        renderSD(); updateMapState();
    });
    for (const [key, spec] of Object.entries(sdCommands)) $('sd-command').add(new Option(spec.name, key));
    $('sd-command').value = 'cmd13'; sdCommandArgument();
    $('sd-command').addEventListener('change', sdCommandArgument);
    for (const [id, action] of [['sd-apply', 'apply'], ['sd-release', 'release'], ['sd-identify', 'identify'], ['sd-send', 'send']]) $(id).addEventListener('click', () => sdAction(action));
    $('sd-cancel').addEventListener('click', () => { sdAbort?.abort(); $('sd-progress').textContent = 'Abbruch angefordert; laufenden Registerzugriff und Freigabe abwarten …'; updateSDControls(); });
    $('sd-clear').addEventListener('click', () => { sdLog = []; renderSDLog(); });
    for (const id of ['sd-download-start', 'sd-download-end']) $(id).addEventListener('input', updateSDControls);
    $('sd-download-all').addEventListener('click', () => { $('sd-download-start').value = '0'; $('sd-download-end').value = 'max'; updateSDControls(); });
    $('sd-download').addEventListener('click', downloadSD);
    $('sd-download-cancel').addEventListener('click', () => { sdAbort?.abort(); updateSDControls(); });
    $('catalog-details').addEventListener('toggle', () => { if ($('catalog-details').open) loadCatalog(); });
    $('register-filter').addEventListener('input', renderCatalog);
    $('register-block').addEventListener('change', renderCatalog);
    window.addEventListener('pagehide', () => {
        // Browser teardown is not a reliable place for asynchronous serial I/O.
        // Stop polling immediately; use the explicit disconnect action for reset.
        cancelAnimationFrame(renderedFrame);
        scanAbort?.abort();
        sdAbort?.abort();
        i2cPanel.abort();
        if (controller) { controller.running = false; clearTimeout(controller.timer); }
    });
    renderDevices(); renderMap(); renderFunctions(); renderPeripherals(); updateControls();
    if (!navigator.serial) status('Hardwarezugriff benötigt Chrome/Edge mit Web Serial. Die Vorschau und Demo sind verfügbar.');
    requestAnimationFrame(frame);
})();
