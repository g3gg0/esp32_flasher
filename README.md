# ESP32 Firmware Viewer & Web Flasher

Browser-based toolkit to inspect and edit ESP32 firmware images, and to read/write flash directly over USB-JTAG or a USB-UART adapter using the Web Serial API. Built for fast reverse-engineering loops and ad-hoc repair work—run entirely in Chrome or Edge, no native installs.

> Experimental: NVS editing and on-device writes are still in active development.

Use at your own risk and keep backups.

## Highlights
- **Firmware parsing**: Bootloader decoding, partition-table auto-detect, SHA-1/SHA-256 validation, and NVS parsing/editing. FAT wear-leveling partitions can be explored and files extracted.
- **Sparse image engine**: Lazy, sector-aware cache that minimizes device reads and merges writes into 4 KiB-aligned blocks for efficient flashing.
- **Device comms**: Supports ESP32, ESP32-S2/S3, ESP32-C3, and ESP32-C6. Implements ROM bootloader commands, SLIP framing, stub loading, sync/hard-reset helpers, and SPI config.
- **Editors & tools**: Hex viewer with configurable offsets/length/width, partition replacer, NVS add/edit/delete, firmware patching, and memory-map visualization of cached/modified/unread regions.
- **Performance feedback**: Read/write speed tracking with slow-link warnings (ESP32-S3/C3 USB can be sluggish) and live progress overlays.

## Live demos
- **ESP32 Firmware Viewer** – inspect and edit images (file or live device)
- **ESP32 Web Flasher** – flashing/test harness designed for embedding and link-stability checks

## Requirements
- Chrome or Edge (Web Serial is required for device access)
- USB-JTAG or USB-UART adapter wired to ESP32 (RX/TX) if not using native USB

### Baud-rate note
Web Serial cannot switch baud mid-session without reopening the port (which can reset the device). ESP32 ROM reset messages appear at 115200 baud. Choose 115200 to see ROM output or a higher baud (e.g., 921600) for speed—native USB/JTAG on ESP32-S series is unaffected.

## Repository layout
- `esp32-viewer.html` – firmware inspector/editor (file and live device modes)
- `flasher.html` – embeddable flasher and test suite UI
- `flasher.js` / `chips.js` / `esp32-parser.js` – core logic for bootloader protocol, parsing, and device helpers
- `esp32.c` – C helpers for NVS sector walking/editing
- `build.js` – combines assets for distribution; see build steps below

## Quick start (local, no build)
1. Open `esp32-viewer.html` in Chrome/Edge.
2. Load a `.bin` file **or** click **Connect to ESP32** to work directly on a device.
3. Review the parsed bootloader, partition table, NVS, and hex views. Use the memory map to see cached vs. modified regions.
4. When connected to hardware, load the stub, make edits, and write back to flash. Keep a backup of the original image.

## Build
For a combined/minified bundle, run:

```bash
node build.js
```

(Tasks `Build: Combined HTML` and `Build: Watch Mode` are available in the workspace for convenience.)

## Safety tips
- Always keep a full flash backup before writing.
- Expect unstable speeds on some ESP32-S3/C3 USB paths; warnings surface in the UI.
- NVS edits are experimental—verify changes on hardware you can recover.

## Backstory
A failed firmware patch spiraled into a browser-native ESP32 firmware editor and flasher. With LLM-assisted iteration, repetitive reverse-engineering tasks (bootloader/partition/NVS parsing, stub loading, flash ops) were automated into reusable modules. The goal: cut turnaround from hours to minutes while staying entirely in the browser.
