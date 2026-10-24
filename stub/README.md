# Accelerated I/O RAM stub

Small, synchronous RPC endpoint for ESP I/O Lab. All ten chip profiles are
enabled in the browser: ESP32, S2, S3, C2, C3, C5, C6, C61, H2 and P4.
P4 and S3 share the accelerated read-only SDMMC sector driver.

| Targets | ROM serial paths | Accelerated capabilities |
| --- | --- | --- |
| ESP32, C2 | UART | Registers, I2C, SPI, LEDC |
| C3, C5, C6, C61, H2 | UART, USB Serial/JTAG | Registers, I2C, SPI, LEDC |
| S2 | UART, USB OTG/CDC | Registers, I2C, SPI, LEDC |
| S3 | UART, USB Serial/JTAG, USB OTG/CDC | Registers, I2C, SPI, LEDC, native SDMMC slot 1 |
| P4 | UART, USB Serial/JTAG, USB OTG/CDC | Registers, I2C, SPI, LEDC, native SDMMC slot 1 |

GPIO/ADC availability still follows the existing chip profiles. RMT, UART and I2S
RPC modules remain reserved; loading a stub does not advertise unimplemented
hardware or an SPI-SD driver. The table describes implemented code paths, not
physical-board validation.

## Build with ESP-IDF 6.1

In WSL/Linux:

```sh
source /mnt/d/cygwin/home/g3gg0/git/esptool-legacy-flasher-stub/esp-idf/export.sh
cd /mnt/d/cygwin/home/g3gg0/git/esp32_flasher/stub
make                    # all ten targets
make -C esp32c3          # one target
make prepared           # alias for all targets
make check              # generated C/JS agree with protocol.json
```

