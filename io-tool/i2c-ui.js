(function (root) {
    'use strict';
    const { I2CHost, i2cProfiles, parseHexBytes } = root.ESPIO;
    const $ = id => document.getElementById(id);
    const hex = value => '0x' + value.toString(16).padStart(2, '0');
    const bytes = value => value?.length ? value.map(v => v.toString(16).padStart(2, '0').toUpperCase()).join(' ') : '—';
    root.ESPIO.createI2CPanel = function (ctx) {
        let host = null, cancel = null, log = [], found = [];
        const drafts = new Map();
        const draft = () => {
            const key = `${ctx.chip().id}:${ctx.board().id}`;
            if (!drafts.has(key)) drafts.set(key, { sda: null, scl: null, port: 0, speed: 100000, pullups: true });
            return drafts.get(key);
        };
        const live = () => host?.ready && host.controller === ctx.controller();
        function validation() {
            if (ctx.backendReason?.()) return ctx.backendReason();
            const d = draft(), pins = ctx.pins(), chip = ctx.chip();
            if (!i2cProfiles[chip.id]) return 'Für diesen Chip noch nicht implementiert.';
            if (d.sda === null || d.scl === null) return 'SDA und SCL auswählen.';
            if (d.sda === d.scl) return 'SDA und SCL benötigen verschiedene GPIOs.';
            for (const id of [d.sda, d.scl]) {
                const pin = chip.pins.find(p => p.id === id), owner = ctx.controller()?.pinOwners.get(id);
                if (!pins.includes(id) || !pin?.output || pin.reserved || (owner && !(live() && host.pinStates.has(id)))) return `GPIO${id} ist nicht frei verfügbar${owner ? ` (${owner})` : ''}.`;
            }
            return '';
        }
        function update() {
            const ready = live(), blocked = ctx.blocked() || !ctx.controller() || ctx.controller().fault;
            for (const id of ['i2c-port', 'i2c-sda', 'i2c-scl', 'i2c-speed', 'i2c-pullups']) $(id).disabled = ready || ctx.blocked();
            $('i2c-apply').disabled = blocked || ready || !!validation();
            $('i2c-release').hidden = !ready; $('i2c-release').disabled = blocked;
            $('i2c-board-preset').disabled = ready || ctx.blocked();
            for (const id of ['i2c-scan', 'i2c-transfer']) $(id).disabled = blocked || !!validation();
            for (const id of ['i2c-address', 'i2c-write', 'i2c-read']) $(id).disabled = ctx.blocked();
            $('i2c-cancel').hidden = !cancel; $('i2c-cancel').disabled = cancel?.signal.aborted || false;
            $('i2c-state').textContent = cancel ? 'LÄUFT' : ready ? `${ctx.session() === 'demo' ? 'SIMULATION · ' : ''}AKTIV · I²C${host.config.port}` : 'NICHT AKTIV';
            $('i2c-note').textContent = validation() || (ready ? 'Pins zugewiesen; GPIO-Steuerung, ADC und Usage-Scan dieser Pins ausgesetzt.' : 'Bereit. Aktivieren oder direkt scannen / übertragen.');
        }
        function render(visible) {
            $('i2c-panel').hidden = !visible;
            $('i2c-backend').textContent = i2cProfiles[ctx.chip().id] ? 'P4 · nativer HP-I²C-Master 0/1 · GPIO-Matrix · 7-Bit-Adressen' : 'I²C-Steuerung ist zunächst für ESP32-P4 implementiert.';
            $('i2c-configuration').hidden = !i2cProfiles[ctx.chip().id];
            for (const role of ['sda', 'scl']) {
                const select = $(`i2c-${role}`); select.replaceChildren(new Option('Bitte wählen …', ''));
                for (const id of ctx.pins().slice().sort((a, b) => a - b)) select.add(ctx.gpioOption(id));
                select.value = draft()[role] === null ? '' : String(draft()[role]);
            }
            $('i2c-port').value = String(draft().port); $('i2c-speed').value = String(draft().speed); $('i2c-pullups').checked = draft().pullups;
            $('i2c-board-preset').hidden = !ctx.board().i2c;
            update();
        }
        function renderLog() {
            $('i2c-result').textContent = log.length ? log.map(e => `${e.simulation ? '[SIMULIERT] ' : ''}${hex(e.address)} · TX ${bytes(e.write)} · RX ${bytes(e.read)} · ${(e.finishedAt - e.startedAt).toFixed(1)} ms${e.error ? '\n  ' + e.error : ''}`).join('\n') : 'Noch keine Transaktionen.';
            $('i2c-result').scrollTop = $('i2c-result').scrollHeight;
        }
        function renderAddresses() {
            $('i2c-addresses').replaceChildren();
            for (const address of found) {
                const button = document.createElement('button'); button.textContent = hex(address);
                button.addEventListener('click', () => { $('i2c-address').value = hex(address); }); $('i2c-addresses').append(button);
            }
        }
        async function action(kind) {
            if (ctx.blocked() || !ctx.controller() || ctx.controller().fault) return;
            let address, data, length;
            try {
                if (kind === 'transfer') {
                    const text = $('i2c-address').value.trim();
                    if (!/^(?:0x[0-9a-f]{1,2}|\d{1,3})$/i.test(text)) throw new Error('7-Bit-Adresse eingeben, z. B. 0x18.');
                    address = Number(text); data = parseHexBytes($('i2c-write').value); length = Number($('i2c-read').value);
                    if (address > 127) throw new Error('Maximale 7-Bit-Adresse: 0x7F.');
                }
            } catch (error) { $('i2c-progress').textContent = error.message; return; }
            cancel = new AbortController(); const signal = cancel.signal;
            ctx.setOperation(true); $('i2c-progress').className = ''; $('i2c-progress').textContent = 'I²C-Port vorbereiten …';
            try {
                if (kind === 'release') { await host?.close(); host = null; $('i2c-progress').textContent = 'Port freigegeben; GPIO-Konfiguration wiederhergestellt.'; }
                else {
                    if (!live()) {
                        const simulation = ctx.session() === 'demo';
                        host = new I2CHost(ctx.controller(), { onTransaction: entry => { log.push({ ...entry, simulation }); if (log.length > 150) log.shift(); renderLog(); } });
                        await host.open(draft(), signal);
                    }
                    if (kind === 'scan') {
                        found = []; renderAddresses();
                        await host.scan({ signal, onFound: address => { found.push(address); renderAddresses(); }, onProgress: (address, count) => { $('i2c-progress').textContent = `${ctx.session() === 'demo' ? 'SIMULATION · ' : ''}${hex(address)} / 0x77 · ${count} gefunden`; } });
                        $('i2c-progress').textContent = `${ctx.session() === 'demo' ? 'SIMULATION · ' : ''}Scan fertig · ${found.length} Adressen gefunden.`;
                    } else if (kind === 'transfer') {
                        const result = await host.transfer(address, data, length, signal);
                        $('i2c-progress').textContent = `${ctx.session() === 'demo' ? 'SIMULATION · ' : ''}${hex(address)} · ACK · ${result.length ? 'RX ' + bytes(Array.from(result)) : 'Schreib-/Adressphase abgeschlossen'}`;
                    } else $('i2c-progress').textContent = 'I²C-Port aktiv.';
                }
            } catch (error) { $('i2c-progress').textContent = error.message; $('i2c-progress').className = error.name === 'AbortError' ? '' : 'error'; ctx.log('I²C:', error.message); }
            finally { cancel = null; ctx.setOperation(false); render(!$('i2c-panel').hidden); }
        }
        for (const role of ['sda', 'scl']) $(`i2c-${role}`).addEventListener('change', () => { if (live() || ctx.blocked()) return; draft()[role] = $(`i2c-${role}`).value === '' ? null : Number($(`i2c-${role}`).value); ctx.update(); });
        for (const field of ['port', 'speed', 'pullups']) $(`i2c-${field}`).addEventListener('change', () => { if (live() || ctx.blocked()) return; draft()[field] = field === 'pullups' ? $('i2c-pullups').checked : Number($(`i2c-${field}`).value); update(); });
        for (const kind of ['apply', 'release', 'scan', 'transfer']) $(`i2c-${kind}`).addEventListener('click', () => action(kind));
        $('i2c-cancel').addEventListener('click', () => { cancel?.abort(); update(); });
        $('i2c-board-preset').addEventListener('click', () => { if (live() || ctx.blocked() || !ctx.board().i2c) return; Object.assign(draft(), ctx.board().i2c); render(true); ctx.update(); });
        return { render, update, role(id) { const d = live() ? host.config : draft(); return d.sda === id ? 'I²C SDA' : d.scl === id ? 'I²C SCL' : ''; },
            reset() { host = null; log = []; found = []; $('i2c-progress').textContent = ''; renderLog(); renderAddresses(); }, abort() { cancel?.abort(); } };
    };
})(globalThis);
