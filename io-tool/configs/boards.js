(function (root) {
    'use strict';
    const columns = (left, right, xLeft, xRight, y, step) => [
        ...left.map((label, index) => ({ label: String(label), gpio: typeof label === 'number' ? label : null, x: xLeft, y: y + index * step, side: 'left' })),
        ...right.map((label, index) => ({ label: String(label), gpio: typeof label === 'number' ? label : null, x: xRight, y: y + index * step, side: 'right' }))
    ];
    // ESPboards pinout diagrams are CC BY-NC 4.0; keep the attribution with each board.
    const importedBoards = [
        ['xiao-esp32c5', 'esp32c5', 'XIAO ESP32C5', 'Seeed Studio · 11 GPIOs · 2 × 7 Pins', 'xiao-esp32c5-pinout.png', [1,0,25,7,23,24,11,10,9,8,12], 'Thumb-sized C5 board with dual-band Wi-Fi 6, BLE, native USB-C and LiPo charging. D2/GPIO25 and D3/GPIO7 have boot-time roles; other listed GPIOs are the safer starting points.'],
        ['esp32-h2-super-mini', 'esp32h2', 'ESP32-H2 Super Mini', 'Generic · 19 GPIOs · compact USB-C board', 'esp32h2-super-mini-pinout.png', [0,1,2,3,4,5,8,9,10,11,12,13,14,22,24,23,25,26,27], 'Compact H2 board for BLE and 802.15.4 Thread/Zigbee mesh projects. GPIO0–5, 8, 9 and 25 are strapping pins; GPIO13 and GPIO8 are shared with onboard LEDs.'],
        ['esp32-h2-devkitm-1', 'esp32h2', 'ESP32-H2-DevKitM-1', 'Espressif · 19 GPIOs · 2 × 15 pins', 'esp32-h2-devkitm-1-pinout.png', [0,1,2,3,13,14,4,5,24,23,10,11,25,12,8,22,9,27,26], 'Official Espressif H2 development board with accessible 2.54 mm headers, native USB Serial/JTAG and an onboard RGB LED. Check strapping pins and GPIO26/27 USB use before assigning them.'],
        ['xiao-esp32c6', 'esp32c6', 'XIAO ESP32C6', 'Seeed Studio · 11 GPIOs · 2 × 7 Pins', 'xiao-esp32c6-pinout.png', [0,1,2,21,22,23,16,18,20,19,17], 'Small C6 board with Wi-Fi 6, BLE 5.3, Thread/Zigbee, USB-C and LiPo charging. GPIO22/23 provide I²C, GPIO16/17 UART, and GPIO18–20 SPI; the diagram lists alternate SDIO functions.'],
        ['esp32-c6-devkitm-1', 'esp32c6', 'ESP32-C6-DevKitM-1', 'Espressif · 22 GPIOs · 2 × 15 pins', 'esp32-c6-devkitm-1-pinout.png', [2,3,4,5,0,1,8,6,7,14,16,17,23,22,21,20,19,18,15,9,13,12], 'Official C6 development board with 2.4 GHz Wi-Fi 6, BLE, Thread/Zigbee and native USB. GPIO8 drives the RGB LED, GPIO9 is BOOT, and GPIO12/13 carry native USB Serial/JTAG.'],
        ['esp32-c6-super-mini', 'esp32c6', 'ESP32-C6 Super Mini', 'Generic · 22 GPIOs · compact USB-C board', 'esp32-c6-super-mini-pinout.png', [16,17,0,1,2,3,4,5,6,7,8,9,12,13,14,15,18,19,20,21,22,23], 'Compact C6 board with Wi-Fi 6, BLE 5.3 and Thread/Zigbee. GPIO8 is shared with the RGB LED, GPIO15 with a status LED, and GPIO4–9 have boot-time strapping roles.'],
        ['esp32-c6-zero-mini', 'esp32c6', 'ESP32-C6 Zero Mini', 'Waveshare · 22 GPIOs · 25 pads', 'esp32-c6-zero-mini-pinout.png', [16,17,0,1,2,3,4,5,6,7,8,9,12,13,14,15,18,19,20,21,22,23], 'Waveshare C6 Zero board with USB-C and a compact 25-pad layout. GPIO8 is used by the onboard LED, GPIO9 by BOOT, and GPIO4–9 are strapping pins; compare the physical revision with the diagram.'],
        ['xiao-esp32c3', 'esp32c3', 'XIAO ESP32C3', 'Seeed Studio · 11 GPIOs · 2 × 7 Pins', 'esp32c3-pinout.png', [2,3,4,5,6,7,21,10,9,8,20], 'Tiny C3 board with USB-C, BLE 5, Wi-Fi and LiPo charging. GPIO2/4/5/6/7/8/9 have boot-time or peripheral roles; Seeed recommends D0–D2 for analog input.'],
        ['esp32-c3-devkitm-1', 'esp32c3', 'ESP32-C3-DevKitM-1', 'Espressif · 15 GPIOs · 2 × 15 pins', 'esp32-c3-devkitm-1-pinout.png', [2,3,0,1,10,21,20,9,8,7,6,5,4,18,19], 'Official C3 development board with USB-UART bridge, Micro-USB and native USB Serial/JTAG pins. GPIO9 is BOOT, GPIO8 drives the RGB LED, and GPIO4–7 are strapping/JTAG pins.']
    ].map(([id, chip, name, subtitle, diagram, gpios, description]) => ({
        id, chip, name, subtitle, diagram: `assets/${diagram}`,
        pins: gpios.map((gpio, index) => ({ gpio, label: String(gpio), side: index < Math.ceil(gpios.length / 2) ? 'left' : 'right', x: index < Math.ceil(gpios.length / 2) ? 0 : 100, y: index % Math.ceil(gpios.length / 2) * 12 })),
        source: `https://www.espboards.dev/esp32/${id}/`,
        attribution: 'Pinout-Diagramm: ESPboards · CC BY-NC 4.0', description
    }));
    // Photo crops are rendered using SVG viewBox, without changing the images.
    // Coordinates use the original source pixels. Power pads remain visible but
    // are never treated as GPIOs. Raw-chip view uses logical GPIO numbers.
    const boards = [
        {
            id: 'c3-supermini', chip: 'esp32c3', name: 'C3 SuperMini', subtitle: '13 GPIOs · USB-C · 2 × 8 Pins',
            image: 'assets/c3-pinout.webp', imageSize: { width: 1600, height: 1100 }, crop: { x: 540, y: 95, width: 510, height: 685 },
            pins: columns([5, 6, 7, 8, 9, 10, 20, 21], ['5V', 'GND', '3V3', 4, 3, 2, 1, 0], 595, 1008, 197, 68.5),
            notes: { 8: 'Onboard-LED (häufig aktiv Low)', 9: 'BOOT-Taster' },
            source: 'https://arduino-projekte.info/products/esp32-c3-supermini-kompaktes-wi-fi-ble-development-board-mit-risc-v-power',
            attribution: 'Boardabbildung: arduino-projekte.info',
            description: 'SuperMini-Standardlayout, USB-C oben. Varianten vor dem Verdrahten mit dem eigenen Board vergleichen.'
        },
        {
            id: 'c6-supermini', chip: 'esp32c6', name: 'C6 SuperMini', subtitle: '22 GPIOs inkl. Zusatzpads · USB-C',
            image: 'assets/c6-pinout.webp', imageSize: { width: 2000, height: 1579 }, crop: { x: 710, y: 205, width: 570, height: 855 },
            pins: columns([16, 17, 0, 1, 2, 3, 4, 5, 6, 7], ['5V', 'GND', '3V3', 20, 19, 18, 15, 14, 9, 8], 765, 1222, 321, 75.4),
            extra: [21, 22, 23, 12, 13],
            notes: { 8: 'RGB-LED', 9: 'BOOT-Taster', 15: 'Onboard-LED', 21: 'Zusatzpad', 22: 'Zusatzpad', 23: 'Zusatzpad' },
            source: 'https://arduino-projekte.info/products/esp32-c6-super-mini-kompaktes-wi-fi-6-ble-5-zigbee-dev-board-mit-risc-v-power',
            attribution: 'Boardabbildung: arduino-projekte.info',
            description: 'Violettes SuperMini-Layout, USB-C oben. Zusatzpads sind unter dem Foto schematisch dargestellt; Positionen auf der Unterseite prüfen.'
        },
        {
            id: 's3-supermini', chip: 'esp32s3', name: 'S3 SuperMini', subtitle: '35 GPIOs inkl. Rückseitenpads · USB-C',
            image: 'assets/s3-supermini-pinout.png', imageSize: { width: 682, height: 690 }, crop: { x: 255, y: 17, width: 175, height: 224 },
            pins: columns([43, 44, 1, 2, 3, 4, 5, 6, 7], ['5V', 'GND', '3V3', 13, 12, 11, 10, 9, 8], 272, 414, 52, 21.5),
            extra: [38, 36, 37, 35, 34, 48, 33, 47, 21, 46, 18, 45, 17, 42, 16, 41, 15, 40, 14, 39],
            notes: { 0: 'BOOT-Taster (nicht an den Stiftleisten)', 48: 'RGB-LED / Rückseitenpad' },
            source: 'https://www.espboards.dev/esp32/esp32-s3-super-mini/',
            attribution: 'Pinout-Abbildung: espboards.dev',
            description: 'S3 SuperMini mit Ladeelektronik, 2 × 9 Pins, USB-C oben. Rückseitenpads sind separat schematisch dargestellt. Nicht mit dem S3 Zero verwechseln; Layout und Speicherbestückung am eigenen Board prüfen.'
        },
        {
            id: 'ai-s3', chip: 'esp32s3', name: 'AI-S3', subtitle: '36 GPIOs · 2 × 22 Pins · USB + UART',
            image: 'assets/ai-s3-pinout.jpg', imageSize: { width: 1584, height: 1080 }, crop: { x: 685, y: 95, width: 280, height: 685 },
            pins: columns(['3V3', '3V3', 'RST', 4, 5, 6, 7, 15, 16, 17, 18, 8, 3, 46, 9, 10, 11, 12, 13, 14, '5V', 'GND'],
                ['GND', 43, 44, 1, 2, 42, 41, 40, 39, 38, 37, 36, 35, 0, 45, 48, 47, 21, 20, 19, 'GND', 'GND'], 705, 945, 185, 26.67),
            notes: { 0: 'BOOT-Taster', 47: 'RGB-LED laut Pinout; Boardrevision prüfen', 19: 'Natives USB D−', 20: 'Natives USB D+', 43: 'UART0 TX / USB-UART-Brücke', 44: 'UART0 RX / USB-UART-Brücke' },
            source: 'https://github.com/Xylopyrographer/BitsNThings/tree/main/AI-S3%20ESP32-S3%20Dev%20Board',
            attribution: 'Pinout: VCC-GND Studio, AI-S3-Zuordnung: Xylopyrographer',
            description: 'AI-S3 mit YD-ESP32-S3-kompatibler Pinbelegung, Antenne oben / zwei USB-Buchsen unten. Onboard-Peripherie bleibt angeschlossen; Speicher- und Transportpins bleiben gesperrt.'
        },
        {
            id: 'h2-supermini', chip: 'esp32h2', name: 'H2 SuperMini', subtitle: '19 GPIOs inkl. Innenpads · USB-C',
            image: 'assets/h2-supermini-pinout.png', imageSize: { width: 1254, height: 1254 }, crop: { x: 490, y: 329, width: 292, height: 480 },
            pins: columns([24, 23, 0, 1, 2, 3, 4, 5, 8], ['5V', 'GND', '3V3', 14, 13, 12, 11, 10, 9], 507, 760, 395, 47.2),
            extra: [22, 25, 26, 27],
            notes: { 8: 'WS2812 RGB-LED', 9: 'BOOT-Taster', 13: 'Blaue Onboard-LED; die Beschriftung „15“ neben der LED ist kein GPIO15-Pad.',
                22: 'Innere Bohrung', 25: 'Innere Bohrung / Strapping-Pin', 26: 'Innere Bohrung, auf manchen Boards fälschlich „28“ beschriftet; natives USB D−', 27: 'Innere Bohrung / natives USB D+',
                23: 'RX / UART0', 24: 'TX / UART0' },
            source: 'https://www.nznelectronics.co.nz/products/esp32-h2-supermini-dev-board',
            attribution: 'Boardabbildung und korrigierte Pinbelegung: NZN Electronics',
            description: 'H2 SuperMini mit Ladeelektronik, USB-C oben / 2 × 9 Seitenpads. Die vier inneren Bohrungen sind unter dem Foto schematisch dargestellt. Aufdruck „28“ = GPIO26; „15“ und „BAT“ neben LEDs sind keine zusätzlichen GPIO-Pads. Layout am eigenen Board vergleichen.'
        },
        {
            id: 'p4-eth', chip: 'esp32p4', name: 'ESP32-P4-ETH', subtitle: 'Waveshare · 40-Pin-Header · Ethernet',
            image: 'assets/p4-pinout.jpg', imageSize: { width: 960, height: 969 }, crop: { x: 239, y: 85, width: 223, height: 849 },
            pins: columns([54, 19, 'GND', 18, 17, 16, 15, 'GND', 14, 6, 5, 4, 'GND', 3, 2, 8, 7, 'GND', 24, 25],
                ['VBUS', 'VSYS', 'GND', 'EN', '3V3', 20, 21, 'GND', 22, 23, 'RUN', 26, 'GND', 27, 32, 33, 46, 'GND', 47, 48], 254, 446, 153, 27),
            notes: { 7: 'I²C SDA', 8: 'I²C SCL',
                39: 'SD Data 0 · LDO4-Domäne, separate Stromversorgung',
                40: 'SD Data 1 · LDO4-Domäne, separate Stromversorgung',
                41: 'SD Data 2 · LDO4-Domäne, separate Stromversorgung',
                42: 'SD Data 3 · LDO4-Domäne, separate Stromversorgung',
                43: 'SD CLK · LDO4-Domäne, separate Stromversorgung',
                44: 'SD CMD · LDO4-Domäne, separate Stromversorgung',
                45: 'SD /EN (aktiv LOW) · LDO4-Domäne, separate Stromversorgung',
                46: 'LDO4-Domäne, separate Stromversorgung',
                47: 'LDO4-Domäne, separate Stromversorgung',
                48: 'LDO4-Domäne, separate Stromversorgung' },
            extra: [39, 40, 41, 42, 43, 44, 45],
            i2c: { sda: 7, scl: 8 },
            sd: { pins: { d0: 39, d1: 40, d2: 41, d3: 42, clk: 43, cmd: 44 },
                note: 'Onboard-Slot: LDO4-Domäne separat mit 3,3 V versorgen und GPIO45 manuell als Output LOW setzen.',
                source: 'https://files.waveshare.com/wiki/ESP32-P4-ETH/ESP32-P4-ETH-datasheet.pdf' },
            source: 'https://docs.waveshare.com/ESP32-P4-ETH', attribution: 'Boardfoto und Pinbelegung: Waveshare',
            description: 'Waveshare ESP32-P4-ETH, USB-C oben / RJ45 unten. Onboard-Peripherie bleibt elektrisch an den jeweiligen Pins angeschlossen. GPIO39–48 liegen in der LDO4-Domäne und benötigen eine separate Stromversorgung; GPIO-Konfiguration allein versorgt sie nicht.'
        }
    ];
    boards.push(...importedBoards);
    function raw(chip) {
        return { id: `raw-${chip.id}`, chip: chip.id, name: `${chip.name} · roher Chip`, subtitle: 'Alle logischen GPIOs',
            description: 'Logische GPIO-Ansicht, keine Gehäuse-Padnummern. Verfügbarkeit hängt von Package, Modul und Speicherbestückung ab. Speicher- und Transportpins bleiben reserviert.',
            source: chip.source, attribution: 'Registerprofil: Espressif ESP-IDF', notes: {},
            pins: chip.pins.map((pin, index) => ({ gpio: pin.id, label: String(pin.id), side: index < Math.ceil(chip.pins.length / 2) ? 'left' : 'right',
                x: index < Math.ceil(chip.pins.length / 2) ? 0 : 100, y: index % Math.ceil(chip.pins.length / 2) * 12 })) };
    }
    const api = { boards, raw };
    if (typeof module === 'object' && module.exports) module.exports = api;
    else (root.ESPIO ||= {}).boardConfigs = api;
})(globalThis);
