# IO-Lab Extensions

Eine Extension ist eine JS-Datei, die `module.exports` setzt. Sie läuft mit vollem Zugriff auf die Seite – nur vertrauenswürdige Dateien laden (Beim Laden von Platte kommt eine Rückfrage).

```js
module.exports = {
    id: 'my-ext', name: 'Meine Extension', version: '1.0', description: '…',
    interfaces: [{ id: 'bus', kinds: ['i2c'], label: 'Bus', optional: false }],
    gpios: [{ id: 'led', label: 'LED', mode: 'output', pull: 'none', level: 0, optional: false, hint: '' }],
    async load(api) { /* UI und Logik aufbauen */ },
    unload(api) { /* optional, zusätzliche Aufräumarbeiten */ }
};
```

- `interfaces`: benötigte, im Lab vorkonfigurierte Schnittstellen (`i2c`, `spi`, `rmt`, `pwm`). Gibt es genau eine passende, wird sie automatisch gewählt, sonst wählt der Nutzer in der Extension-Karte.
- `gpios`: zusätzliche Pins, die der Nutzer in der Karte zuordnet. Belegte Pins werden nicht doppelt angeboten.
- Ohne Anforderungen startet die Extension sofort beim Laden.

## API (`api`)

| Eintrag | Bedeutung |
|---|---|
| `esp` | `chip`, `board`, `session`, `pins`, `capabilities`, `identity` |
| `gpios.<id>` | deklarierter Pin: `configure`, `write`, `read`, `release` |
| `gpio(pin)` | beliebigen freien Pin anfordern |
| `interfaces.<id>` | `{kind, host, label, config}` |
| `i2c`, `spi`, `rmt`, `pwm` | Host der gewählten Schnittstelle |
| `controller`, `registers` | Roh-Zugriff auf GPIO-Controller / Register |
| `signal` | AbortSignal, wird beim Stoppen ausgelöst |
| `run(task)` | Aufgabe seriell mit den Lab-Operationen ausführen |
| `sleep(ms)`, `util`, `log(msg)` | Hilfsfunktionen |
| `ui.block(title)` | eigener UI-Block |

Block-Helfer: `row()`, `text()`, `button(label, fn, {primary, raw})`, `field(label, {value, type, options, width})`, `output()`, `table(headers)`, `progress()`, `setStatus()`, `setTitle()`, `remove()`.

Beim Stoppen/Entladen werden Blöcke entfernt und belegte GPIOs wieder auf Eingang gestellt.

## Beispiele

`gpio-blink.js`, `i2c-analyzer.js` (Scan, Registermap), `lattice-machxo2.js` (MachXO2 per I²C, SRAM-Laden experimentell), `ws2812.js` (WS2812/SK6812 3ch/4ch über RMT). Beispiele werden per HTTP geladen (nicht über `file://`).
