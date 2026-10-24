"""Generate legacy register recipes by evaluating the same IDF LL adapter.

Host-only Linux tool. No target or serial device is accessed.
"""
import subprocess
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

def generate(target, cfg, includes, components, out):
    flags = ['cc', '-std=gnu11', '-Os', '-DNDEBUG', '-D_GNU_SOURCE', '-no-pie', '-ffunction-sections', '-fdata-sections', '-Wl,--gc-sections', '-Wno-pointer-to-int-cast', '-Wno-int-to-pointer-cast']
    for p in includes:
        if p.is_dir(): flags += ['-I', str(p)]
    flags += ['-I', str(ROOT/'src')]
    ld = (components/f'soc/{target}/ld/{target}.peripherals.ld').read_text()
    flags += [f'-Wl,--defsym,{name}={value}' for name, value in re.findall(r'(\w+)\s*=\s*(0x[0-9a-fA-F]+)', ld)]
    exe = out/'legacy-profiles'
    subprocess.run([*flags, str(ROOT/'scripts/legacy-profiles.c'), '-o', str(exe)], check=True)
    subprocess.run([str(exe)], check=True)
