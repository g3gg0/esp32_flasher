"""Fetch pinned Espressif headers used to generate/review the register profiles."""
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import json
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
REF = "v5.5.1"
CHIPS = ["esp32", "esp32s2", "esp32s3", "esp32c2", "esp32c3", "esp32c5", "esp32c6", "esp32c61", "esp32h2", "esp32p4"]
BASE = f"https://raw.githubusercontent.com/espressif/esp-idf/{REF}/"

def get(path):
    with urllib.request.urlopen(path, timeout=45) as response:
        return response.read()

def fetch_chip(chip):
    folder = ROOT / "reference" / chip
    folder.mkdir(parents=True, exist_ok=True)
    entries = json.loads(get(f"https://api.github.com/repos/espressif/esp-idf/contents/components/soc/{chip}/register/soc?ref={REF}"))
    paths = [f"components/soc/{chip}/register/soc/{item['name']}" for item in entries if item['name'].endswith("_reg.h") or item['name'] in ("soc.h", "reg_base.h")]
    paths += [f"components/soc/{chip}/include/soc/{name}" for name in ("soc_caps.h", "gpio_sig_map.h", "gpio_pins.h", "usb_pins.h", "uart_pins.h", "spi_pins.h")]
    paths += [f"components/soc/{chip}/gpio_periph.c", f"components/soc/{chip}/rtc_io_periph.c", f"components/hal/{chip}/include/hal/gpio_ll.h", f"components/hal/{chip}/include/hal/rtc_io_ll.h"]
    if chip in ("esp32c3", "esp32c6", "esp32p4", "esp32s3", "esp32h2"):
        paths += [f"components/hal/{chip}/include/hal/adc_ll.h", f"components/soc/{chip}/include/soc/adc_channel.h", f"components/soc/{chip}/include/soc/regi2c_defs.h", f"components/soc/{chip}/include/soc/regi2c_saradc.h", f"components/efuse/{chip}/esp_efuse_table.c", f"components/efuse/{chip}/esp_efuse_rtc_calib.c", f"components/bootloader_support/src/bootloader_random_{chip}.c"]
    if chip in ('esp32s3', 'esp32h2'):
        paths += [f'components/hal/{chip}/include/hal/{name}' for name in ('sar_ctrl_ll.h', 'regi2c_ctrl_ll.h')]
    if chip == 'esp32h2':
        paths += ['components/esp_rom/patches/esp_rom_regi2c_esp32h2.c', 'components/hal/adc_oneshot_hal.c']
    if chip in ('esp32c6', 'esp32h2'):
        paths += [f'components/soc/{chip}/include/modem/reg_base.h', f'components/soc/{chip}/include/modem/modem_lpcon_reg.h']
    def fetch(path):
        target = folder / ('modem_reg_base.h' if path.endswith('/modem/reg_base.h') else Path(path).name)
        if target.exists():
            return
        try:
            target.write_bytes(get(BASE + path))
        except urllib.error.HTTPError as error:
            if error.code != 404:
                raise
    with ThreadPoolExecutor(max_workers=8) as pool:
        list(pool.map(fetch, paths))
    return f"{chip}: {len(list(folder.glob('*')))} reference files"

if __name__ == "__main__":
    with ThreadPoolExecutor(max_workers=3) as pool:
        for result in pool.map(fetch_chip, CHIPS):
            print(result, flush=True)
