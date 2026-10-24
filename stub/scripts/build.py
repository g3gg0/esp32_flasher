#!/usr/bin/env python3
"""Small freestanding RAM stub, built against the exported ESP-IDF 6.1 SDK."""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
from targets import load_targets, generate as generate_targets

ROOT = Path(__file__).resolve().parents[1]


def run(args):
    subprocess.run([str(a) for a in args], check=True)


def build(target):
    idf = Path(os.environ.get("IDF_PATH", ""))
    version_file = idf / "tools/cmake/version.cmake"
    if not version_file.is_file() or "IDF_VERSION_MAJOR 6" not in version_file.read_text() or "IDF_VERSION_MINOR 1" not in version_file.read_text():
        raise SystemExit("Source ESP-IDF 6.1 export.sh before building.")
    configs = load_targets()
    if target not in configs:
        raise SystemExit(f"Unknown stub target: {target}")
    cfg = configs[target]
    generate_targets()
    spec = json.loads((ROOT / "protocol.json").read_text())
    prefix = cfg["compiler"]
    if not shutil.which(prefix + "gcc"):
        raise SystemExit(f"Missing {prefix}gcc; source ESP-IDF export.sh")
    if cfg['cpu'] == 'xtensa':
        multilib = subprocess.check_output([prefix + 'gcc', '--print-multi-directory'], text=True).strip()
        if multilib.split('/')[0] != target:
            raise SystemExit(f'{target}: compiler selected {multilib}, expected target-specific IDF wrapper')
    out = ROOT / "build" / target
    out.mkdir(parents=True, exist_ok=True)
    run([sys.executable, ROOT / "scripts/generate-protocol.py"])
    (out / "sdkconfig.h").write_text(f'#pragma once\n#define CONFIG_IDF_TARGET_{target.upper()} 1\n#define CONFIG_IDF_TARGET "{target}"\n#define CONFIG_ESP_ROM_HAS_LD_STUB 1\n#define CONFIG_ESP32P4_SELECTS_REV_LESS_V3 1\n#define CONFIG_FREERTOS_UNICORE 1\n#define CONFIG_LOG_DEFAULT_LEVEL 0\n')
    components = idf / "components"
    includes = [out, ROOT / "include", components / "esp_common/include", components / "esp_rom/include", components / f"esp_rom/{target}/include", components / f"soc/{target}/include", components / f"soc/{target}/register", components / f"soc/{target}/register/hw_ver1", components / "soc/include", components / "esp_hw_support/include", components / "esp_hal/include"]
    includes += [components / f'hal/{target}/include', components / 'hal/include', components / 'hal/platform_port/include', components / f'esp_rom/{target}/include/{target}']
    for name in ('i2c', 'gpspi', 'ledc', 'gpio'):
        includes += [components / f'esp_hal_{name}/{target}/include', components / f'esp_hal_{name}/include']
    includes += [p / 'include' for p in components.iterdir() if p.name != 'linux' and (p / 'include').is_dir()]
    text, data = int(cfg["text"], 0), int(cfg["data"], 0)
    text_budget, data_budget, stack = cfg["textBudget"], cfg["dataBudget"], cfg["stack"]
    linker = f'''ENTRY(_start)
MEMORY {{ iram (rx) : ORIGIN = {text:#x}, LENGTH = {text_budget}
         dram (rw) : ORIGIN = {data:#x}, LENGTH = {data_budget} }}
SECTIONS {{
  .text : ALIGN(16) {{ KEEP(*(.entry)) *(.literal .literal.*) *(.text .text.* .iram1 .iram1.*) }} > iram
  .data : ALIGN(16) {{ *(.rodata .rodata.* .srodata .srodata.*) *(.data .data.* .sdata .sdata.*) }} > dram
  __global_pointer$ = ADDR(.data) + 0x800;
  .bss (NOLOAD) : ALIGN(16) {{ _bss_start = .; *(.bss .bss.* .sbss .sbss.*) *(COMMON) . = ALIGN(16); _bss_end = .; }} > dram
  .dma (NOLOAD) : ALIGN(64) {{ *(.dma .dma.*) . = ALIGN(64); }} > dram
  .stack (NOLOAD) : ALIGN(16) {{ . += {stack}; _stack_top = .; }} > dram
  /DISCARD/ : {{ *(.eh_frame .eh_frame.* .comment .riscv.attributes .xtensa.info) }}
}}
ASSERT(SIZEOF(.text) <= {text_budget}, "IRAM budget exceeded")
ASSERT(SIZEOF(.data) + SIZEOF(.bss) + SIZEOF(.dma) + SIZEOF(.stack) <= {data_budget}, "DRAM budget exceeded")
'''
    (out / "stub.ld").write_text(linker)
    flags = ["-Os", "-g", "-Wall", "-Wextra", "-Werror", "-ffreestanding", "-fno-builtin", "-fno-stack-protector", "-ffunction-sections", "-fdata-sections", "-nostdlib", "-Wl,--gc-sections", f"-Wl,-Map={out / 'stub.map'}", f"-T{out / 'stub.ld'}", f'-DSTUB_CHIP="{target}"', f'-DSTUB_CPU="{cfg["cpu"]}"', f'-DSTUB_CORES={cfg["cores"]}', f'-DSTUB_IDF="6.1"', f'-DSTUB_UART_HEADER="{target}/rom/uart.h"', f'-DSTUB_REG_START={cfg["registerStart"]}u', f'-DSTUB_REG_END={cfg["registerEnd"]}u', f'-DSTUB_HAS_SDMMC={int(cfg.get("sdmmc", False))}', f'-DSTUB_DMA_UNCACHED_OFFSET={cfg.get("dmaUncachedOffset", "0x0")}u']
    if cfg["cpu"] == "riscv32":
        flags += ["-march=rv32imc_zicsr_zifencei", "-mabi=ilp32", "-msmall-data-limit=0", "-mno-relax"]
    else:
        # IDF's xtensa-esp32[s2/s3]-elf wrappers select the correct CPU plugin
        # and matching libgcc multilib automatically.
        flags += ["-mlongcalls", "-mtext-section-literals"]
    flags += ['-DNDEBUG', '-DSTUB_HAS_PERIPHERALS=1']
    for inc in includes:
        if inc.is_dir():
            flags += ["-isystem" if inc.is_relative_to(components) else "-I", str(inc)]
    rom = components / f"esp_rom/{target}/ld"
    for name in (f"{target}.rom.ld", f"{target}.rom.api.ld"):
        flags += [f"-T{rom / name}"]
    flags += [f'-T{components / f"soc/{target}/ld/{target}.peripherals.ld"}']
    elf = out / "stub.elf"
    sources = [ROOT / f'src/{name}' for name in ('start.S', 'stub.c', 'platform.c', 'sdmmc.c', 'capture.c', 'adc_calibration.c', 'peripheral.c', 'peripheral_port.c')]
    if target == 'esp32':
        sources += [components / 'soc/esp32/dport_access.c']
    sources += [components / f'esp_hal_{name}/{target}/{stem}_periph.c' for name, stem in [('i2c', 'i2c'), ('gpspi', 'spi'), ('ledc', 'ledc')]]
    run([prefix + "gcc", *flags, *sources, "-o", elf, "-lgcc"])
    from elftools.elf.elffile import ELFFile
    with elf.open("rb") as stream:
        for section in ELFFile(stream).iter_sections():
            if section["sh_flags"] & 2 and section["sh_size"] and section.name not in (".text", ".data", ".bss", ".dma", ".stack"):
                raise SystemExit(f"Unexpected allocated section {section.name}; refusing RAM manifest")
    # Only these two sections are loadable. BSS/stack are reserved, not uploaded.
    segments = []
    for section, address in ((".text", text), (".data", data)):
        dest = out / (section[1:] + ".bin")
        run([prefix + "objcopy", "-O", "binary", "-j", section, elf, dest])
        payload = dest.read_bytes()
        if payload:
            segments.append({"address": address, "data": base64.b64encode(payload).decode(), "length": len(payload), "sha256": hashlib.sha256(payload).hexdigest()})
    symbols = subprocess.check_output([prefix + "nm", "-n", str(elf)], text=True)
    symbol_values = {line.split()[2]: int(line.split()[0], 16) for line in symbols.splitlines() if len(line.split()) == 3}
    manifest = {"format": "esp-io-ram-stub-v1", "chip": target, "protocolMajor": spec["version"]["major"], "entry": symbol_values["_start"], "ramOnly": True, "requiresRom": True, "buildVersion": spec["buildVersion"], "idfVersion": "6.1", "ram": {"textStart": text, "textBudget": text_budget, "dataStart": data, "dataBudget": data_budget, "stackBytes": stack, "dataUsed": symbol_values["_stack_top"] - data}, "segments": segments}
    (ROOT / target / "stub.json").write_text(json.dumps(manifest, indent=2) + "\n")
    run([prefix + "size", elf])
    print(f'{target}: upload {sum(s["length"] for s in segments)} bytes, DRAM incl. stack {manifest["ram"]["dataUsed"]} bytes')


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--target", required=True)
    args = parser.parse_args()
    build(args.target)
