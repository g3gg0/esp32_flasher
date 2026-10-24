# Accelerated I/O RAM stub

Small, synchronous RPC endpoint for ESP I/O Lab, including read-only accelerated
P4 SDMMC sector reads. ESP32-C3 and
ESP32-P4 are enabled in the browser. Build environments also exist for ESP32,
S2, S3, C2, C5, C6, C61 and H2. These additional targets compile, but browser
loading is intentionally limited to C3/P4 until their startup/transport paths
are exercised on hardware.

## Build with ESP-IDF 6.1

In WSL/Linux:

```sh
source /mnt/d/cygwin/home/g3gg0/git/esptool-legacy-flasher-stub/esp-idf/export.sh
cd /mnt/d/cygwin/home/g3gg0/git/esp32_flasher/stub
make                    # C3 + P4
make -C esp32c3          # one target
make prepared           # all ten targets
make check              # generated C/JS agree with protocol.json
```

This is a freestanding Make build using ESP-IDF 6.1's compiler, SoC/ROM headers,
and ROM linker interfaces. It does not build an ordinary IDF application or
start FreeRTOS. There is no heap, bootloader, partition table, flash cache/MMU,
flash probe, flash write/erase, PSRAM setup, or requirement for external memory.
Espressif also documents the larger full-IDF alternative in
[its RAM build configuration](https://github.com/espressif/esp-idf/blob/master/Kconfig).

Each target has `target.json` (CPU, RAM addresses/budgets, register window,
stack size) and a Makefile. The build emits an ELF, map, and raw text/data in
`build/<chip>/`, plus browser-ready `<chip>/stub.json`. The manifest contains
base64 RAM segments, lengths, SHA-256 hashes and entry address. Publish/serve
those manifests together with the source tree. They are included for local use.
The linker bounds IRAM/DRAM; the packager rejects unexpected allocated sections.
BSS is cleared by startup and never uploaded. A separate 2-KiB stack and
1-KiB packet buffer keep usage bounded. P4 adds 640 bytes of linker-owned DMA
storage, accessed exclusively through the uncached alias and excluded from BSS
zeroing. Compiler `size` includes read-only
data in its text total; manifest `ram.dataUsed` includes rodata, BSS and stack.

## Browser handoff

Serve the repository over localhost or HTTPS and open `io-tool/`:

1. Connect normally: ROM sync/chip detection, then the existing legacy stub.
2. Click **Load accelerated stub**. The browser fetches and validates the build
   before changing the session. Missing builds leave the legacy session usable.
3. Release peripheral leases, ADC state and GPIO outputs, stop the measurement
   queue, reset into ROM and sync again. Upload both RAM segments using
   MEM_BEGIN/MEM_DATA, checking every ROM status, then jump using MEM_END.
4. Send `SYNC` and require a matching chip/protocol `IDEN` response. Identity is
   displayed; GPIO/ADC continue through the existing controller using REGC/REGR.

The ROM reset avoids overwriting a running legacy stub, and deliberately starts
a new I/O session: existing outputs are released and board pins start as inputs.
The accelerated endpoint replaces the legacy endpoint for that session. A normal
disconnect/reset followed by reconnect returns to the legacy stub. A failed
handoff resets/disconnects and reports that reconnect is needed.

The existing flasher retains ownership of the serial reader, SLIP framing,
writer and command lock. The RPC adapter serializes requests and stops using
the session after a timeout or malformed reply, including already queued calls;
without transaction IDs a late reply cannot safely be reused.

## Protocol v1.1

`protocol.json` is authoritative. Run `make protocol` (or
`python3 scripts/generate-protocol.py`) to regenerate `include/protocol.h` and
`protocol.js`. The browser codec consumes generated field offsets/sizes; packed
C packet structs have compile-time size assertions. Bump the major version for
incompatible wire changes.

Every decoded SLIP frame is exactly one packet, all multi-byte values little
endian, with this common header:

```c
typedef struct __attribute__((packed)) {
    uint8_t magic[4];
    uint32_t length;  /* header + payload, excluding SLIP framing */
} rpc_header_t;
```

`length` must match the complete frame and be at most 1024 bytes. The receiver
discards oversized/invalid frames up to the next SLIP delimiter and returns one
error for a nonempty malformed frame. There are no unsolicited responses or
streams. Send one request, await one response; do not pipeline commands. Empty
SLIP delimiters are ignored. A partial frame requires its closing delimiter
before any reply is possible. SLIP escapes binary `C0` and `DB` bytes.

| Request | Response | Payload |
| --- | --- | --- |
| `SYNC` | `IDEN` | Request is exactly 8 bytes. Identity is 120 bytes total. |
| `REGC` | `REGR` | Read/masked write, address, value, mask, post-write delay in microseconds. |
| `I2CC` | `I2CR` | I²C envelope, driver reserved. |
| `SPIC` | `SPIR` | SPI envelope, driver reserved. |
| `SDMC` | `SDMR` | P4 slot-1 read-only transactions and 512-byte DMA sectors. |
| `RMTC` | `RMTR` | RMT envelope, driver reserved. |
| `PWMC` | `PWMR` | PWM/LEDC envelope, driver reserved. |
| `UARC` | `UARR` | UART envelope, driver reserved. |
| `I2SC` | `I2SR` | I²S envelope, driver reserved. |
| Unknown or malformed | `ERRO` | Original 4-byte tag and status. |

`IDENT` is represented by four-byte wire tag `IDEN`. Identity contains protocol
version, maximum frame size, capability bits, validity flags, optional JEDEC ID,
reset reason, factory MAC, CPU/core count, ROM transport number, chip/build/IDF
strings. Zero/invalid flash ID means **unprobed**, not "no flash found": startup
does not touch flash. Unknown MAC is explicitly marked invalid. Core count is
the target's physical core count; this stub runs on the boot CPU only.

REGC's operation 0 reads a 32-bit peripheral register; operation 1 writes
`(old & ~mask) | (value & mask)`, avoiding the read for mask `FFFFFFFF`. Only
aligned addresses in the target register window are accepted; the post-write
delay is bounded to 100000 µs. This supports the existing GPIO/ADC code. It
does not itself accelerate their polling.

Module requests have `uint16_t operation`, `uint16_t port`, `uint32_t timeout_us`,
then future module-specific bytes; replies have `uint32_t status`, echoed
operation/port and future result bytes. CONFIGURE/TRANSFER/RELEASE are reserved
operations 1/2/3. P4 advertises SDMMC; other modules still return UNSUPPORTED.
The browser blocks unavailable operations. Legacy I²C/SD implementations remain
available before the switch. With an accelerated stub loaded, P4 SD uses RPC
automatically; a build without the SDMMC capability cannot use that backend.

### P4 SDMMC sector dumps

Configure pins, width and read clock in the existing SD UI, then identify the
card. Pin leases, GPIO-matrix routing, clock setup and restoration retain the
existing browser controller; the stub runs each complete command and DMA data
phase locally. SD never changes LDO4 or GPIO45. On P4-ETH, enable the required
I/O supply explicitly in the LDO4 block and set GPIO45 LOW separately.

Identification always runs at 400 kHz. The configurable read clock is 400 kHz,
1 MHz, 5 MHz or 20 MHz; it is applied after selection and bus-width negotiation.
Re-identification returns to 400 kHz first. These clocks are options, not measured
throughput guarantees. Clock/pin setup uses register RPC once, while the dump
uses one SDMMC RPC per sector without host register polling or RAM word reads.

Choose an inclusive LBA range, `0–max` for the card, or a MiB preset from the
current start sector. The existing download workflow writes a raw `.img`, with
progress, speed/ETA and cancellation between bounded commands. Browser file
writes are batched to 64 KiB with backpressure; the full card is never buffered.
Browsers without the File System Access API retain the existing 64-MiB limit.
On cancellation/card failure only complete verified sectors are kept. Failed
disk batches are truncated to the last acknowledged batch.

SDMC CONFIGURE/RELEASE use the 16-byte module envelope with port 1. TRANSFER uses
the generated 28-byte `rpc_sdmmc_command_t`: operation, port, timeout, command
index, response type, argument, data byte count, and application-command flag.
Timeouts are 100–1500000 µs. SDMR is a 64-byte metadata packet echoing operation,
port, command, response type and argument, with SD error, raw events, transfer
count, descriptor/DMA status and RESP0–3. A successful CMD17 appends exactly
512 bytes; every failure returns metadata without sector bytes. See JSON for
all field offsets and enum values.

The stub accepts only CMD0/2/3/7/8/9/13/16/17/55 and prefixed ACMD6/41. It rejects
card writes, erase commands, arbitrary flags and voltage switching. R3 has no
response CRC check. DMA uses one aligned descriptor and one sector buffer in
the stub's reserved RAM, with memory barriers and P4's uncached CPU alias.
Fresh CMD_DONE, DATA_OVER, hardware CRC/error state, an exact 512-byte transfer
count and cleared descriptor ownership are required before returning data.
SDSC uses CMD16 and byte addresses; SDHC/SDXC uses sector addresses.

To implement a module, define its configuration/transfer packet layouts in JSON,
regenerate C/JS, add a bounded local driver/handler, and advertise the capability
only on supported targets. Put pin/controller/clock settings in CONFIGURE and
perform a complete transaction and hardware timeout handling locally in TRANSFER.
Keep UART control-channel pins/controller reserved from peripheral allocation.

## Validation and current limits

```sh
python3 -m unittest discover -s stub/tests -p 'test_*.py' # root; native cc
node --test --test-isolation=none io-tool/tests/*.test.js
```

The C host harness runs the actual firmware SLIP parser/dispatcher. Browser
transport tests run through the real flasher framing/command queue. The optional
`io-tool/scripts/accelerated-browser-check.mjs` uses a local Edge CDP endpoint
on 9235 and HTTP server on 8088 to exercise the UI with a simulated serial peer.
Pass `--p4-sd` to verify SD identification, read-clock selection, the MiB range
control and a byte-exact 1-MiB file download. C tests run the actual P4 driver
against mock registers/DMA; JavaScript tests dump 2 MiB in 1-/4-bit modes and
exercise SDSC, faults, cancellation, restoration and file batching.

All ten targets compile with the supplied ESP-IDF 6.1 toolchain. This does not
verify physical startup, RAM availability across silicon revisions, watchdogs,
or USB/UART behavior. The minimal platform layer retains ROM serial routing and
polls the ROM RX/TX entrypoints; C3's UART and USB Serial/JTAG ROM routines have
been inspected. USB OTG/CDC interrupt-driven operation is not brought up by this
stub and is not supported in this first stage. Test C3/P4 UART or USB Serial/JTAG
on the actual boards before relying on the accelerated mode. The P4 SD driver
has not been exercised on a physical card; real wiring, signal timing, SRAM/DMA
and cache behavior remain hardware-validation boundaries. Other peripheral
drivers are still reserved.

ESP-IDF headers/linker symbols remain under their upstream licenses; see
`../io-tool/LICENSE-ESP-IDF.txt`. No legacy flasher-stub source is linked.
