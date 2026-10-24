(function (root) {
    'use strict';
    const columns = (left, right, xLeft, xRight, y, step) => [
        ...left.map((label, index) => ({ label: String(label), gpio: typeof label === 'number' ? label : null, x: xLeft, y: y + index * step, side: 'left' })),
        ...right.map((label, index) => ({ label: String(label), gpio: typeof label === 'number' ? label : null, x: xRight, y: y + index * step, side: 'right' }))
    ];
    // ESPboards pinout diagrams are CC BY-NC 4.0; keep the attribution with each board.
    const importedSpecs = [
        {
            id: 's3-supermini', sourceId: 'esp32-s3-super-mini', chip: 'esp32s3', name: 'S3 SuperMini', subtitle: '35 GPIOs inkl. 20 Rückseitenpads · USB-C', file: 'esp32-s3-super-mini-pinout.png', height: 1087,
            front: { crop: { x: 690, y: 157, width: 220, height: 305 }, left: [43, 44, 1, 2, 3, 4, 5, 6, 7], right: ['5V', 'GND', '3V3', 13, 12, 11, 10, 9, 8], xLeft: 707, xRight: 891, y: 197, step: 30 },
            back: {
                crop: { x: 690, y: 620, width: 220, height: 300 }, pads: [
                    [38, 768, 713, 'left'], [37, 768, 734, 'left'],
                    ...[34, 33, 21, 18, 17, 16, 15, 14].map((gpio, index) => [gpio, 737, 713 + index * 21, 'left']),
                    [36, 768, 755, 'right'], [35, 768, 776, 'right'],
                    ...[48, 47, 46, 45, 42, 41, 40, 39].map((gpio, index) => [gpio, 863, 713 + index * 21, 'right'])
                ]
            },
            extra: [0, 19, 20], extraLabel: 'INTERN VERBUNDENE GPIOs',
            notes: { 0: 'BOOT-Taster, nicht an den Stiftleisten', 48: 'RGB-LED und Rückseitenpad', 19: 'Natives USB D−, nicht an den Stiftleisten', 20: 'Natives USB D+, nicht an den Stiftleisten' },
            description: 'ESP32-S3 Super Mini mit USB-C und 2 × 9 Seitenpads. Die Rückseite bietet 20 weitere GPIO-Lötpads; GPIO48 ist mit der RGB-LED verbunden. Pinbelegung und Bestückung am eigenen Board vergleichen.'
        },
        {
            id: 'xiao-esp32c5', chip: 'esp32c5', name: 'XIAO ESP32C5', subtitle: 'Seeed Studio · 13 GPIOs inkl. Rückseitenpads', file: 'xiao-esp32c5-pinout.png', height: 923,
            front: { crop: { x: 690, y: 155, width: 220, height: 275 }, left: [1, 0, 25, 7, 23, 24, 11], right: ['5V', 'GND', '3V3', 10, 9, 8, 12], xLeft: 710, xRight: 890, y: 215, step: 29.5 },
            back: { crop: { x: 690, y: 505, width: 220, height: 275 }, xLeft: 710, xRight: 890, y: 560, step: 30, pads: [[3, 815, 550, 'right'], [2, 815, 610, 'right']] },
            extra: [4, 5, 6, 26, 27, 28], extraLabel: 'INTERN VERBUNDENE GPIOs',
            notes: { 2: 'JTAG-Pad MTMS auf der Rueckseite', 3: 'JTAG-Pad MTDI auf der Rueckseite', 4: 'JTAG-Pad MTCK auf der Rueckseite', 5: 'JTAG-Pad MTDO auf der Rueckseite', 6: 'Batteriespannungsmessung (ADC_BAT)', 26: 'Batteriemessung aktivieren (ADC_CRL)', 27: 'Gelbe User-LED', 28: 'BOOT-Taster' },
            description: 'Kompaktes C5-Board mit Dualband-Wi-Fi 6, BLE, USB-C und LiPo-Lader. GPIO2/3 liegen zusätzlich auf der Rückseite; GPIO25 und GPIO7 haben Boot-Funktionen.'
        },
        {
            id: 'esp32-h2-super-mini', chip: 'esp32h2', name: 'ESP32-H2 Super Mini', subtitle: 'Generic · 19 GPIOs · Vorder- und Rückseite', file: 'esp32h2-super-mini-pinout.png', height: 1047,
            front: { crop: { x: 680, y: 165, width: 240, height: 325 }, left: [24, 23, 0, 1, 2, 3, 4, 5, 8], right: ['5V', 'GND', '3V3', 14, 13, 12, 11, 10, 9], xLeft: 698, xRight: 900, y: 203, step: 32.5 },
            back: { crop: { x: 680, y: 575, width: 240, height: 325 }, xLeft: 698, xRight: 900, y: 610, step: 32.5, pads: [[22, 787, 830, 'left'], [25, 811, 830, 'right'], [26, 870, 840, 'right'], [27, 870, 870, 'right']] },
            description: 'Kompaktes H2-Board für BLE und Thread/Zigbee. Vier innere GPIO-Pads liegen auf der Rückseite; GPIO8 und GPIO13 sind mit LEDs verbunden, GPIO9 mit BOOT.'
        },
        {
            id: 'esp32-h2-devkitm-1', chip: 'esp32h2', name: 'ESP32-H2-DevKitM-1', subtitle: 'Espressif · 19 GPIOs · 2 × 15 Pins', file: 'esp32-h2-devkitm-1-pinout.png', height: 1021,
            front: { crop: { x: 640, y: 225, width: 315, height: 665 }, left: ['GND', 26, 27, 'GND', 9, 'GND', 22, 8, 12, 25, 11, 10, 23, 24, 'GND'], right: ['GND', '5V', 'GND', 'VBAT', 'NC', 5, 4, 14, 13, 3, 2, 1, 0, 'RST', '3V3'], xLeft: 660, xRight: 938, y: 368, step: 31 },
            notes: { 8: 'RGB-LED', 9: 'BOOT-Taster', 26: 'Natives USB D-', 27: 'Natives USB D+' },
            description: 'Offizielles H2-Entwicklungsboard mit 2,54-mm-Stiftleisten, nativem USB Serial/JTAG und RGB-LED. GPIO26/27 sind die nativen USB-Leitungen.'
        },
        {
            id: 'xiao-esp32c6', chip: 'esp32c6', name: 'XIAO ESP32C6', subtitle: 'Seeed Studio · 13 GPIOs inkl. Rückseitenpads', file: 'xiao-esp32c6-pinout.png', height: 909,
            front: { crop: { x: 690, y: 155, width: 220, height: 270 }, left: [0, 1, 2, 21, 22, 23, 16], right: ['5V', 'GND', '3V3', 18, 20, 19, 17], xLeft: 710, xRight: 890, y: 210, step: 29.5 },
            back: { crop: { x: 690, y: 495, width: 220, height: 270 }, xLeft: 710, xRight: 890, y: 550, step: 30, pads: [[7, 785, 535, 'left'], [5, 815, 535, 'right'], [6, 785, 595, 'left'], [4, 815, 595, 'right']] },
            extra: [3, 9, 14, 15], extraLabel: 'INTERN VERBUNDENE GPIOs',
            notes: { 3: 'RF-Switch-Steuerung einschalten (LOW)', 4: 'Strapping-Pin: Pegel wird beim Reset ausgewertet. JTAG-Pad MTMS auf der Rueckseite; ADC1, Kanal 4.', 5: 'Strapping-Pin: Pegel wird beim Reset ausgewertet. JTAG-Pad MTDI auf der Rueckseite; ADC1, Kanal 5.', 6: 'JTAG-Pad MTCK auf der Rueckseite; ADC1, Kanal 6.', 7: 'JTAG-Pad MTDO auf der Rueckseite', 9: 'BOOT-Taster', 14: 'RF-Switch: LOW Keramikantenne, HIGH U.FL-Antenne', 15: 'User-LED' },
            description: 'Kleines C6-Board mit Wi-Fi 6, BLE, Thread/Zigbee, USB-C und LiPo-Lader. GPIO6/7 sind zusätzlich über Rückseitenpads zugänglich.'
        },
        {
            id: 'esp32-c6-devkitm-1', chip: 'esp32c6', name: 'ESP32-C6-DevKitM-1', subtitle: 'Espressif · 22 GPIOs · 2 × 15 Pins', file: 'esp32-c6-devkitm-1-pinout.png', height: 960,
            front: { crop: { x: 655, y: 220, width: 290, height: 610 }, left: ['GND', 12, 13, 'GND', 9, 15, 18, 19, 20, 21, 22, 23, 17, 16, 'GND'], right: ['GND', '5V', 'GND', 14, 7, 6, 8, 1, 0, 5, 4, 3, 2, 'EN', '3V3'], xLeft: 672, xRight: 928, y: 352, step: 28.2 },
            notes: { 8: 'RGB-LED', 9: 'BOOT-Taster', 12: 'Natives USB D-', 13: 'Natives USB D+' },
            description: 'Offizielles C6-Board mit Wi-Fi 6, BLE und Thread/Zigbee. GPIO8 steuert die RGB-LED, GPIO9 den BOOT-Taster; GPIO12/13 tragen natives USB.'
        },
        {
            id: 'esp32-c6-touch-lcd-1-47', chip: 'esp32c6', name: 'ESP32-C6-Touch-LCD-1.47', subtitle: 'Waveshare · 15 Header-GPIOs · LCD, Touch, IMU, TF',
            file: 'esp32-c6-touch-lcd-1-47.webp', width: 960, height: 1067,
            front: {
                crop: { x: 340, y: 58, width: 270, height: 510 },
                left: ['VBUS', 'GND', 16, 17, 'RST', 1, 2, 3, 4, 5, 6],
                right: ['VBAT', 'GND', 'GND', '3V3', 19, 18, 13, 12, 9, 8, 7],
                xLeft: 374, xRight: 572, y: 205, step: 28.5
            },
            extra: [0, 14, 15, 20, 21, 22, 23],
            extraLabel: 'INTERN BELEGTE GPIOs',
            notes: {
                0: 'BAT_ADC: Batteriespannung über 200-kΩ/100-kΩ-Teiler (VBAT = ADC-Spannung × 3); nicht am Header.',
                1: 'LCD SPI SCK und TF-Karte SPI SCK: gemeinsamer Takt.',
                2: 'LCD SPI MOSI (LCD_SDA) und TF-Karte SPI MOSI (CMD): gemeinsame Datenleitung.',
                3: 'TF-Karte SPI MISO (D0).', 4: 'TF-Karte SPI CS (D3).',
                5: 'QMI8658A IMU INT1.', 6: 'QMI8658A IMU INT2.',
                8: 'BOOT-Taster und Boot-Strapping-Pin.',
                12: 'Natives USB D− (USB_N); bei USB-Nutzung belegt.',
                13: 'Natives USB D+ (USB_P); bei USB-Nutzung belegt.',
                14: 'LCD SPI Chip Select',
                15: 'LCD Data/Command',
                16: 'UART0 TX (ESP_TXD).', 17: 'UART0 RX (ESP_RXD).',
                18: 'I²C SDA für Touch-Controller AXS5106L und IMU QMI8658A.',
                19: 'I²C SCL für Touch-Controller AXS5106L und IMU QMI8658A.',
                20: 'Touch-Controller AXS5106L Reset',
                21: 'Touch-Controller AXS5106L Interrupt',
                22: 'LCD Reset; intern verbunden, nicht am Header.',
                23: 'LCD-Hintergrundbeleuchtung (LCD_BL/LEDK)'
            },
            source: 'https://docs.waveshare.com/ESP32-C6-Touch-LCD-1.47',
            attribution: 'Pinout-Abbildung und Pinbelegung: Waveshare',
            description: 'ESP32-C6FH8 mit 1,47-Zoll-JD9853-Touch-LCD, AXS5106L-Touch, QMI8658A-IMU, TF-Kartenslot und LiPo-Ladeschaltung. LCD und TF teilen GPIO1/2 (SPI); Touch und IMU teilen GPIO18/19 (I²C). Intern belegt und nicht am Header: GPIO0 (Batterie-ADC), 14/15/22/23 (LCD), 20/21 (Touch). GPIO5/6 führen IMU-Interrupts; GPIO8 ist BOOT, GPIO12/13 sind natives USB. VBAT ist der Batterieanschluss, kein 3,3-V-Eingang.'
        },
        {
            id: 'esp32-c6-super-mini', chip: 'esp32c6', name: 'ESP32-C6 Super Mini', subtitle: 'Generic · 22 GPIOs inkl. Rückseitenpads', file: 'esp32-c6-super-mini-pinout.png', height: 1005,
            front: { crop: { x: 690, y: 170, width: 220, height: 305 }, left: [16, 17, 0, 1, 2, 3, 4, 5, 6, 7], right: ['5V', 'GND', '3V3', 20, 19, 18, 15, 14, 9, 8], xLeft: 710, xRight: 890, y: 187, step: 29.5 },
            back: { crop: { x: 690, y: 555, width: 220, height: 305 }, pads: [[21, 768, 778, 'left'], [22, 778, 801, 'left'], [23, 858, 789, 'right'], [12, 739, 812, 'left'], [13, 739, 840, 'left']] },
            notes: { 8: 'RGB-LED', 9: 'BOOT-Taster', 12: 'Natives USB D-', 13: 'Natives USB D+', 15: 'Onboard-LED', 21: 'Zusatzpad', 22: 'Zusatzpad', 23: 'Zusatzpad' },
            description: 'Kompaktes C6-Board mit Wi-Fi 6, BLE und Thread/Zigbee. Fünf weitere GPIO-Pads liegen auf der Rückseite; GPIO8 und GPIO15 sind mit LEDs verbunden.'
        },
        {
            id: 'esp32-c6-zero-mini', chip: 'esp32c6', name: 'ESP32-C6 Zero Mini', subtitle: 'Waveshare · 22 GPIOs inkl. Rückseitenpads', file: 'esp32-c6-zero-mini-pinout.png', height: 971,
            front: { crop: { x: 690, y: 175, width: 220, height: 310 }, left: ['5V', 'GND', '3V3', 0, 1, 2, 3, 4, 5], right: [16, 17, 14, 15, 18, 19, 20, 21, 22], xLeft: 710, xRight: 890, y: 195, step: 30 },
            back: { crop: { x: 690, y: 545, width: 220, height: 300 }, xLeft: 710, xRight: 890, y: 567, step: 29.5, mirror: false, pads: [[13, 740, 642, 'left'], [12, 740, 663, 'left'], [23, 740, 683, 'left'], [9, 740, 703, 'left'], [8, 740, 723, 'left'], [7, 740, 743, 'left'], [6, 740, 763, 'left']] },
            notes: { 8: 'RGB-LED', 9: 'BOOT-Taster', 12: 'Natives USB D-', 13: 'Natives USB D+' },
            description: 'Kompaktes Waveshare-C6-Board mit sieben zusätzlichen GPIO-Pads auf der Rückseite. GPIO8 ist mit der RGB-LED und GPIO9 mit BOOT verbunden.'
        },
        {
            id: 'xiao-esp32c3', chip: 'esp32c3', name: 'XIAO ESP32C3', subtitle: 'Seeed Studio · 11 GPIOs · 2 × 7 Pins', file: 'esp32c3-pinout.png', height: 841,
            front: { crop: { x: 695, y: 130, width: 210, height: 260 }, left: [2, 3, 4, 5, 6, 7, 21], right: ['5V', 'GND', '3V3', 10, 9, 8, 20], xLeft: 718, xRight: 885, y: 185, step: 28 },
            back: {
                crop: { x: 695, y: 450, width: 210, height: 245 }, xLeft: 718, xRight: 885, y: 486, step: 28,
                pads: [[7, 783, 485, 'left'], [6, 783, 541, 'left'], [5, 818, 485, 'right'], [4, 818, 541, 'right']]
            },
            notes: { 18: 'Natives USB D-', 19: 'Natives USB D+' },
            description: 'Kleines C3-Board mit USB-C und LiPo-Lader. Die rückseitigen GPIO-Kontakte sind bereits an den Stiftleisten auf der Vorderseite zugänglich.'
        },
        {
            id: 'esp32-c3-devkitm-1', chip: 'esp32c3', name: 'ESP32-C3-DevKitM-1', subtitle: 'Espressif · 15 GPIOs · 2 × 15 Pins', file: 'esp32-c3-devkitm-1-pinout.png', height: 804,
            front: { crop: { x: 665, y: 205, width: 270, height: 445 }, left: ['GND', 19, 18, 'GND', 4, 5, 6, 7, 'GND', 8, 9, 'GND', 20, 21, 'GND'], right: ['GND', '5V', '5V', 'GND', 10, 1, 0, 'GND', 'RST', 'GND', 3, 2, '3V3', '3V3', 'GND'], xLeft: 682, xRight: 918, y: 232, step: 26.5 },
            notes: { 8: 'RGB-LED', 9: 'BOOT-Taster', 18: 'Natives USB D-', 19: 'Natives USB D+' },
            description: 'Offizielles C3-Entwicklungsboard mit USB-UART-Brücke und Micro-USB. GPIO9 ist BOOT, GPIO8 treibt die RGB-LED; GPIO18/19 dienen nativem USB Serial/JTAG.'
        },
        {
            id: 'heltec-wifi-kit-32-v3', chip: 'esp32s3', name: 'Heltec WiFi Kit 32 (V3)', subtitle: 'Heltec · 28 Header-GPIOs · OLED · USB-C', file: 'heltec-wifi-kit-32-v3-pinout.png', height: 811,
            front: { crop: { x: 666, y: 148, width: 268, height: 500 }, left: ['GND', '5V', 'Ve', 'Ve', 44, 43, 'RST', 0, 21, 20, 19, 7, 6, 5, 4, 3, 2, 1], right: ['GND', '3V3', '3V3', 26, 48, 47, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 45, 46], xLeft: 683, xRight: 916, y: 182, step: 26 },
            notes: { 0: 'PRG/USER-Taster; Strapping-Pin', 1: 'Batteriespannungsmessung über Teiler, geschaltet mit GPIO37', 21: 'OLED-Reset', 35: 'Weiße Onboard-LED', 36: 'Vext und OLED-Versorgung: LOW schaltet ein', 37: 'Batteriespannungsteiler einschalten', 43: 'UART0 TX zur CP2102-Brücke', 44: 'UART0 RX zur CP2102-Brücke' },
            description: 'ESP32-S3-Board mit 0,96-Zoll-OLED, LiPo-Anschluss und CP2102-USB-UART. GPIO21 steuert OLED-Reset, GPIO36 die Vext-/OLED-Versorgung und GPIO37 die Batteriemessung; diese Leitungen sind auf dem Board belegt.'
        },
        {
            id: 'heltec-wifi-lora-32-v2', chip: 'esp32', name: 'Heltec WiFi LoRa 32 (V2)', subtitle: 'Heltec · 28 Header-GPIOs · OLED + LoRa', file: 'heltec-wifi-lora-32-v2-pinout.png', height: 706,
            front: { crop: { x: 685, y: 123, width: 230, height: 445 }, left: ['GND', '5V', 'Vext', 'Vext', 3, 1, 'RST', 0, 22, 19, 23, 18, 5, 15, 2, 4, 17, 16], right: ['GND', '3V3', '3V3', 36, 37, 38, 39, 34, 35, 32, 33, 25, 26, 27, 14, 12, 13, 21], xLeft: 700, xRight: 900, y: 155, step: 22.1 },
            notes: { 0: 'PRG-Taster und Strapping-Pin', 4: 'OLED SDA', 5: 'LoRa SCK; Boot-Pegel beachten', 14: 'LoRa Reset', 15: 'OLED SCL; Boot-Pegel beachten', 16: 'OLED Reset', 18: 'LoRa Chip Select', 19: 'LoRa MISO', 21: 'Vext einschalten: LOW', 25: 'Onboard-LED', 26: 'LoRa DIO0', 27: 'LoRa MOSI', 34: 'LoRa DIO2; nur Eingang', 35: 'LoRa DIO1; nur Eingang', 36: 'Nur Eingang', 37: 'Nur Eingang', 38: 'Nur Eingang', 39: 'Nur Eingang' },
            description: 'ESP32-Board mit 0,96-Zoll-OLED und LoRa-Funkmodul. Mehrere Header-GPIOs sind bereits mit OLED und LoRa verbunden; GPIO34–39 sind nur als Eingänge nutzbar. Vext wird über GPIO21 geschaltet.'
        },
        {
            id: 'lilygo-t-display-s3', chip: 'esp32s3', name: 'LilyGo T-Display-S3', subtitle: 'LilyGo · 13 Header-GPIOs · 1,9-Zoll-LCD', file: 'lilygo-t-display-s3-pinout.png', width: 1083, height: 1098,
            front: { crop: { x: 418, y: 195, width: 252, height: 590 }, left: ['3V3', 1, 2, 3, 10, 11, 12, 13, 'NC', 'NC', 'GND', '5V'], right: ['GND', 'GND', 43, 44, 18, 17, 21, 16, 'NC', 'GND', 'GND', '3V3'], xLeft: 433, xRight: 651, y: 282, step: 24.5 },
            extra: [0, 4, 5, 6, 7, 8, 9, 14, 15, 38, 39, 40, 41, 42, 45, 46, 47, 48], extraLabel: 'INTERN VERBUNDENE GPIOs',
            notes: { 0: 'BOOT-Taster; Strapping-Pin', 4: 'Batteriespannungsmessung (ADC)', 5: 'LCD-Reset', 6: 'LCD-Chip-Select', 7: 'LCD Data/Command', 8: 'LCD Write', 9: 'LCD Read', 14: 'User-Taster', 15: 'LCD-/Peripherie-Stromversorgung einschalten (HIGH)', 38: 'LCD-Hintergrundbeleuchtung', 39: 'LCD-Datenleitung D0', 40: 'LCD-Datenleitung D1', 41: 'LCD-Datenleitung D2', 42: 'LCD-Datenleitung D3', 45: 'LCD-Datenleitung D4', 46: 'LCD-Datenleitung D5', 47: 'LCD-Datenleitung D6', 48: 'LCD-Datenleitung D7', 3: 'Strapping-Pin', 10: 'SPI Chip Select', 11: 'SPI MOSI', 12: 'SPI Clock', 13: 'SPI MISO', 17: 'I²C SCL; beim Touch-Modell mit Touch-Controller verbunden', 18: 'I²C SDA; beim Touch-Modell mit Touch-Controller verbunden', 21: 'Beim Touch-Modell Touch-Reset', 16: 'Beim Touch-Modell Touch-Interrupt', 43: 'UART0 TX', 44: 'UART0 RX' },
            attribution: 'Pinout-Abbildung: LilyGo, bereitgestellt von ESPboards',
            description: 'ESP32-S3 mit 1,9-Zoll-ST7789V-LCD und zwei Tastern. Das Pinout-Bild zeigt die zugänglichen Header auf der bestückten Rückseite; zahlreiche weitere GPIOs sind intern mit LCD und Tastern verbunden.'
        }
    ];
    const importedBoards = importedSpecs.map(({ file, width = 1600, height, front, back, sourceId, ...spec }) => {
        const image = `assets/${file}`;
        const pins = columns(front.left, front.right, front.xLeft, front.xRight, front.y, front.step);
        const frontGpios = new Set(pins.map(pin => pin.gpio).filter(gpio => gpio !== null));
        const backPins = (back?.pads || []).filter(([gpio]) => !frontGpios.has(gpio))
            .map(([gpio, x, y, side]) => ({ gpio, label: String(gpio), x, y, side }));
        const backView = backPins.length ? {
            image, imageSize: { width, height }, crop: back.crop, maskBackground: true,
            pins: backPins
        } : null;
        return {
            ...spec, image, diagram: image, imageSize: { width, height }, crop: front.crop, maskBackground: true, pins, back: backView,
            source: `https://www.espboards.dev/esp32/${sourceId || spec.id}/`,
            attribution: spec.attribution || 'Pinout-Diagramm: ESPboards · CC BY-NC 4.0'
        };
    });
    // Photo crops are rendered using SVG viewBox, without changing the images.
    // Coordinates use the original source pixels. Power pads remain visible but
    // are never treated as GPIOs. Raw-chip view uses logical GPIO numbers.
    const boards = [
        {
            id: 'lolin-nodemcu-v3', chip: 'esp8266', name: 'LoLin NodeMCU V3', subtitle: 'ESP8266 · 30 Pins · GPIO-Register lesen',
            image: 'assets/lolin-nodemcu-v3.jpg',
            imageSize: { width: 900, height: 1742 }, crop: { x: 60, y: 85, width: 665, height: 1580 },
            pins: [
                ...[['A0', null], ['GND', null], ['VU', null], ['S3', 10], ['S2', 9], ['S1', 8], ['SC', 11], ['S0', 7], ['SK', 6], ['GND', null], ['3V3', null], ['EN', null], ['RST', null], ['GND', null], ['VIN', null]]
                    .map(([label, gpio], index) => ({ label, gpio, x: 90, y: 465 + index * 57.5, side: 'left' })),
                ...[['D0', 16], ['D1', 5], ['D2', 4], ['D3', 0], ['D4', 2], ['3V3', null], ['GND', null], ['D5', 14], ['D6', 12], ['D7', 13], ['D8', 15], ['RX', 3], ['TX', 1], ['GND', null], ['3V3', null]]
                    .map(([label, gpio], index) => ({ label, gpio, x: 670, y: 390 + index * 67.5, side: 'right' }))
            ],
            notes: {
                0: 'D3 / FLASH-Taster; Boot-Strapping, beim Start HIGH.', 1: 'TX / UART0 TX zur CH340-USB-Seriell-Brücke.',
                2: 'D4; Boot-Strapping, beim Start HIGH; blaue Onboard-LED (aktiv LOW).', 3: 'RX / UART0 RX zur CH340-USB-Seriell-Brücke.',
                4: 'D2 / I²C SDA.', 5: 'D1 / I²C SCL.', 6: 'SK / SPI-Flash-Takt; nicht frei nutzbar.',
                7: 'S0 / SPI-Flash-Daten; nicht frei nutzbar.', 8: 'S1 / SPI-Flash-Daten; nicht frei nutzbar.',
                9: 'S2 / SPI-Flash-Daten; nicht frei nutzbar.', 10: 'S3 / SPI-Flash-Daten; nicht frei nutzbar.',
                11: 'SC / SPI-Flash-Chip-Select; nicht frei nutzbar.', 12: 'D6 / HSPI MISO.',
                13: 'D7 / HSPI MOSI.', 14: 'D5 / HSPI SCLK.', 15: 'D8 / HSPI CS; Boot-Strapping, beim Start LOW.',
                16: 'D0 / RTC-GPIO16; eigener Eingangsregisterpfad (RTC_GPIO_IN_DATA), Wake-Funktion.'
            },
            source: 'https://commons.wikimedia.org/wiki/File:NodeMCU_Lua_Lol1n_V3.jpg',
            attribution: 'Boardfoto: Popolon / Wikimedia Commons · CC BY-SA 4.0; um 90° gedreht und verkleinert',
            description: 'LoLin NodeMCU V3 mit ESP-12E, CH340-USB-UART und Micro-USB. D0–D8 entsprechen GPIO16, 5, 4, 0, 2, 14, 12, 13, 15; RX/TX sind GPIO3/1. SK und S0–S3/SC sind mit dem SPI-Flash verbunden. A0 ist ein analoger Eingang und gehört nicht zum digitalen GPIO-Register. Live-Zugriff liest nur GPIO-Eingangsregister; Pin-Konfiguration und Ausgänge bleiben deaktiviert.'
        },
        {
            id: 'c3-supermini', chip: 'esp32c3', name: 'C3 SuperMini', subtitle: '13 GPIOs · USB-C · 2 × 8 Pins',
            image: 'assets/c3-pinout.webp', imageSize: { width: 1600, height: 1100 }, crop: { x: 540, y: 95, width: 510, height: 685 },
            pins: columns([5, 6, 7, 8, 9, 10, 20, 21], ['5V', 'GND', '3V3', 4, 3, 2, 1, 0], 595, 1008, 197, 68.5),
            extra: [18, 19], extraLabel: 'INTERN VERBUNDENE GPIOs',
            notes: { 18: 'Natives USB D-', 19: 'Natives USB D+', 8: 'Onboard-LED (häufig aktiv Low)', 9: 'BOOT-Taster' },
            source: 'https://arduino-projekte.info/products/esp32-c3-supermini-kompaktes-wi-fi-ble-development-board-mit-risc-v-power',
            attribution: 'Boardabbildung: arduino-projekte.info',
            description: 'SuperMini-Standardlayout, USB-C oben. Varianten vor dem Verdrahten mit dem eigenen Board vergleichen.'
        },
        {
            id: 'c6-supermini', chip: 'esp32c6', name: 'C6 SuperMini', subtitle: '22 GPIOs inkl. Zusatzpads · USB-C',
            image: 'assets/c6-pinout.webp', imageSize: { width: 2000, height: 1579 }, crop: { x: 710, y: 205, width: 570, height: 855 },
            pins: columns([16, 17, 0, 1, 2, 3, 4, 5, 6, 7], ['5V', 'GND', '3V3', 20, 19, 18, 15, 14, 9, 8], 765, 1222, 321, 75.4),
            extra: [21, 22, 23, 12, 13],
            notes: { 8: 'RGB-LED', 9: 'BOOT-Taster', 12: 'Natives USB D-', 13: 'Natives USB D+', 15: 'Onboard-LED', 21: 'Zusatzpad', 22: 'Zusatzpad', 23: 'Zusatzpad' },
            source: 'https://arduino-projekte.info/products/esp32-c6-super-mini-kompaktes-wi-fi-6-ble-5-zigbee-dev-board-mit-risc-v-power',
            attribution: 'Boardabbildung: arduino-projekte.info',
            description: 'Violettes SuperMini-Layout, USB-C oben. Zusatzpads sind unter dem Foto schematisch dargestellt; Positionen auf der Unterseite prüfen.'
        },
        {
            id: 'toniebox-esp32', chip: 'esp32s3', name: 'Toniebox ESP32', subtitle: 'Toniebox V1/V2 - ESP32-S3 - Debug- und Peripherie-Pins',
            image: 'assets/toniebox-pcb.jpg', imageSize: { width: 800, height: 600 }, crop: { x: 130, y: 65, width: 550, height: 470 }, maskBackground: true, maskBackgroundTolerance: 3,
            pins: columns([...Array(22).keys()], [...Array(23)].map((_, index) => index + 26), 130, 680, 90, 40),
            notes: {
                0: 'BOOT; Jumper J100',
                1: 'TRF7962A SPI CS', 
                2: 'TRF7962A SPI MOSI', 
                3: 'TRF7962A SPI MISO', 
                4: 'TRF7962A SPI Clock',
                5: 'I2C SDA LIS3DH/DAC3100',
                6: 'I2C SCL LIS3DH/DAC3100',
                7: 'Wake input: Button/Charge status; HIGH = no button pressed / no charger. Also controls NFC enable and DAC reset',
                8: 'Charge status measurement via voltage divider (ADC)', 
                9: 'Battery voltage measurement via voltage divider (ADC)',
                10: 'DAC3100 DIN', 
                11: 'DAC3100 BCLK', 
                12: 'DAC3100 WCLK',
                13: 'TRF7962A IRQ', 
                14: 'LIS3DH IRQ',
                17: 'Blue LED', 
                18: 'Green LED', 
                19: 'Red LED',
                20: 'Big Ear, LOW = active', 
                21: 'Small Ear, LOW = active',
                26: 'DAC3100 Reset, HIGH = active',
                33: 'MicroSD: DAT2', 
                34: 'MicroSD: DAT3', 
                35: 'MicroSD: CLK', 
                36: 'MicroSD: DAT0', 
                37: 'MicroSD: DAT1',
                38: 'MicroSD: CMD; J102', 
                39: 'JTAG TCK; J102', 
                40: 'JTAG TDO; J102', 
                41: 'JTAG TDI; J102', 
                42: 'JTAG TMS; J102',
                43: 'UART TX; J103', 
                44: 'UART RX; J103',
                45: 'Supply LIS3DH/DAC/blue LED; HIGH = active',
                46: 'J101; GPIO at Debug/Test connector', 
                47: 'Supply SD-/NFC; LOW = active',
                48: 'DAC3100: GPIO1'
            },
            source: 'https://tonies-wiki.revvox.de/docs/wiki/esp32/pinout/',
            attribution: 'PCB-Foto: Gambrius Tech Blog; Pinbelegung: Toniebox Hacking Wiki',
            description: 'Toniebox V1/V2 Hauptplatine mit ESP32-S3. GPIO-Pinmarker stehen generisch links und rechts neben dem Platinenbild und markieren keine einzelnen PCB-Pads. Pin-Kommentare dokumentieren Debug-Anschluesse und die Verbindungen zu NFC, Audio, LEDs, Tastern, Batterie-/Ladeueberwachung und microSD. Boardrevisionen koennen abweichen.'
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
            notes: {
                8: 'WS2812 RGB-LED', 9: 'BOOT-Taster', 13: 'Blaue Onboard-LED; die Beschriftung „15“ neben der LED ist kein GPIO15-Pad.',
                22: 'Innere Bohrung', 25: 'Innere Bohrung / Strapping-Pin', 26: 'Innere Bohrung, auf manchen Boards fälschlich „28“ beschriftet; natives USB D−', 27: 'Innere Bohrung / natives USB D+',
                23: 'RX / UART0', 24: 'TX / UART0'
            },
            source: 'https://www.nznelectronics.co.nz/products/esp32-h2-supermini-dev-board',
            attribution: 'Boardabbildung und korrigierte Pinbelegung: NZN Electronics',
            description: 'H2 SuperMini mit Ladeelektronik, USB-C oben / 2 × 9 Seitenpads. Die vier inneren Bohrungen sind unter dem Foto schematisch dargestellt. Aufdruck „28“ = GPIO26; „15“ und „BAT“ neben LEDs sind keine zusätzlichen GPIO-Pads. Layout am eigenen Board vergleichen.'
        },
        {
            id: 'p4-eth', chip: 'esp32p4', name: 'ESP32-P4-ETH', subtitle: 'Waveshare · 40-Pin-Header · Ethernet',
            image: 'assets/p4-pinout.jpg', imageSize: { width: 960, height: 969 }, crop: { x: 239, y: 85, width: 223, height: 849 },
            pins: columns([54, 19, 'GND', 18, 17, 16, 15, 'GND', 14, 6, 5, 4, 'GND', 3, 2, 8, 7, 'GND', 24, 25],
                ['VBUS', 'VSYS', 'GND', 'EN', '3V3', 20, 21, 'GND', 22, 23, 'RUN', 26, 'GND', 27, 32, 33, 46, 'GND', 47, 48], 254, 446, 153, 27),
            notes: {
                7: 'I2C SDA zum Codec und Zubehoerbus', 8: 'I2C SCL zum Codec und Zubehoerbus',
                9: 'I2S Daten zum Lautsprecher-Codec', 10: 'I2S Word Select (LRCK)', 11: 'I2S Mikrofon-Daten', 12: 'I2S Bit Clock', 13: 'I2S Master Clock',
                28: 'Ethernet RMII RXDV', 29: 'Ethernet RMII RXD0', 30: 'Ethernet RMII RXD1', 31: 'Ethernet MDC', 34: 'Ethernet RMII TXD0', 35: 'Ethernet RMII TXD1',
                49: 'Ethernet RMII TX_EN', 50: 'Ethernet RMII REF_CLK', 51: 'Ethernet PHY Reset', 52: 'Ethernet MDIO', 53: 'Audioverstaerker Enable',
                39: 'SD Data 0 · LDO4-Domäne, separate Stromversorgung',
                40: 'SD Data 1 · LDO4-Domäne, separate Stromversorgung',
                41: 'SD Data 2 · LDO4-Domäne, separate Stromversorgung',
                42: 'SD Data 3 · LDO4-Domäne, separate Stromversorgung',
                43: 'SD CLK · LDO4-Domäne, separate Stromversorgung',
                44: 'SD CMD · LDO4-Domäne, separate Stromversorgung',
                45: 'SD /EN (aktiv LOW) · LDO4-Domäne, separate Stromversorgung',
                46: 'LDO4-Domäne, separate Stromversorgung',
                47: 'LDO4-Domäne, separate Stromversorgung',
                48: 'LDO4-Domäne, separate Stromversorgung'
            },
            extra: [9, 10, 11, 12, 13, 28, 29, 30, 31, 34, 35, 39, 40, 41, 42, 43, 44, 45, 49, 50, 51, 52, 53], extraLabel: 'INTERN VERBUNDENE GPIOs',
            i2c: { sda: 7, scl: 8 },
            sd: {
                pins: { d0: 39, d1: 40, d2: 41, d3: 42, clk: 43, cmd: 44 },
                note: 'Onboard-Slot: LDO4-Domäne separat mit 3,3 V versorgen und GPIO45 manuell als Output LOW setzen.',
                source: 'https://files.waveshare.com/wiki/ESP32-P4-ETH/ESP32-P4-ETH-datasheet.pdf'
            },
            source: 'https://docs.waveshare.com/ESP32-P4-ETH', attribution: 'Boardfoto und Pinbelegung: Waveshare',
            description: 'Waveshare ESP32-P4-ETH, USB-C oben / RJ45 unten. Onboard-Peripherie bleibt elektrisch an den jeweiligen Pins angeschlossen. GPIO39–48 liegen in der LDO4-Domäne und benötigen eine separate Stromversorgung; GPIO-Konfiguration allein versorgt sie nicht.'
        }
    ];
    for (const config of importedBoards) {
        const existingId = { 'esp32-h2-super-mini': 'h2-supermini', 'esp32-c6-super-mini': 'c6-supermini' }[config.id];
        const existing = boards.find(board => board.id === existingId);
        if (existing) {
            Object.assign(existing, config, { id: existingId, notes: { ...existing.notes, ...config.notes } });
            delete existing.extra;
        } else if (config.id === 's3-supermini') boards.splice(boards.findIndex(board => board.id === 'ai-s3'), 0, config);
        else boards.push(config);
    }
    const tonieboxIndex = boards.findIndex(board => board.id === 'toniebox-esp32');
    if (tonieboxIndex >= 0) boards.push(boards.splice(tonieboxIndex, 1)[0]);
    function raw(chip) {
        return {
            id: `raw-${chip.id}`, chip: chip.id, name: `${chip.name} · roher Chip`, subtitle: 'Alle logischen GPIOs',
            description: 'Logische GPIO-Ansicht, keine Gehäuse-Padnummern. Verfügbarkeit hängt von Package, Modul und Speicherbestückung ab. Speicher- und Transportpins bleiben reserviert.',
            source: chip.source, attribution: 'Registerprofil: Espressif ESP-IDF', notes: {},
            pins: chip.pins.map((pin, index) => ({
                gpio: pin.id, label: String(pin.id), side: index < Math.ceil(chip.pins.length / 2) ? 'left' : 'right',
                x: index < Math.ceil(chip.pins.length / 2) ? 0 : 100, y: index % Math.ceil(chip.pins.length / 2) * 12
            }))
        };
    }
    const api = { boards, raw };
    if (typeof module === 'object' && module.exports) module.exports = api;
    else (root.ESPIO ||= {}).boardConfigs = api;
})(globalThis);