This is a freestanding Make build using ESP-IDF 6.1's compiler, SoC/ROM headers,
and ROM linker interfaces. It does not build an ordinary IDF application or
start FreeRTOS. There is no heap, bootloader, partition table, flash cache/MMU,
flash probe, flash write/erase, PSRAM setup, or requirement for external memory.
Espressif also documents the larger full-IDF alternative in
[its RAM build configuration](https://github.com/espressif/esp-idf/blob/master/Kconfig).

Each target has `target.json` (CPU/compiler, RAM addresses/budgets, register
window, stack size, transports, SDMMC support and optional DMA alias offset)
and a Makefile. These files are the single target registry:
`scripts/targets.py` generates `targets.js` for browser validation; the builder
reads the same definitions. There is no second browser-maintained RAM map.
New target directories are discovered by Make and the generator automatically.
ESP32/S2/S3 use IDF's matching compiler wrappers, including the correct CPU
configuration and libgcc multilib. The build verifies that selection.
The build emits an ELF, map, and raw text/data in
`build/<chip>/`, plus browser-ready `<chip>/stub.json`. The manifest contains
base64 RAM segments, lengths, SHA-256 hashes and entry address. Publish/serve
those manifests together with the source tree. They are included for local use.
The linker bounds IRAM/DRAM; the packager rejects unexpected allocated sections.
BSS is cleared by startup and never uploaded. A separate 2-KiB stack and
1-KiB packet buffer keep usage bounded. P4/S3 add 640 bytes of linker-owned DMA
storage, excluded from BSS zeroing. P4 uses the uncached alias; S3 uses directly
accessible internal SRAM. Compiler `size` includes read-only
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

## Protocol v1.2

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
| `I2CC` | `I2CR` | Bounded I²C master transactions on all targets. |
| `SPIC` | `SPIR` | Full-duplex SPI master transactions on all targets. |
| `SDMC` | `SDMR` | P4/S3 slot-1 read-only transactions and 512-byte DMA sectors. |
| `RMTC` | `RMTR` | RMT envelope, driver reserved. |
| `PWMC` | `PWMR` | Low-speed LEDC channels on all targets. |
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

All targets advertise I2C, SPI and PWM/LEDC in addition to registers. P4/S3
also advertise SDMMC. RMT/UART/I2S retain the reserved module envelope and
return UNSUPPORTED. The browser checks capability bits before selecting an
accelerated backend. Legacy P4 I2C/SD remain available before loading the stub.


### Shared P4/S3 SDMMC sector dumps

Configure pins, width and read clock in the existing SD UI, then identify the
card. Pin leases, GPIO-matrix routing, clock setup and restoration retain the
existing browser controller; the stub runs each complete command and DMA data
phase locally. SD never changes LDO4 or GPIO45. On P4-ETH, enable the required
I/O supply explicitly in the LDO4 block and set GPIO45 LOW separately.

Identification always runs at 400 kHz. P4's configurable read clock is 400 kHz,
1 MHz, 5 MHz or 20 MHz; it is applied after selection and bus-width negotiation.
S3 currently retains the existing 400-kHz clock recipe.
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
the stub's reserved RAM, with architecture-appropriate barriers and DMA addressing.
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
Pass `--chip=esp32c6` (or any target) to test its browser handoff/GPIO flow.
P4/S3 also verify the MiB range control and a byte-exact 1-MiB file download;
P4 additionally checks read-clock selection. `--p4-sd` remains an alias.
C tests run the actual shared driver
against mock registers/DMA; JavaScript tests dump 2 MiB on P4/S3 in 1-/4-bit modes and
exercise SDSC, faults, cancellation, restoration and file batching.

All ten targets compile with the supplied ESP-IDF 6.1 toolchain. This does not
verify physical startup, RAM availability across silicon revisions, watchdogs,
or USB/UART behavior. The shared platform layer retains ROM serial routing and
polls ROM RX/TX entrypoints. S2/S3 ROM USB-CDC receive/transmit routines have been
inspected: they service USB events by polling, so no application USB stack or
CPU interrupt setup is required. Full ROM TX FIFOs are retried to preserve every
binary byte. Physical UART, USB Serial/JTAG and USB-CDC startup still need checks
on the corresponding boards. Native SD drivers have not been exercised on a
physical card; wiring, timing, SRAM/DMA and cache behavior remain hardware
validation boundaries.

## Code sharing

- `src/stub.c`: one framing/parser/dispatcher and register-RPC implementation.
- `src/platform.c`: shared ROM serial I/O, watchdog setup and identity; SDK
  register names select the relevant hardware blocks.
- `src/start.S`: the two CPU-family startup paths, RISC-V and Xtensa.
- `src/sdmmc.c`: one complete P4/S3 transaction/DMA/error-handling implementation.
- `src/sdmmc_port.h` / `sdmmc_regs.h`: small register/base/DMA/barrier adapter and
  shared DW-MSHC layout, checked against each target's ESP-IDF headers.
- `esp32*/target.json`: per-chip data instead of cloned firmware sources.

ESP-IDF headers/linker symbols remain under their upstream licenses; see
`../io-tool/LICENSE-ESP-IDF.txt`. No legacy flasher-stub source is linked.

## Shared I2C, SPI and LEDC RPC (build 0.4.0)

`src/peripheral.c` contains the shared command/state machines and bounds;
`src/peripheral_port.c` uses ESP-IDF 6.1 target LL headers and signal tables.
No IDF driver tasks, interrupts, heap, flash or RTOS are linked. All ten
manifests include these drivers. Payloads are about 9.1-12.2 KiB and total
DRAM reservations actually used are under 4.7 KiB, including the 2-KiB stack.

`peripheral_command` is 48 bytes before TX data: common header, operation u16,
port u16, timeout_us u32, args[8] u32. `peripheral_response` is 56 bytes before
RX data: header, status u32, operation/port u16, error u32, actual_hz u32,
values[8] u32. All scalar/array elements are little endian. Operations are
CONFIGURE=1, TRANSFER=2, RELEASE=3, INFO=4; timeouts are 100-1500000 us.
Each accepted command returns its module response, including errors. Errors
never append data. INFO/CONFIGURE/RELEASE do not carry trailing bytes.

| Module | Port | CONFIGURE args | TRANSFER args and bytes |
| --- | --- | --- | --- |
| I2C | HP controller 0, optionally 1 | [100000 or 400000] | [7-bit address, TX length, RX length], followed by TX |
| SPI | 1=SPI2, optionally 2=SPI3 | [Hz 1-20000000, mode 0-3, LSB-first 0/1] | [length 1-64], followed by exactly that many TX bytes; equal RX length |
| PWM | Low-speed channel 0-5 or 0-7 | [Hz, resolution bits, timer 0-3, duty permille 0-1000] | [new duty permille]; no data |

Unused args are zero. RELEASE is idempotent. INFO discovers the signal routes
and hardware limits without enabling the peripheral. Its values are:

- I2C: [SDA out, SDA in, SCL out, SCL in, GPIO input-matrix base, FIFO size, HP controller count, 0].
- SPI: [CLK out, MOSI out, MISO in, CS0 out, GPIO input-matrix base, usable controller count, 64, 0].
- PWM: [channel output signal, channel count, timer count, maximum safe resolution bits, maximum divider, 0, 0, 0].

INFO actual_hz is the selected source clock; CONFIGURE/TRANSFER actual_hz is
the configured peripheral rate. Modern targets use XTAL; ESP32/S2 I2C/SPI
use APB. ESP32 LEDC uses APB, other LEDC uses XTAL. LEDC resolution is limited
to hardware width minus one so 100% duty remains representable; frequency /
resolution combinations outside the divider range are rejected. Channels
sharing a timer must use the same divider/resolution. Releasing one channel
does not stop the others. GPIO routing and snapshots are owned by the shared
browser lease implementation, with outputs disconnected during setup/restore.

I2C combined write/read performs a repeated START and NACKs the final read
byte before STOP. FIFO size is 16 on C2, 32 elsewhere; the TX FIFO includes
one write-address byte and, for combined reads, one read-address byte. A NACK
is reported only after bounded STOP recovery, so address scans can safely
continue; recovery failure is BUS. SPI excludes the flash controllers and
uses one hardware CS0 window per full-duplex transfer, with no splitting.
SPI configuration-update waits and completion polling have deadlines.
Peripheral error codes are NONE=0, NACK=1, TIMEOUT=2, ARBITRATION=3,
SHORT_DATA=4, NOT_CONFIGURED=5, TIMER_CONFLICT=6, BUS=7.

Host-native tests exercise the actual parser/shared driver with mocked
hardware. Browser QA covers all ten profiles with a simulated serial peer;
these checks do not validate physical bus timing, electrical behavior or boards.
