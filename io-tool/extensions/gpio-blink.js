// Minimal example extension: blinks one GPIO and shows its own UI block.
// Copy this file as a starting point for your own extension.
module.exports = {
    id: 'gpio-blink',
    name: 'GPIO Blink',
    version: '1.0',
    description: 'Lässt einen frei wählbaren Ausgang blinken.',
    // GPIOs the user must assign in the extension card before "Starten".
    gpios: [{ id: 'led', label: 'LED', mode: 'output', level: 0 }],
    async load(api) {
        const block = api.ui.block('GPIO Blink');
        let running = false;
        const period = block.field('Periode ms', { value: 500, type: 'number', width: '90px' });
        const toggle = block.button('Blinken starten', async () => {
            if (running) { running = false; return; }
            running = true; toggle.textContent = 'Blinken stoppen';
            let level = 0;
            try {
                // The loop must not hold api.run(), otherwise the rest of the lab stays blocked.
                while (running && !api.signal.aborted) {
                    level ^= 1;
                    await api.gpios.led.write(level);
                    block.setStatus(`IO${api.gpios.led.id} = ${level}`);
                    await api.sleep(Math.max(20, Number(period.value) || 500));
                }
            } finally { running = false; toggle.textContent = 'Blinken starten'; }
        }, { raw: true, primary: true });
        block.text('Der Ausgang wird beim Entladen automatisch wieder zum Eingang.');
    }
};
