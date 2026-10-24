(function (root) {
    'use strict';
    // Static SVG preserves acquisition resolution at every display size. The
    // timestamps are host-side bounds, never a fabricated MCU sample clock.
    function scopeSVG(result) {
        const runs = result?.runs || [];
        if (!runs.length) return '';
        const w = 620, h = 186, left = 38, top = 18, width = 566, height = 132;
        const duration = Math.max(1, ...runs.map(run => run.finishedAt - run.startedAt));
        const x = t => left + t / duration * width;
        const y = v => top + height * (1 - v);
        const f = n => n.toFixed(2);
        const digital = result.measurement === 'digital';
        const sequence = result.method === 'observe' ? 'Eingangsmessung' : 'LOW HIGH LOW';
        let svg = `<svg viewBox="0 0 ${w} ${h}" role="img" aria-label="GPIO${result.id}: ${sequence}, ${digital ? 'digitaler Istwert' : 'ADC und digitaler Istwert'}; Pull und Output überlagert"><title>GPIO${result.id}: Pull / Output, echte Messzeitpunkte</title>`;
        for (let i = 0; i <= 4; i++) {
            const px = left + width * i / 4, py = top + height * i / 4;
            svg += `<path d="M${px} ${top}V${top + height}M${left} ${py}H${left + width}" stroke="#293740" stroke-width=".6"/><text x="${px}" y="170" text-anchor="middle">${(duration * i / 4).toFixed(1)}</text>`;
        }
        svg += `<text x="4" y="22">${digital ? '1 / HI' : '4095'}</text><text x="18" y="153">0</text><text x="606" y="183" text-anchor="end">ms ab Messbeginn / Durchlauf</text>`;
        for (const run of runs) {
            const offset = run.startedAt, color = run.method === 'pull' ? '#68e8a5' : '#67c9ff';
            let path = '', previous = null;
            for (const sample of run.samples) {
                const px = x(sample.t - offset), py = y(digital ? sample.io : sample.value);
                path += digital && previous ? `H${f(px)}V${f(py)}` : `${previous ? 'L' : 'M'}${f(px)} ${f(py)}`; previous = sample;
                // Thin horizontal whisker = START send .. DONE received.
                svg += `<path d="M${f(x(sample.startedAt - offset))} ${f(py)}H${f(x(sample.doneAt - offset))}" stroke="${color}" opacity=".22"/><circle cx="${f(px)}" cy="${f(py)}" r="2" fill="${color}"><title>${digital ? `GPIO ${sample.io}; GPIO` : `${sample.raw} raw; ADC`}-Fenster ${(sample.startedAt - offset).toFixed(2)}–${(sample.doneAt - offset).toFixed(2)} ms${!digital && sample.io != null ? `; GPIO ${sample.io}` : ''}</title></circle>`;
            }
            svg += `<path d="${path}" stroke="${color}" stroke-width="1.5" fill="none"/>`;
            // Digital readback is separate from the requested command trace.
            let ioPath = '', prevIO = null;
            for (const sample of digital ? [] : run.samples.filter(s => s.io != null)) {
                const px = x((sample.ioStartedAt + sample.ioDoneAt) / 2 - offset), py = y(sample.io);
                ioPath += prevIO == null ? `M${f(px)} ${f(py)}` : `H${f(px)}V${f(py)}`;
                prevIO = sample.io;
            }
            svg += `<path d="${ioPath}" stroke="${color}" opacity=".6" stroke-dasharray="2 4" fill="none"/>`;
            let command = '', level = run.initialLevel;
            for (const phase of run.phases) {
                if (phase.level == null) continue;
                const px = x(phase.ackAt - offset);
                if (level == null) command += `M${f(px)} ${f(y(phase.level))}`;
                else command += `${command ? 'H' : 'M'}${f(px)}${command ? '' : ' ' + f(y(level))}V${f(y(phase.level))}`;
                level = phase.level;
                svg += `<rect x="${f(x(phase.sentAt - offset))}" y="${top}" width="${f(Math.max(.6, x(phase.ackAt - phase.sentAt) - left))}" height="${height}" fill="#ff7786" opacity=".07"/>`;
            }
            if (command) {
                command += `H${f(x(run.finishedAt - offset))}`;
                svg += `<path d="${command}" stroke="#ff7786" stroke-width="1" ${run.method === 'pull' ? 'stroke-dasharray="5 4"' : ''} opacity=".8" fill="none"/>`;
            }
        }
        return svg + '</svg>';
    }
    function scopeStats(result) {
        return (result?.runs || []).map(run => {
            const gaps = run.samples.slice(1).map((s, i) => s.t - run.samples[i].t).filter(n => n > 0);
            const min = gaps.length ? Math.min(...gaps).toFixed(2) : '—';
            const max = gaps.length ? Math.max(...gaps).toFixed(2) : '—';
            return `${run.method === 'pull' ? 'Pull' : run.method === 'drive' ? 'OUT' : 'IN'}: ${run.samples.length} Punkte · Δt ${min}–${max} ms`;
        }).join(' / ');
    }
    function scopeLegend(result) {
        const digital = result.measurement === 'digital';
        const items = (result.runs || []).map(run => `<span><i style="--trace:${run.method === 'pull' ? '#68e8a5' : '#67c9ff'}"></i>${run.method === 'pull' ? 'Pull' : run.method === 'drive' ? 'OUT' : 'IN'} · ${digital ? 'GPIO-Istwert' : 'ADC'}</span>`);
        if (!digital) items.push('<span><i class="dotted" style="--trace:#95bcae"></i>GPIO-Istwert</span>');
        if (result.method !== 'observe') items.push('<span><i style="--trace:#ff7786"></i>Sollwert · Pull gestrichelt</span>');
        return `<div class="scope-legend">${items.join('')}<span>${digital ? 'Nur 0/1 · kein ADC' : 'ADC raw 0–4095'}</span></div>`;
    }
    const api = { scopeSVG, scopeStats, scopeLegend };
    if (typeof module === 'object' && module.exports) module.exports = api;
    else Object.assign(root.ESPIO ||= {}, api);
})(globalThis);
