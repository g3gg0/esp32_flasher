"""Cache pinned ESP-IDF sources for P4 register-only I2C."""
from pathlib import Path
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
PATHS = [
    'components/hal/esp32p4/include/hal/i2c_ll.h',
    'components/hal/i2c_hal.c',
    'components/esp_driver_i2c/i2c_master.c',
    'components/soc/esp32p4/i2c_periph.c',
]
if __name__ == '__main__':
    folder = ROOT / 'reference' / 'i2c-p4'
    folder.mkdir(parents=True, exist_ok=True)
    for path in PATHS:
        target = folder / Path(path).name
        if not target.exists():
            target.write_bytes(urllib.request.urlopen(f'https://raw.githubusercontent.com/espressif/esp-idf/v5.5.1/{path}', timeout=30).read())
        print(target.name)
