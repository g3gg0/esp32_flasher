(function (root) {
    'use strict';
    const $ = id => document.getElementById(id);
    root.ESPIO.createPeripheralPanels = function (ctx) {
        const hosts = { spi: null, pwm: null }, drafts = new Map();
        const draft = kind => { const key = `${ctx.chip().id}:${ctx.board().id}:${kind}`; if (!drafts.has(key)) drafts.set(key, kind === 'spi' ? { port: 1, clk: '', mosi: '', miso: '', cs: '', speed: 1000000, mode: 0, lsb: false } : { port: 0, pin: '', timer: 0, frequency: 1000, bits: 10, duty: 500 }); return drafts.get(key); };
        const roles = kind => kind === 'spi' ? ['clk', 'mosi', 'miso', 'cs'] : ['pin'];
        const active = kind => hosts[kind]?.ready && hosts[kind].controller === ctx.controller();
        for (const kind of ['spi', 'pwm']) {
            const panel = document.createElement('div'); panel.id = `${kind}-panel`; panel.className = 'sd-panel'; panel.hidden = true;
            panel.innerHTML = `<div class="sd-heading"><h3>${kind === 'spi' ? 'SPI-Master' : 'PWM / LEDC'}</h3><span id="${kind}-state" class="chip-badge">NICHT AKTIV</span></div><p id="${kind}-note" class="sd-note"></p><div id="${kind}-config" class="sd-actions"></div><div class="sd-actions"><button id="${kind}-apply">Aktivieren</button><button id="${kind}-release" hidden>Freigeben</button></div><div id="${kind}-actions" class="sd-actions"></div><pre id="${kind}-result" class="bus-log" role="status"></pre>`;
            $('i2c-panel').after(panel);
            const field = (name, title, type, values) => {
                const label = document.createElement('label'); label.textContent = title + ' ';
                const input = document.createElement(type === 'select' ? 'select' : 'input'); input.id = `${kind}-${name}`;
                if (type === 'select') for (const [value, text] of values || []) input.add(new Option(text, value));
                else input.type = type;
                if (type === 'number') { input.min = '0'; input.step = '1'; }
                input.addEventListener('change', () => { if (active(kind) && name !== 'duty') return; draft(kind)[name] = type === 'checkbox' ? input.checked : roles(kind).includes(name) ? (input.value === '' ? '' : Number(input.value)) : Number(input.value); update(); });
                label.append(input); $(`${kind}-config`).append(label);
            };
            field('port', kind === 'spi' ? 'Controller' : 'Kanal', 'select');
            for (const role of roles(kind)) field(role, role.toUpperCase(), 'select');
            if (kind === 'spi') {
                field('speed', 'Takt Hz · 1–20000000', 'number'); field('mode', 'Modus', 'select', [0, 1, 2, 3].map(i => [i, String(i)])); field('lsb', 'LSB zuerst', 'checkbox');
                $('spi-actions').innerHTML = '<label>TX · Hex-Bytes <input id="spi-tx" value="9F 00 00 00" spellcheck="false"></label><button id="spi-transfer">Übertragen</button><small>1–64 Bytes · Vollduplex · CS0 bleibt während der Transaktion LOW.</small>';
                $('spi-transfer').addEventListener('click', () => action(kind, 'transfer'));
            } else {
                field('timer', 'Timer', 'select', [0, 1, 2, 3].map(i => [i, String(i)])); field('frequency', 'Frequenz Hz', 'number'); field('bits', 'Auflösung Bits', 'number'); field('duty', 'Tastgrad ‰ · 0–1000', 'number');
                $('pwm-actions').innerHTML = '<button id="pwm-update">Tastgrad setzen</button><small>Low-Speed-LEDC · Timer werden zwischen Kanälen geteilt; Konflikte werden abgewiesen.</small>';
                $('pwm-update').addEventListener('click', () => action(kind, 'duty'));
            }
            for (const task of ['apply', 'release']) $(`${kind}-${task}`).addEventListener('click', () => action(kind, task));
        }
        function render(selected) {
            for (const kind of ['spi', 'pwm']) {
                $(`${kind}-panel`).hidden = selected !== kind;
                const d = draft(kind), select = $(`${kind}-port`), previous = d.port;
                const large = ['esp32', 'esp32s2', 'esp32s3', 'esp32p4'].includes(ctx.chip().id);
                select.replaceChildren(); const n = kind === 'spi' ? (large ? 2 : 1) : (large ? 8 : 6), first = kind === 'spi' ? 1 : 0;
                for (let i = first; i < first + n; ++i) select.add(new Option(kind === 'spi' ? `SPI${i + 1}` : `Kanal ${i}`, i));
                d.port = previous < first + n ? previous : first;
                for (const role of roles(kind)) {
                    const input = $(`${kind}-${role}`); input.replaceChildren(new Option('Bitte wählen …', ''));
                    for (const id of ctx.pins().slice().sort((a, b) => a - b)) input.add(ctx.gpioOption(id));
                }
                for (const [key, value] of Object.entries(d)) { const input = $(`${kind}-${key}`); if (input.type === 'checkbox') input.checked = value; else input.value = value; }
            }
            update();
        }
        function update() {
            for (const kind of ['spi', 'pwm']) {
                const ready = active(kind), blocked = ctx.blocked() || !ctx.controller() || ctx.controller().fault, supported = ctx.controller()?.transport.supports?.(kind.toUpperCase());
                $(`${kind}-state`).textContent = ready ? `AKTIV · ${hosts[kind].actualHz} Hz` : 'NICHT AKTIV';
                $(`${kind}-note`).textContent = supported ? 'Pins werden reserviert und bei Freigabe wiederhergestellt.' : 'Beschleunigten Stub laden, um diese Funktion zu verwenden.';
                for (const input of $(`${kind}-config`).querySelectorAll('input,select')) input.disabled = blocked || (ready && input.id !== 'pwm-duty');
                $(`${kind}-apply`).disabled = blocked || ready || !supported || roles(kind).some(role => draft(kind)[role] === '');
                $(`${kind}-release`).hidden = !ready; $(`${kind}-release`).disabled = blocked;
                $(kind === 'spi' ? 'spi-transfer' : 'pwm-update').disabled = blocked || !ready;
            }
        }
        async function action(kind, task) {
            if (ctx.blocked()) return;
            ctx.setOperation(true);
            try {
                if (task === 'release') { await hosts[kind].close(); hosts[kind] = null; $(`${kind}-result`).textContent = 'Freigegeben.'; }
                else if (task === 'apply') {
                    const Host = kind === 'spi' ? root.ESPIO.SPIHost : root.ESPIO.PWMHost;
                    hosts[kind] = new Host(ctx.controller()); await hosts[kind].open(draft(kind)); $(`${kind}-result`).textContent = `${hosts[kind].actualHz} Hz`;
                } else if (kind === 'spi') {
                    const data = await hosts.spi.transfer(root.ESPIO.parseHexBytes($('spi-tx').value));
                    $('spi-result').textContent = 'RX ' + Array.from(data, b => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');
                } else { await hosts.pwm.duty(Number($('pwm-duty').value)); $('pwm-result').textContent = `${$('pwm-duty').value} ‰`; }
            } catch (e) { $(`${kind}-result`).textContent = e.message; ctx.log(kind.toUpperCase(), e.message); }
            finally { ctx.setOperation(false); update(); }
        }
        return { render, update, reset() { hosts.spi = hosts.pwm = null; }, role(id) { for (const kind of ['spi', 'pwm']) if (active(kind)) for (const role of roles(kind)) if (hosts[kind].config[role] === id) return `${kind.toUpperCase()} ${role.toUpperCase()}`; return ''; } };
    };
})(globalThis);
