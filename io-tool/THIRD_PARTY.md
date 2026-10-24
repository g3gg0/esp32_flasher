# Third-party sources

## Espressif ESP-IDF

The generated GPIO/ADC/SD profiles and register-name catalogs are derived from the
ESP-IDF v5.5.1 SoC and HAL headers, Copyright Espressif Systems (Shanghai) CO LTD.
Those files use SPDX-License-Identifier: Apache-2.0. The upstream copyright
years vary by file (2015–2025); the original files and notices are retained in
the local ignored `reference/` download directory. Individual source URLs and
SHA-256 hashes are included in `configs/chips.js`, `configs/adc.js` and `configs/sd.js`.
The register-only SD driver also follows ESP-IDF's SDMMC host/protocol, S3
clock/GPIO-matrix and P4 LDO/clock HAL sources. The S3 internal DMA (IDMAC)
descriptor format and clock bitfields are documented in chapter 34 of the
[ESP32-S3 TRM](https://documentation.espressif.com/esp32-s3_technical_reference_manual_en.pdf).
Pinned reference downloads use `scripts/fetch-sd-reference.py`;
source links are recorded in the SD profile. The P4-ETH SD/power preset follows
Waveshare's schematic: https://files.waveshare.com/wiki/ESP32-P4-ETH/ESP32-P4-ETH-datasheet.pdf

Upstream: https://github.com/espressif/esp-idf/tree/v5.5.1

Apache License 2.0: included in `LICENSE-ESP-IDF.txt`.

## Board images

Board images are product/pinout reference images, not original project artwork.
They retain the rights of their respective owners. No open-source license for
these images is asserted by this project.

| Local file | Source image | Attribution |
| --- | --- | --- |
| `assets/c3-pinout.webp` | https://arduino-projekte.info/cdn/shop/files/ESP32C3SuperMiniPinout.webp?v=1747811476&width=1946 | arduino-projekte.info |
| `assets/c6-pinout.webp` | https://cdn.shopify.com/s/files/1/0903/0218/5736/files/ESP32C6SuperMiniPinout.webp?v=1749023636 | arduino-projekte.info |
| `assets/p4-pinout.jpg` | https://www.waveshare.com/img/devkit/ESP32-P4-ETH/ESP32-P4-ETH-details-inter.jpg | Waveshare |
| `assets/h2-supermini-pinout.png` | https://www.nznelectronics.co.nz/cdn/shop/files/ESP32-H2-SuperMini-Pinout.png?v=1785639285&width=1600 | NZN Electronics; mapping follows the supplier's corrected H2 SuperMini technical datasheet |
| `assets/esp32-s3-super-mini-pinout.png` | https://cdn.espboards.net/boards/esp32-s3-super-mini/diagram-1600.png | ESPboards, CC BY-NC 4.0 |
| `assets/heltec-wifi-kit-32-v3-pinout.png` | https://cdn.espboards.net/boards/heltec-wifi-kit-32-v3/diagram-1600.png | ESPboards, CC BY-NC 4.0 |
| `assets/heltec-wifi-lora-32-v2-pinout.png` | https://cdn.espboards.net/boards/heltec-wifi-lora-32-v2/diagram-1600.png | ESPboards, CC BY-NC 4.0 |
| `assets/lilygo-t-display-s3-pinout.png` | https://cdn.espboards.net/boards/lilygo-t-display-s3/pinout-1083.png | LilyGo, provided by ESPboards |
| `assets/xiao-esp32c5-pinout.png` | https://cdn.espboards.net/boards/xiao-esp32c5/diagram-1600.png | ESPboards, CC BY-NC 4.0 |
| `assets/esp32h2-super-mini-pinout.png` | https://cdn.espboards.net/boards/esp32-h2-super-mini/diagram-1600.png | ESPboards, CC BY-NC 4.0 |
| `assets/esp32-h2-devkitm-1-pinout.png` | https://cdn.espboards.net/boards/esp32-h2-devkitm-1/diagram-1600.png | ESPboards, CC BY-NC 4.0 |
| `assets/xiao-esp32c6-pinout.png` | https://cdn.espboards.net/boards/xiao-esp32c6/diagram-1600.png | ESPboards, CC BY-NC 4.0 |
| `assets/esp32-c6-devkitm-1-pinout.png` | https://cdn.espboards.net/boards/esp32-c6-devkitm-1/diagram-1600.png | ESPboards, CC BY-NC 4.0 |
| `assets/esp32-c6-super-mini-pinout.png` | https://cdn.espboards.net/boards/esp32-c6-super-mini/diagram-1600.png | ESPboards, CC BY-NC 4.0 |
| `assets/esp32-c6-zero-mini-pinout.png` | https://cdn.espboards.net/boards/esp32-c6-zero-mini/diagram-1600.png | ESPboards, CC BY-NC 4.0 |
| `assets/esp32c3-pinout.png` | https://cdn.espboards.net/boards/xiao-esp32c3/diagram-1600.png | ESPboards, CC BY-NC 4.0 |
| `assets/esp32-c3-devkitm-1-pinout.png` | https://cdn.espboards.net/boards/esp32-c3-devkitm-1/diagram-1600.png | ESPboards, CC BY-NC 4.0 |
| `assets/ai-s3-pinout.jpg` | https://raw.githubusercontent.com/Xylopyrographer/BitsNThings/main/AI-S3%20ESP32-S3%20Dev%20Board/AI-S3%20ESP32-S3%20Dev%20Board%20Pinout.jpg | VCC-GND Studio; AI-S3 compatibility annotation by Xylopyrographer |

The original images are unmodified. The UI displays the board areas using SVG
viewport clipping. Additional backside GPIO pads in the ESPboards diagrams are
positioned from the source image coordinates.

## ESP32-S3 ROM reference

The S3 internal analog-I2C recipe was also checked against Espressif's
`esp32s3_rev0_rom.elf`, release 20241011:
https://github.com/espressif/esp-rom-elfs/releases/tag/20241011

`rom_get_i2c_hostid` (0x400354bc) selects master 0 for block 0x69 and initializes
ANA_CONFIG2[16:4]. `rom_chip_i2c_readReg_org` (0x400354fc) and
`rom_chip_i2c_writeReg` (0x40035818) use control address 0x6000e000 and command
bit 26. The legacy SAR HOSTID macro is not the actual master selection.
No ROM binary is distributed with the tool.
