(function (root) {
    'use strict';
    const columns = (left, right, xLeft, xRight, y, step) => [
        ...left.map((label, index) => ({ label: String(label), gpio: typeof label === 'number' ? label : null, x: xLeft, y: y + index * step, side: 'left' })),
        ...right.map((label, index) => ({ label: String(label), gpio: typeof label === 'number' ? label : null, x: xRight, y: y + index * step, side: 'right' }))
    ];
    // ESPboards pinout diagrams are CC BY-NC 4.0; keep the attribution with each board.
    const importedSpecs = [
        {
            id: 's3-supermini', sourceId: 'esp32-s3-super-mini', chip: 'esp32s3', name: 'S3 SuperMini', subtitle: '35 GPIOs incl. 20 rear pads - USB-C', file: 'esp32-s3-super-mini-pinout.png', height: 1087,
            front: { crop: { x: 690, y: 157, width: 220, height: 305 }, left: [43, 44, 1, 2, 3, 4, 5, 6, 7], right: ['5V', 'GND', '3V3', 13, 12, 11, 10, 9, 8], xLeft: 707, xRight: 891, y: 197, step: 30 },
            back: {
                crop: { x: 690, y: 620, width: 220, height: 300 }, pads: [
                    [38, 768, 713, 'left'], [37, 768, 734, 'left'],
                    ...[34, 33, 21, 18, 17, 16, 15, 14].map((gpio, index) => [gpio, 737, 713 + index * 21, 'left']),
                    [36, 768, 755, 'right'], [35, 768, 776, 'right'],
                    ...[48, 47, 46, 45, 42, 41, 40, 39].map((gpio, index) => [gpio, 863, 713 + index * 21, 'right'])
                ]
            },
            extra: [0, 19, 20], extraLabel: 'INTERNALLY CONNECTED GPIOs',
            notes: {0: 'BOOT button; not on the headers', 19: 'Native USB D-; not on the headers', 20: 'Native USB D+; not on the headers', 48: 'RGB LED and rear pad'},
            description: 'ESP32-S3 Super Mini with USB-C and two rows of nine side pads. The back provides 20 additional GPIO solder pads; GPIO48 is connected to the RGB LED. Check the pinout and component population against your board revision.'
        },
        {
            id: 'xiao-esp32c5', chip: 'esp32c5', name: 'XIAO ESP32C5', subtitle: 'Seeed Studio - 13 GPIOs incl. rear pads', file: 'xiao-esp32c5-pinout.png', height: 923,
            front: { crop: { x: 690, y: 155, width: 220, height: 275 }, left: [1, 0, 25, 7, 23, 24, 11], right: ['5V', 'GND', '3V3', 10, 9, 8, 12], xLeft: 710, xRight: 890, y: 215, step: 29.5 },
            back: { crop: { x: 690, y: 505, width: 220, height: 275 }, xLeft: 710, xRight: 890, y: 560, step: 30, pads: [[3, 815, 550, 'right'], [2, 815, 610, 'right']] },
            extra: [4, 5, 6, 26, 27, 28], extraLabel: 'INTERNALLY CONNECTED GPIOs',
            notes: {2: 'JTAG MTMS pad on the back', 3: 'JTAG MTDI pad on the back', 4: 'JTAG MTCK pad on the back', 5: 'JTAG MTDO pad on the back', 6: 'Battery voltage measurement (ADC_BAT)', 26: 'Enable battery measurement (ADC_CRL)', 27: 'Yellow user LED', 28: 'BOOT button'},
            description: 'Compact C5 board with dual-band Wi-Fi 6, BLE, USB-C, and a LiPo charger. GPIO2/3 are also available on the back; GPIO25 and GPIO7 have boot-related functions.'
        },
        {
            id: 'esp32-h2-super-mini', chip: 'esp32h2', name: 'ESP32-H2 Super Mini', subtitle: 'Generic - 19 GPIOs - front and back', file: 'esp32h2-super-mini-pinout.png', height: 1047,
            front: { crop: { x: 680, y: 165, width: 240, height: 325 }, left: [24, 23, 0, 1, 2, 3, 4, 5, 8], right: ['5V', 'GND', '3V3', 14, 13, 12, 11, 10, 9], xLeft: 698, xRight: 900, y: 203, step: 32.5 },
            back: { crop: { x: 680, y: 575, width: 240, height: 325 }, xLeft: 698, xRight: 900, y: 610, step: 32.5, pads: [[22, 787, 830, 'left'], [25, 811, 830, 'right'], [26, 870, 840, 'right'], [27, 870, 870, 'right']] },
            description: 'Compact H2 board for BLE and Thread/Zigbee. Four inner GPIO pads are on the back; GPIO8 and GPIO13 are connected to LEDs, and GPIO9 is connected to BOOT.'
        },
        {
            id: 'esp32-h2-devkitm-1', chip: 'esp32h2', name: 'ESP32-H2-DevKitM-1', subtitle: 'Espressif - 19 GPIOs - 2 x 15 pins', file: 'esp32-h2-devkitm-1-pinout.png', height: 1021,
            front: { crop: { x: 640, y: 225, width: 315, height: 665 }, left: ['GND', 26, 27, 'GND', 9, 'GND', 22, 8, 12, 25, 11, 10, 23, 24, 'GND'], right: ['GND', '5V', 'GND', 'VBAT', 'NC', 5, 4, 14, 13, 3, 2, 1, 0, 'RST', '3V3'], xLeft: 660, xRight: 938, y: 368, step: 31 },
            notes: {8: 'RGB LED', 9: 'BOOT button', 26: 'Native USB D-', 27: 'Native USB D+'},
            description: 'Official H2 development board with 2.54 mm headers, native USB Serial/JTAG, and an RGB LED. GPIO26/27 are the native USB lines.'
        },
        {
            id: 'xiao-esp32c6', chip: 'esp32c6', name: 'XIAO ESP32C6', subtitle: 'Seeed Studio - 13 GPIOs incl. rear pads', file: 'xiao-esp32c6-pinout.png', height: 909,
            front: { crop: { x: 690, y: 155, width: 220, height: 270 }, left: [0, 1, 2, 21, 22, 23, 16], right: ['5V', 'GND', '3V3', 18, 20, 19, 17], xLeft: 710, xRight: 890, y: 210, step: 29.5 },
            back: { crop: { x: 690, y: 495, width: 220, height: 270 }, xLeft: 710, xRight: 890, y: 550, step: 30, pads: [[7, 785, 535, 'left'], [5, 815, 535, 'right'], [6, 785, 595, 'left'], [4, 815, 595, 'right']] },
            extra: [3, 9, 14, 15], extraLabel: 'INTERNALLY CONNECTED GPIOs',
            notes: {3: 'Enable RF switch control (LOW)', 4: 'Strapping pin: level is sampled at reset. JTAG MTMS pad on the back; ADC1 channel 4', 5: 'Strapping pin: level is sampled at reset. JTAG MTDI pad on the back; ADC1 channel 5', 6: 'JTAG MTCK pad on the back; ADC1 channel 6', 7: 'JTAG MTDO pad on the back', 9: 'BOOT button', 14: 'RF switch: LOW selects the ceramic antenna; HIGH selects the U.FL antenna', 15: 'User LED'},
            description: 'Compact C6 board with Wi-Fi 6, BLE, Thread/Zigbee, USB-C, and a LiPo charger. GPIO6/7 are also accessible through rear pads.'
        },
        {
            id: 'esp32-c6-devkitm-1', chip: 'esp32c6', name: 'ESP32-C6-DevKitM-1', subtitle: 'Espressif - 22 GPIOs - 2 x 15 pins', file: 'esp32-c6-devkitm-1-pinout.png', height: 960,
            front: { crop: { x: 655, y: 220, width: 290, height: 610 }, left: ['GND', 12, 13, 'GND', 9, 15, 18, 19, 20, 21, 22, 23, 17, 16, 'GND'], right: ['GND', '5V', 'GND', 14, 7, 6, 8, 1, 0, 5, 4, 3, 2, 'EN', '3V3'], xLeft: 672, xRight: 928, y: 352, step: 28.2 },
            notes: {8: 'RGB LED', 9: 'BOOT button', 12: 'Native USB D-', 13: 'Native USB D+'},
            description: 'Official C6 board with Wi-Fi 6, BLE, and Thread/Zigbee. GPIO8 drives the RGB LED, GPIO9 is connected to BOOT, and GPIO12/13 provide native USB.'
        },
        {
            id: 'esp32-c6-touch-lcd-1-47', chip: 'esp32c6', name: 'ESP32-C6-Touch-LCD-1.47', subtitle: 'Waveshare - 15 header GPIOs - LCD, touch, IMU, TF',
            file: 'esp32-c6-touch-lcd-1-47.webp', width: 960, height: 1067,
            front: {
                crop: { x: 340, y: 58, width: 270, height: 510 },
                left: ['VBUS', 'GND', 16, 17, 'RST', 1, 2, 3, 4, 5, 6],
                right: ['VBAT', 'GND', 'GND', '3V3', 19, 18, 13, 12, 9, 8, 7],
                xLeft: 374, xRight: 572, y: 205, step: 28.5
            },
            extra: [0, 14, 15, 20, 21, 22, 23],
            extraLabel: 'INTERNALLY USED GPIOs',
            notes: {0: 'BAT_ADC: battery voltage through a 200-kohm/100-kohm divider (VBAT = ADC voltage x 3); not on the headers', 1: 'LCD and TF card share the SPI clock (SCK)', 2: 'LCD SPI MOSI (LCD_SDA) and TF card SPI MOSI (CMD) share this data line', 3: 'TF card SPI MISO (D0)', 4: 'TF card SPI chip select (D3)', 5: 'QMI8658A IMU interrupt 1', 6: 'QMI8658A IMU interrupt 2', 8: 'BOOT button and boot strapping pin', 12: 'Native USB D- (USB_N); in use when USB is enabled', 13: 'Native USB D+ (USB_P); in use when USB is enabled', 14: 'LCD SPI chip select', 15: 'LCD data/command', 16: 'UART0 TX (ESP_TXD)', 17: 'UART0 RX (ESP_RXD)', 18: 'I2C SDA shared by the AXS5106L touch controller and QMI8658A IMU', 19: 'I2C SCL shared by the AXS5106L touch controller and QMI8658A IMU', 20: 'AXS5106L touch controller reset', 21: 'AXS5106L touch controller interrupt', 22: 'LCD reset; connected internally, not on the headers', 23: 'LCD backlight (LCD_BL/LEDK)'},
            source: 'https://docs.waveshare.com/ESP32-C6-Touch-LCD-1.47',
            attribution: 'Pinout image and pin assignment: Waveshare',
            description: 'ESP32-C6FH8 board with a 1.47-inch JD9853 touch LCD, AXS5106L touch controller, QMI8658A IMU, TF card slot, and LiPo charging circuit. The LCD and TF card share GPIO1/2 (SPI); touch and IMU share GPIO18/19 (I2C). GPIO0 (battery ADC), 14/15/22/23 (LCD), and 20/21 (touch) are internally connected and not on the headers. GPIO5/6 carry IMU interrupts; GPIO8 is BOOT, and GPIO12/13 are native USB. VBAT is the battery input, not a 3.3 V pin.'
        },
        {
            id: 'esp32-c6-super-mini', chip: 'esp32c6', name: 'ESP32-C6 Super Mini', subtitle: 'Generic - 22 GPIOs incl. rear pads', file: 'esp32-c6-super-mini-pinout.png', height: 1005,
            front: { crop: { x: 690, y: 170, width: 220, height: 305 }, left: [16, 17, 0, 1, 2, 3, 4, 5, 6, 7], right: ['5V', 'GND', '3V3', 20, 19, 18, 15, 14, 9, 8], xLeft: 710, xRight: 890, y: 187, step: 29.5 },
            back: { crop: { x: 690, y: 555, width: 220, height: 305 }, pads: [[21, 768, 778, 'left'], [22, 778, 801, 'left'], [23, 858, 789, 'right'], [12, 739, 812, 'left'], [13, 739, 840, 'left']] },
            notes: { 8: 'RGB-LED', 9: 'BOOT-Taster', 12: 'Natives USB D-', 13: 'Natives USB D+', 15: 'Onboard-LED', 21: 'Zusatzpad', 22: 'Zusatzpad', 23: 'Zusatzpad' },
            description: 'Compact C6 board with Wi-Fi 6, BLE, and Thread/Zigbee. Five additional GPIO pads are on the back; GPIO8 and GPIO15 are connected to LEDs.'
        },
        {
            id: 'esp32-c6-zero-mini', chip: 'esp32c6', name: 'ESP32-C6 Zero Mini', subtitle: 'Waveshare - 22 GPIOs incl. rear pads', file: 'esp32-c6-zero-mini-pinout.png', height: 971,
            front: { crop: { x: 690, y: 175, width: 220, height: 310 }, left: ['5V', 'GND', '3V3', 0, 1, 2, 3, 4, 5], right: [16, 17, 14, 15, 18, 19, 20, 21, 22], xLeft: 710, xRight: 890, y: 195, step: 30 },
            back: { crop: { x: 690, y: 545, width: 220, height: 300 }, xLeft: 710, xRight: 890, y: 567, step: 29.5, mirror: false, pads: [[13, 740, 642, 'left'], [12, 740, 663, 'left'], [23, 740, 683, 'left'], [9, 740, 703, 'left'], [8, 740, 723, 'left'], [7, 740, 743, 'left'], [6, 740, 763, 'left']] },
            notes: {8: 'RGB LED', 9: 'BOOT button', 12: 'Native USB D-', 13: 'Native USB D+'},
            description: 'Compact Waveshare C6 board with seven additional GPIO pads on the back. GPIO8 is connected to the RGB LED, and GPIO9 is connected to BOOT.'
        },
        {
            id: 'xiao-esp32c3', chip: 'esp32c3', name: 'XIAO ESP32C3', subtitle: 'Seeed Studio - 11 GPIOs - 2 x 7 pins', file: 'esp32c3-pinout.png', height: 841,
            front: { crop: { x: 695, y: 130, width: 210, height: 260 }, left: [2, 3, 4, 5, 6, 7, 21], right: ['5V', 'GND', '3V3', 10, 9, 8, 20], xLeft: 718, xRight: 885, y: 185, step: 28 },
            back: {
                crop: { x: 695, y: 450, width: 210, height: 245 }, xLeft: 718, xRight: 885, y: 486, step: 28,
                pads: [[7, 783, 485, 'left'], [6, 783, 541, 'left'], [5, 818, 485, 'right'], [4, 818, 541, 'right']]
            },
            notes: {18: 'Native USB D-', 19: 'Native USB D+'},
            description: 'Compact C3 board with USB-C and a LiPo charger. The rear GPIO contacts are also accessible through the front headers.'
        },
        {
            id: 'esp32-c3-devkitm-1', chip: 'esp32c3', name: 'ESP32-C3-DevKitM-1', subtitle: 'Espressif - 15 GPIOs - 2 x 15 pins', file: 'esp32-c3-devkitm-1-pinout.png', height: 804,
            front: { crop: { x: 665, y: 205, width: 270, height: 445 }, left: ['GND', 19, 18, 'GND', 4, 5, 6, 7, 'GND', 8, 9, 'GND', 20, 21, 'GND'], right: ['GND', '5V', '5V', 'GND', 10, 1, 0, 'GND', 'RST', 'GND', 3, 2, '3V3', '3V3', 'GND'], xLeft: 682, xRight: 918, y: 232, step: 26.5 },
            notes: {8: 'RGB LED', 9: 'BOOT button', 18: 'Native USB D-', 19: 'Native USB D+'},
            description: 'Official C3 development board with a USB-UART bridge and Micro-USB. GPIO9 is BOOT, GPIO8 drives the RGB LED, and GPIO18/19 provide native USB Serial/JTAG.'
        },
        {
            id: 'heltec-wifi-kit-32-v3', chip: 'esp32s3', name: 'Heltec WiFi Kit 32 (V3)', subtitle: 'Heltec - 28 header GPIOs - OLED - USB-C', file: 'heltec-wifi-kit-32-v3-pinout.png', height: 811,
            front: { crop: { x: 666, y: 148, width: 268, height: 500 }, left: ['GND', '5V', 'Ve', 'Ve', 44, 43, 'RST', 0, 21, 20, 19, 7, 6, 5, 4, 3, 2, 1], right: ['GND', '3V3', '3V3', 26, 48, 47, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 45, 46], xLeft: 683, xRight: 916, y: 182, step: 26 },
            notes: {0: 'PRG/USER button; strapping pin', 1: 'Battery voltage measurement through a divider, enabled by GPIO37', 21: 'OLED reset', 35: 'White onboard LED', 36: 'Vext and OLED power; switch on by setting LOW', 37: 'Enable the battery voltage divider', 43: 'UART0 TX to the CP2102 bridge', 44: 'UART0 RX from the CP2102 bridge'},
            description: 'ESP32-S3 board with a 0.96-inch OLED, LiPo connector, and CP2102 USB-UART bridge. GPIO21 controls OLED reset, GPIO36 switches Vext/OLED power, and GPIO37 enables battery-voltage measurement; these pins are already used by the board.'
        },
        {
            id: 'heltec-wifi-lora-32-v2', chip: 'esp32', name: 'Heltec WiFi LoRa 32 (V2)', subtitle: 'Heltec - 28 header GPIOs - OLED + LoRa', file: 'heltec-wifi-lora-32-v2-pinout.png', height: 706,
            front: { crop: { x: 685, y: 123, width: 230, height: 445 }, left: ['GND', '5V', 'Vext', 'Vext', 3, 1, 'RST', 0, 22, 19, 23, 18, 5, 15, 2, 4, 17, 16], right: ['GND', '3V3', '3V3', 36, 37, 38, 39, 34, 35, 32, 33, 25, 26, 27, 14, 12, 13, 21], xLeft: 700, xRight: 900, y: 155, step: 22.1 },
            notes: {0: 'PRG button and strapping pin', 4: 'OLED SDA', 5: 'LoRa SCK; observe the boot level', 14: 'LoRa reset', 15: 'OLED SCL; observe the boot level', 16: 'OLED reset', 18: 'LoRa chip select', 19: 'LoRa MISO', 21: 'Enable Vext by setting LOW', 25: 'Onboard LED', 26: 'LoRa DIO0', 27: 'LoRa MOSI', 34: 'LoRa DIO2; input only', 35: 'LoRa DIO1; input only', 36: 'Input only', 37: 'Input only', 38: 'Input only', 39: 'Input only'},
            description: 'ESP32 board with a 0.96-inch OLED and LoRa radio module. Several header GPIOs are already connected to the OLED and LoRa module; GPIO34-39 are input-only. Vext is switched through GPIO21.'
        },
        {
            id: 'lilygo-t-display-s3', chip: 'esp32s3', name: 'LilyGo T-Display-S3', subtitle: 'LilyGo - 13 header GPIOs - 1.9-inch LCD', file: 'lilygo-t-display-s3-pinout.png', width: 1083, height: 1098,
            front: { crop: { x: 418, y: 195, width: 252, height: 590 }, left: ['3V3', 1, 2, 3, 10, 11, 12, 13, 'NC', 'NC', 'GND', '5V'], right: ['GND', 'GND', 43, 44, 18, 17, 21, 16, 'NC', 'GND', 'GND', '3V3'], xLeft: 433, xRight: 651, y: 282, step: 24.5 },
            extra: [0, 4, 5, 6, 7, 8, 9, 14, 15, 38, 39, 40, 41, 42, 45, 46, 47, 48], extraLabel: 'INTERNALLY CONNECTED GPIOs',
            notes: {0: 'BOOT button; strapping pin', 3: 'Strapping pin', 4: 'Battery voltage measurement (ADC)', 5: 'LCD reset', 6: 'LCD chip select', 7: 'LCD data/command', 8: 'LCD write', 9: 'LCD read', 10: 'SPI chip select', 11: 'SPI MOSI', 12: 'SPI clock', 13: 'SPI MISO', 14: 'User button', 15: 'Switch on LCD/peripheral power by setting HIGH', 16: 'Touch interrupt on the touch model', 17: 'I2C SCL; connected to the touch controller on the touch model', 18: 'I2C SDA; connected to the touch controller on the touch model', 21: 'Touch reset on the touch model', 38: 'LCD backlight', 39: 'LCD data line D0', 40: 'LCD data line D1', 41: 'LCD data line D2', 42: 'LCD data line D3', 43: 'UART0 TX', 44: 'UART0 RX', 45: 'LCD data line D4', 46: 'LCD data line D5', 47: 'LCD data line D6', 48: 'LCD data line D7'},
            attribution: 'Pinout image: LilyGo, provided by ESPboards',
            description: 'ESP32-S3 board with a 1.9-inch ST7789V LCD and two buttons. The pinout image shows the accessible headers on the populated back side; many other GPIOs are connected internally to the LCD and buttons.'
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
            attribution: spec.attribution || 'Pinout diagram: ESPboards · CC BY-NC 4.0'
        };
    });
    // Photo crops are rendered using SVG viewBox, without changing the images.
    // Coordinates use the original source pixels. Power pads remain visible but
    // are never treated as GPIOs. Raw-chip view uses logical GPIO numbers.
    const boards = [
        {
            id: 'lolin-nodemcu-v3', chip: 'esp8266', name: 'LoLin NodeMCU V3', subtitle: 'ESP8266 - 30 pins - read GPIO registers',
            image: 'assets/lolin-nodemcu-v3.jpg',
            imageSize: { width: 900, height: 1742 }, crop: { x: 60, y: 85, width: 665, height: 1580 },
            pins: [
                ...[['A0', null], ['GND', null], ['VU', null], ['S3', 10], ['S2', 9], ['S1', 8], ['SC', 11], ['S0', 7], ['SK', 6], ['GND', null], ['3V3', null], ['EN', null], ['RST', null], ['GND', null], ['VIN', null]]
                    .map(([label, gpio], index) => ({ label, gpio, x: 90, y: 465 + index * 57.5, side: 'left' })),
                ...[['D0', 16], ['D1', 5], ['D2', 4], ['D3', 0], ['D4', 2], ['3V3', null], ['GND', null], ['D5', 14], ['D6', 12], ['D7', 13], ['D8', 15], ['RX', 3], ['TX', 1], ['GND', null], ['3V3', null]]
                    .map(([label, gpio], index) => ({ label, gpio, x: 670, y: 390 + index * 67.5, side: 'right' }))
            ],
            notes: {0: 'D3 / FLASH button; boot strapping pin, must be HIGH at startup', 1: 'TX / UART0 TX to the CH340 USB-UART bridge', 2: 'D4; boot strapping pin, must be HIGH at startup; blue onboard LED (active LOW)', 3: 'RX / UART0 RX to the CH340 USB-UART bridge', 4: 'D2 / I2C SDA', 5: 'D1 / I2C SCL', 6: 'SK / SPI flash clock; not available for general use', 7: 'S0 / SPI flash data; not available for general use', 8: 'S1 / SPI flash data; not available for general use', 9: 'S2 / SPI flash data; not available for general use', 10: 'S3 / SPI flash data; not available for general use', 11: 'SC / SPI flash chip select; not available for general use', 12: 'D6 / HSPI MISO', 13: 'D7 / HSPI MOSI', 14: 'D5 / HSPI SCLK', 15: 'D8 / HSPI CS; boot strapping pin, must be LOW at startup', 16: 'D0 / RTC GPIO16; separate input register path (RTC_GPIO_IN_DATA), supports wake-up'},
            source: 'https://commons.wikimedia.org/wiki/File:NodeMCU_Lua_Lol1n_V3.jpg',
            attribution: 'Board photo: Popolon / Wikimedia Commons · CC BY-SA 4.0; um 90° gedreht und verkleinert',
            description: 'LoLin NodeMCU V3 with ESP-12E, CH340 USB-UART, and Micro-USB. D0-D8 map to GPIO16, 5, 4, 0, 2, 14, 12, 13, and 15; RX/TX are GPIO3/1. SK and S0-S3/SC connect to SPI flash. A0 is an analog input, not part of the digital GPIO register. Live access reads input registers only; pin configuration and outputs remain disabled.'
        },
        {
            id: 'c3-supermini', chip: 'esp32c3', name: 'C3 SuperMini', subtitle: '13 GPIOs - USB-C - 2 x 8 pins',
            image: 'assets/c3-pinout.webp', imageSize: { width: 1600, height: 1100 }, crop: { x: 540, y: 95, width: 510, height: 685 },
            pins: columns([5, 6, 7, 8, 9, 10, 20, 21], ['5V', 'GND', '3V3', 4, 3, 2, 1, 0], 595, 1008, 197, 68.5),
            extra: [18, 19], extraLabel: 'INTERNALLY CONNECTED GPIOs',
            notes: {8: 'Onboard LED (often active LOW)', 9: 'BOOT button', 18: 'Native USB D-', 19: 'Native USB D+'},
            source: 'https://arduino-projekte.info/products/esp32-c3-supermini-kompaktes-wi-fi-ble-development-board-mit-risc-v-power',
            attribution: 'Board image: arduino-projekte.info',
            description: 'Standard SuperMini layout with USB-C at the top. Check the actual board variant before wiring.'
        },
        {
            id: 'c6-supermini', chip: 'esp32c6', name: 'C6 SuperMini', subtitle: '22 GPIOs incl. extra pads - USB-C',
            image: 'assets/c6-pinout.webp', imageSize: { width: 2000, height: 1579 }, crop: { x: 710, y: 205, width: 570, height: 855 },
            pins: columns([16, 17, 0, 1, 2, 3, 4, 5, 6, 7], ['5V', 'GND', '3V3', 20, 19, 18, 15, 14, 9, 8], 765, 1222, 321, 75.4),
            extra: [21, 22, 23, 12, 13],
            notes: {8: 'RGB LED', 9: 'BOOT button', 12: 'Native USB D-', 13: 'Native USB D+', 15: 'Onboard LED', 21: 'Additional pad', 22: 'Additional pad', 23: 'Additional pad'},
            source: 'https://arduino-projekte.info/products/esp32-c6-super-mini-kompaktes-wi-fi-6-ble-5-zigbee-dev-board-mit-risc-v-power',
            attribution: 'Board image: arduino-projekte.info',
            description: 'Purple SuperMini layout with USB-C at the top. Extra pads are shown schematically below the photo; check their positions on the back of your board.'
        },
        {
            id: 'toniebox-esp32', chip: 'esp32s3', name: 'Toniebox ESP32', subtitle: 'Toniebox V1/V2 - ESP32-S3 - debug and peripheral pins',
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
            attribution: 'PCB photo: Gambrius Tech Blog; pin assignment: Toniebox Hacking Wiki',
            description: 'Toniebox V1/V2 main board with an ESP32-S3. GPIO markers are arranged generically to the left and right of the PCB image and do not identify individual PCB pads. Pin comments document debug connections and links to NFC, audio, LEDs, buttons, battery/charging monitoring, and microSD. Board revisions may differ.'
        },
        {
            id: 'ai-s3', chip: 'esp32s3', name: 'AI-S3', subtitle: '36 GPIOs - 2 x 22 pins - USB + UART',
            image: 'assets/ai-s3-pinout.jpg', imageSize: { width: 1584, height: 1080 }, crop: { x: 685, y: 95, width: 280, height: 685 },
            pins: columns(['3V3', '3V3', 'RST', 4, 5, 6, 7, 15, 16, 17, 18, 8, 3, 46, 9, 10, 11, 12, 13, 14, '5V', 'GND'],
                ['GND', 43, 44, 1, 2, 42, 41, 40, 39, 38, 37, 36, 35, 0, 45, 48, 47, 21, 20, 19, 'GND', 'GND'], 705, 945, 185, 26.67),
            notes: {0: 'BOOT button', 19: 'Native USB D-', 20: 'Native USB D+', 43: 'UART0 TX / USB-UART bridge', 44: 'UART0 RX / USB-UART bridge', 47: 'RGB LED according to the pinout; check the board revision'},
            source: 'https://github.com/Xylopyrographer/BitsNThings/tree/main/AI-S3%20ESP32-S3%20Dev%20Board',
            attribution: 'Pinout: VCC-GND Studio, AI-S3 mapping: Xylopyrographer',
            description: 'AI-S3 board with a YD-ESP32-S3-compatible pinout, antenna at the top, and two USB connectors at the bottom. Onboard peripherals remain connected; memory and transport pins stay reserved.'
        },
        {
            id: 'h2-supermini', chip: 'esp32h2', name: 'H2 SuperMini', subtitle: '19 GPIOs incl. inner pads - USB-C',
            image: 'assets/h2-supermini-pinout.png', imageSize: { width: 1254, height: 1254 }, crop: { x: 490, y: 329, width: 292, height: 480 },
            pins: columns([24, 23, 0, 1, 2, 3, 4, 5, 8], ['5V', 'GND', '3V3', 14, 13, 12, 11, 10, 9], 507, 760, 395, 47.2),
            extra: [22, 25, 26, 27],
            notes: {8: 'WS2812 RGB LED', 9: 'BOOT button', 13: 'Blue onboard LED; the 15 marking next to the LED is not a GPIO15 pad', 22: 'Inner pad', 23: 'RX / UART0', 24: 'TX / UART0', 25: 'Inner pad / strapping pin', 26: 'Inner pad, sometimes mislabeled 28; native USB D-', 27: 'Inner pad / native USB D+'},
            source: 'https://www.nznelectronics.co.nz/products/esp32-h2-supermini-dev-board',
            attribution: 'Board image and corrected pin assignment: NZN Electronics',
            description: 'H2 SuperMini with charging circuitry, USB-C at the top, and two rows of nine side pads. The four inner holes are shown schematically below the photo. The marking 28 refers to GPIO26; 15 and BAT printed near LEDs are not additional GPIO pads. Check the layout on your board.'
        },
        {
            id: 'p4-eth', chip: 'esp32p4', name: 'ESP32-P4-ETH', subtitle: 'Waveshare - 40-pin header - Ethernet',
            image: 'assets/p4-pinout.jpg', imageSize: { width: 960, height: 969 }, crop: { x: 239, y: 85, width: 223, height: 849 },
            pins: columns([54, 19, 'GND', 18, 17, 16, 15, 'GND', 14, 6, 5, 4, 'GND', 3, 2, 8, 7, 'GND', 24, 25],
                ['VBUS', 'VSYS', 'GND', 'EN', '3V3', 20, 21, 'GND', 22, 23, 'RUN', 26, 'GND', 27, 32, 33, 46, 'GND', 47, 48], 254, 446, 153, 27),
            notes: {7: 'I2C SDA to the codec and accessory bus', 8: 'I2C SCL to the codec and accessory bus', 9: 'I2S data to the speaker codec', 10: 'I2S word select (LRCK)', 11: 'I2S microphone data', 12: 'I2S bit clock', 13: 'I2S master clock', 28: 'Ethernet RMII RXDV', 29: 'Ethernet RMII RXD0', 30: 'Ethernet RMII RXD1', 31: 'Ethernet MDC', 34: 'Ethernet RMII TXD0', 35: 'Ethernet RMII TXD1', 39: 'SD Data 0; LDO4 power domain, separate supply required', 40: 'SD Data 1; LDO4 power domain, separate supply required', 41: 'SD Data 2; LDO4 power domain, separate supply required', 42: 'SD Data 3; LDO4 power domain, separate supply required', 43: 'SD CLK; LDO4 power domain, separate supply required', 44: 'SD CMD; LDO4 power domain, separate supply required', 45: 'SD enable (active LOW); LDO4 power domain, separate supply required', 46: 'LDO4 power domain, separate supply required', 47: 'LDO4 power domain, separate supply required', 48: 'LDO4 power domain, separate supply required', 49: 'Ethernet RMII TX_EN', 50: 'Ethernet RMII REF_CLK', 51: 'Ethernet PHY reset', 52: 'Ethernet MDIO', 53: 'Audio amplifier enable'},
            extra: [9, 10, 11, 12, 13, 28, 29, 30, 31, 34, 35, 39, 40, 41, 42, 43, 44, 45, 49, 50, 51, 52, 53], extraLabel: 'INTERNALLY CONNECTED GPIOs',
            i2c: { sda: 7, scl: 8 },
            sd: {
                pins: { d0: 39, d1: 40, d2: 41, d3: 42, clk: 43, cmd: 44 },
                note: 'Onboard-Slot: LDO4-Domäne separat mit 3,3 V versorgen und GPIO45 manuell als Output LOW setzen.',
                source: 'https://files.waveshare.com/wiki/ESP32-P4-ETH/ESP32-P4-ETH-datasheet.pdf'
            },
            source: 'https://docs.waveshare.com/ESP32-P4-ETH', attribution: 'Board photo and pin assignment: Waveshare',
            description: 'Waveshare ESP32-P4-ETH with USB-C at the top and RJ45 at the bottom. Onboard peripherals remain electrically connected to their pins. GPIO39-48 are in the LDO4 power domain and need a separate power supply; GPIO configuration alone does not power them.'
        }
    ];
    for (const config of importedBoards) {
        const existingId = { 'esp32-h2-super-mini': 'h2-supermini', 'esp32-c6-super-mini': 'c6-supermini' }[config.id];
        const existing = boards.find(board => board.id === existingId);
        if (existing) {
            Object.assign(existing, config, { id: existingId, notes: {7: 'I2C SDA to the codec and accessory bus', 8: 'I2C SCL to the codec and accessory bus', 9: 'I2S data to the speaker codec', 10: 'I2S word select (LRCK)', 11: 'I2S microphone data', 12: 'I2S bit clock', 13: 'I2S master clock', 28: 'Ethernet RMII RXDV', 29: 'Ethernet RMII RXD0', 30: 'Ethernet RMII RXD1', 31: 'Ethernet MDC', 34: 'Ethernet RMII TXD0', 35: 'Ethernet RMII TXD1', 39: 'SD Data 0; LDO4 power domain, separate supply required', 40: 'SD Data 1; LDO4 power domain, separate supply required', 41: 'SD Data 2; LDO4 power domain, separate supply required', 42: 'SD Data 3; LDO4 power domain, separate supply required', 43: 'SD CLK; LDO4 power domain, separate supply required', 44: 'SD CMD; LDO4 power domain, separate supply required', 45: 'SD enable (active LOW); LDO4 power domain, separate supply required', 46: 'LDO4 power domain, separate supply required', 47: 'LDO4 power domain, separate supply required', 48: 'LDO4 power domain, separate supply required', 49: 'Ethernet RMII TX_EN', 50: 'Ethernet RMII REF_CLK', 51: 'Ethernet PHY reset', 52: 'Ethernet MDIO', 53: 'Audio amplifier enable'} });
            delete existing.extra;
        } else if (config.id === 's3-supermini') boards.splice(boards.findIndex(board => board.id === 'ai-s3'), 0, config);
        else boards.push(config);
    }
    const tonieboxIndex = boards.findIndex(board => board.id === 'toniebox-esp32');
    if (tonieboxIndex >= 0) boards.push(boards.splice(tonieboxIndex, 1)[0]);
    function raw(chip) {
        return {
            id: `raw-${chip.id}`, chip: chip.id, name: `${chip.name} · Raw Chip`, subtitle: 'All logical GPIOs',
            description: 'Logical GPIO view, not package pad numbers. Availability depends on the package, module, and memory configuration. Memory and transport pins remain reserved.',
            source: chip.source, attribution: 'Register profile: Espressif ESP-IDF', notes: {},
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
