// WS2812 / SK6812 (RGB and RGBW) LED tool on top of the RMT output that was activated in the RMT block.
// Activate RMT with 20 MHz resolution on the LED data pin first.
(function () {
    const TYPES = {
        ws2812: { name: 'WS2812 / WS2812B · 3 Kanäle (GRB)', order: [1, 0, 2], channels: 3, t0h: 350, t0l: 900, t1h: 700, t1l: 550, gapUs: 80 },
        sk6812: { name: 'SK6812 · 3 Kanäle (GRB)', order: [1, 0, 2], channels: 3, t0h: 300, t0l: 900, t1h: 600, t1l: 600, gapUs: 80 },
        sk6812w: { name: 'SK6812 RGBW · 4 Kanäle (GRBW)', order: [1, 0, 2, 3], channels: 4, t0h: 300, t0l: 900, t1h: 600, t1l: 600, gapUs: 80 }
    };
    const MAX_SYMBOLS = 32768; // two symbol types fit into 4096 bytes of upload RAM

    function hsvToRgb(h, s, v) {
        const k = n => (n + h / 60) % 6, f = n => v * (1 - s * Math.max(0, Math.min(k(n), 4 - k(n), 1)));
        return [f(5), f(3), f(1)].map(x => Math.round(x * 255));
    }
    function rgbToHsv([r, g, b]) {
        r /= 255; g /= 255; b /= 255;
        const max = Math.max(r, g, b), d = max - Math.min(r, g, b);
        const h = !d ? 0 : max === r ? ((g - b) / d + 6) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
        return { h: h * 60, s: max ? d / max : 0, v: max };
    }
    const hex = ([r, g, b]) => '#' + [r, g, b].map(x => x.toString(16).padStart(2, '0')).join('');

    function encode(type, leds, brightness, hz) {
        const ticks = ns => Math.round(hz * ns / 1e9);
        const zero = ESPIO.rmtSymbol(1, ticks(type.t0h), 0, ticks(type.t0l)), one = ESPIO.rmtSymbol(1, ticks(type.t1h), 0, ticks(type.t1l));
        const times = [type.t0h, type.t0l, type.t1h, type.t1l].map(ticks);
        if (times.some(n => n < 1 || n > 32767)) throw new Error('RMT-Auflösung ungeeignet. Port freigeben und mit 20000000 Hz aktivieren.');
        const out = new Uint32Array(leds.length * type.channels * 8);
        let n = 0;
        for (const led of leds) for (const channel of type.order) {
            const value = Math.round(led[channel] * brightness);
            for (let bit = 7; bit >= 0; bit--) out[n++] = (value >> bit) & 1 ? one : zero;
        }
        return out;
    }

    module.exports = {
        id: 'ws2812',
        name: 'WS2812 / SK6812',
        version: '1.0',
        description: 'Adressierbare LEDs (3- und 4-Kanal) mit Farbrad, Helligkeit, LED-Anzahl und Regenbogen.',
        interfaces: [{ id: 'rmt', kinds: ['rmt'], label: 'RMT-Ausgang' }],
        async load(api) {
            const host = api.interfaces.rmt.host;
            const state = { type: 'ws2812', count: 8, hsv: { h: 0, s: 1, v: 1 }, white: 0, leds: [] };
            const block = api.ui.block('LED-Streifen');
            let animation = null, selection = [0, 0];

            const config = block.row();
            const typeField = config.field('LED-Typ', { options: Object.entries(TYPES).map(([id, type]) => [id, type.name]) });
            const countField = config.field('Anzahl LEDs', { value: state.count, type: 'number', width: '80px' });
            const brightnessField = config.field('Helligkeit %', { value: 20, type: 'number', width: '70px' });
            const liveField = config.field('Sofort senden', { value: true, type: 'checkbox' });

            const current = () => TYPES[state.type];
            const rgb = () => hsvToRgb(state.hsv.h, state.hsv.s, state.hsv.v);
            const color = () => [...rgb(), current().channels === 4 ? state.white : 0];
            const brightness = () => Math.max(0, Math.min(100, Number(brightnessField.value) || 0)) / 100;

            const picker = document.createElement('div');
            picker.style.cssText = 'display:flex;gap:18px;flex-wrap:wrap;align-items:center;margin:12px 0';
            const wheel = document.createElement('canvas');
            wheel.width = wheel.height = 160; wheel.style.cssText = 'width:160px;height:160px;border-radius:50%;cursor:crosshair;touch-action:none';
            wheel.setAttribute('aria-label', 'Farbrad: Winkel = Farbton, Radius = Sättigung');
            const controls = document.createElement('div');
            controls.style.cssText = 'display:flex;flex-direction:column;gap:10px;min-width:220px';
            const swatch = document.createElement('div');
            swatch.style.cssText = 'height:34px;border:1px solid #4a5560;border-radius:6px';
            const slider = (label, max, value, onInput) => {
                const wrap = document.createElement('label'), input = document.createElement('input');
                input.type = 'range'; input.min = 0; input.max = max; input.value = value; input.style.width = '100%';
                input.addEventListener('input', () => onInput(Number(input.value)));
                wrap.append(`${label} `, input);
                controls.append(wrap);
                return input;
            };
            const valueSlider = slider('Wert', 100, 100, v => { state.hsv.v = v / 100; changed(); });
            const whiteSlider = slider('Weiß (nur RGBW)', 255, 0, v => { state.white = v; changed(); });
            const hexInput = document.createElement('input');
            hexInput.value = '#ff0000'; hexInput.spellcheck = false; hexInput.setAttribute('aria-label', 'Farbe als Hex-RGB'); hexInput.style.width = '100px';
            const native = document.createElement('input');
            native.type = 'color'; native.value = '#ff0000'; native.setAttribute('aria-label', 'Systemfarbwähler'); native.style.cssText = 'width:44px;padding:2px;height:34px';
            const hexRow = document.createElement('div');
            hexRow.style.cssText = 'display:flex;gap:8px;align-items:center';
            hexRow.append(hexInput, native);
            controls.prepend(swatch); controls.append(hexRow);
            picker.append(wheel, controls);
            block.body.append(picker);

            function drawWheel() {
                const ctx = wheel.getContext('2d'), size = wheel.width, r = size / 2, image = ctx.createImageData(size, size);
                for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
                    const dx = x + .5 - r, dy = y + .5 - r, d = Math.hypot(dx, dy), i = (y * size + x) * 4;
                    if (d > r) continue;
                    const [R, G, B] = hsvToRgb((Math.atan2(dy, dx) * 180 / Math.PI + 360) % 360, d / r, 1);
                    image.data.set([R, G, B, 255], i);
                }
                ctx.putImageData(image, 0, 0);
                const m = state.hsv, a = m.h * Math.PI / 180;
                ctx.beginPath(); ctx.arc(r + Math.cos(a) * m.s * r, r + Math.sin(a) * m.s * r, 6, 0, 7);
                ctx.lineWidth = 2; ctx.strokeStyle = '#000'; ctx.stroke(); ctx.lineWidth = 1; ctx.strokeStyle = '#fff'; ctx.stroke();
            }
            function pick(event) {
                const box = wheel.getBoundingClientRect(), x = (event.clientX - box.left) / box.width * 2 - 1, y = (event.clientY - box.top) / box.height * 2 - 1;
                state.hsv.h = (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
                state.hsv.s = Math.min(1, Math.hypot(x, y));
                changed();
            }
            wheel.addEventListener('pointerdown', event => { wheel.setPointerCapture(event.pointerId); pick(event); });
            wheel.addEventListener('pointermove', event => { if (wheel.hasPointerCapture(event.pointerId)) pick(event); });
            hexInput.addEventListener('change', () => setFromHex(hexInput.value));
            native.addEventListener('input', () => setFromHex(native.value));
            function setFromHex(text) {
                const m = /^#?([0-9a-f]{6})$/i.exec(text.trim());
                if (!m) { block.setStatus('Farbe als RRGGBB eingeben.', 'error'); return; }
                state.hsv = rgbToHsv([0, 2, 4].map(i => parseInt(m[1].slice(i, i + 2), 16)));
                valueSlider.value = Math.round(state.hsv.v * 100);
                changed();
            }
            function changed() {
                const c = rgb();
                swatch.style.background = hex(c); hexInput.value = hex(c); native.value = hex(c);
                valueSlider.value = Math.round(state.hsv.v * 100);
                whiteSlider.disabled = current().channels !== 4;
                drawWheel();
            }

            // LED preview strip: click selects a single LED, shift-click extends the range.
            const strip = document.createElement('div');
            strip.style.cssText = 'display:flex;flex-wrap:wrap;gap:3px;margin:8px 0;max-height:150px;overflow:auto';
            block.body.append(strip);
            function resize() {
                const count = Math.max(1, Math.min(Math.floor(MAX_SYMBOLS / (current().channels * 8)), Number(countField.value) | 0 || 1));
                countField.value = count; state.count = count;
                while (state.leds.length < count) state.leds.push([0, 0, 0, 0]);
                state.leds.length = count;
                selection = [Math.min(selection[0], count - 1), Math.min(selection[1], count - 1)];
                paintStrip();
            }
            function paintStrip() {
                strip.replaceChildren(...state.leds.map((led, index) => {
                    const dot = document.createElement('button');
                    const lo = Math.min(...selection), hi = Math.max(...selection), shown = hex(led.slice(0, 3).map((v, i) => Math.min(255, Math.round(v + (current().channels === 4 ? led[3] : 0)))));
                    dot.style.cssText = `width:18px;height:18px;padding:0;border-radius:50%;background:${shown};border:2px solid ${index >= lo && index <= hi ? '#fff' : '#39434d'}`;
                    dot.title = `LED ${index + 1}`;
                    dot.addEventListener('click', event => { selection = event.shiftKey ? [selection[0], index] : [index, index]; fromRange.value = Math.min(...selection) + 1; toRange.value = Math.max(...selection) + 1; paintStrip(); });
                    return dot;
                }));
            }

            const range = block.row();
            const fromRange = range.field('LED von', { value: 1, type: 'number', width: '70px' }), toRange = range.field('bis', { value: 1, type: 'number', width: '70px' });
            const readRange = () => {
                const from = Math.max(1, Number(fromRange.value) | 0), to = Math.min(state.count, Math.max(from, Number(toRange.value) | 0));
                selection = [from - 1, to - 1]; return selection;
            };
            async function send() {
                const type = current(), data = encode(type, state.leds, brightness(), host.actualHz);
                const result = await host.send(data, { idleUs: type.gapUs, signal: api.signal });
                block.setStatus(`${state.count} LEDs · ${result.values[0]} Symbole`);
            }
            const apply = async fn => { fn(); paintStrip(); if (liveField.value) await send(); };
            range.button('Auswahl setzen', () => apply(() => { const [a, b] = readRange(); for (let i = a; i <= b; i++) state.leds[i] = color(); }), { primary: true });
            range.button('Alle setzen', () => apply(() => { state.leds = state.leds.map(() => color()); }));
            range.button('Alle aus', () => apply(() => state.leds.forEach((_, i) => state.leds[i] = [0, 0, 0, 0])));
            range.button('Regenbogen', () => apply(() => state.leds.forEach((_, i) => { state.leds[i] = [...hsvToRgb(i / state.count * 360, 1, 1), 0]; })));
            range.button('Senden', send);

            const anim = block.row();
            const speed = anim.field('Geschwindigkeit', { options: [['1', 'langsam'], ['3', 'mittel'], ['8', 'schnell']] });
            const toggle = anim.button('Regenbogen-Animation starten', async () => {
                if (animation) { animation.abort(); return; }
                const abort = animation = new AbortController();
                toggle.textContent = 'Animation stoppen';
                const started = performance.now();
                try {
                    // One outstanding frame at a time; the phase follows the clock so slow links only drop frames.
                    while (!abort.signal.aborted && !api.signal.aborted) {
                        const phase = (performance.now() - started) / 1000 * Number(speed.value) * 30;
                        state.leds = state.leds.map((_, i) => [...hsvToRgb((i / state.count * 360 + phase) % 360, 1, 1), 0]);
                        await send();
                        await api.sleep(10);
                    }
                } finally { animation = null; toggle.textContent = 'Regenbogen-Animation starten'; paintStrip(); }
            }, { raw: true });

            typeField.input.addEventListener('change', () => { state.type = typeField.value; changed(); resize(); });
            countField.input.addEventListener('change', resize);
            api.signal.addEventListener('abort', () => animation?.abort());
            block.text(`Datenleitung am gewählten RMT-Ausgang (${api.interfaces.rmt.label}); Pegelwandler 3,3 V → 5 V empfohlen. Bis ${MAX_SYMBOLS / 24 | 0} LEDs (3 Kanäle) bzw. ${MAX_SYMBOLS / 32} LEDs (4 Kanäle).`);
            changed(); resize();
        }
    };
})();
