"""Cache pinned Espressif sources for the P4/S3 register-only SD hosts."""
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
REF = 'v5.5.1'
PATHS = [
    'components/hal/esp32p4/include/hal/sdmmc_ll.h',
    'components/hal/include/hal/sdmmc_hal.h',
    'components/soc/esp32p4/sdmmc_periph.c',
    'components/soc/esp32p4/include/soc/sdmmc_pins.h',
    'components/soc/esp32p4/register/soc/sdmmc_struct.h',
    'components/esp_driver_sdmmc/src/sdmmc_host.c',
    'components/esp_driver_sdmmc/src/sdmmc_transaction.c',
    'components/esp_driver_sdmmc/src/sdmmc_internal.h',
    'components/sdmmc/sdmmc_cmd.c',
    'components/sdmmc/sdmmc_init.c',
    'components/esp_driver_sdmmc/include/driver/sdmmc_defs.h',
    'components/hal/sdmmc_hal.c',
    'components/sdmmc/include/sd_protocol_defs.h',
    'components/sdmmc/sdmmc_sd.c',
    'components/esp_hw_support/port/esp32p4/esp_clk_tree.c',
    'components/hal/esp32p4/include/hal/clk_tree_ll.h',
    'components/hal/esp32p4/include/hal/clk_gate_ll.h',
    'components/soc/esp32p4/include/soc/clk_tree_defs.h',
    'components/hal/esp32p4/include/hal/ldo_ll.h',
    'components/soc/esp32p4/register/soc/pmu_struct.h',
    'components/esp_hw_support/ldo/esp_ldo_regulator.c',
    'components/sdmmc/sd_pwr_ctrl/sd_pwr_ctrl_by_on_chip_ldo.c',
]

def fetch(path):
    target = ROOT / 'reference' / 'sd-p4' / Path(path).name
    target.parent.mkdir(parents=True, exist_ok=True)
    if not target.exists():
        target.write_bytes(urllib.request.urlopen(f'https://raw.githubusercontent.com/espressif/esp-idf/{REF}/{path}', timeout=30).read())
    return target.name

if __name__ == '__main__':
    with ThreadPoolExecutor(max_workers=6) as pool:
        for name in pool.map(fetch, PATHS):
            print(name)
    for path in (
        'components/hal/esp32s3/include/hal/sdmmc_ll.h',
        'components/soc/esp32s3/sdmmc_periph.c',
        'components/soc/esp32s3/include/soc/sdmmc_pins.h',
        'components/soc/esp32s3/register/soc/sdmmc_struct.h',
    ):
        target = ROOT / 'reference' / 'sd-s3' / Path(path).name
        target.parent.mkdir(parents=True, exist_ok=True)
        if not target.exists():
            target.write_bytes(urllib.request.urlopen(f'https://raw.githubusercontent.com/espressif/esp-idf/{REF}/{path}', timeout=30).read())
        print(f'esp32s3/{target.name}')
