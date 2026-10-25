"""Execute native pad ownership logic with each target's actual SDK headers."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from test_wire import ROOT


class GPIOPadTest(unittest.TestCase):
    def test_each_target_releases_only_explicitly_selected_usb_gpio_pads(self):
        idf = Path(os.environ.get('IDF_PATH', str(ROOT.parents[1] / 'esptool-legacy-flasher-stub/esp-idf')))
        if not idf.is_dir():
            self.skipTest('ESP-IDF headers unavailable')
        components = idf / 'components'
        for target_file in sorted(ROOT.glob('*/target.json')):
            target = target_file.parent.name
            with self.subTest(target=target), tempfile.TemporaryDirectory() as out:
                dest = Path(out)
                (dest / 'sdkconfig.h').write_text(f'#define CONFIG_IDF_TARGET_{target.upper()} 1\n#define CONFIG_ESP32P4_SELECTS_REV_LESS_V3 1\n')
                includes = [dest, ROOT / 'src', components / 'esp_common/include', components / 'soc/include',
                            components / f'soc/{target}/include', components / f'soc/{target}/register/hw_ver1',
                            components / f'soc/{target}/register']
                exe = dest / 'gpio-pad'
                subprocess.run(['cc', '-std=c11', '-Os', '-Wall', '-Wextra', '-Werror',
                                *[arg for p in includes for arg in ('-isystem', str(p))],
                                str(ROOT / 'src/gpio_pad.c'), str(ROOT / 'tests/gpio-pad.c'),
                                '-o', str(exe)], check=True)
                inventory = json.loads((ROOT.parent / f'io-tool/configs/registers/{target}.json').read_text())
                registers = {r['name']: r['address'] for block in inventory['blocks'] for r in block['registers'] if 'address' in r}
                names = (['RTC_CNTL_USB_CONF_REG'] if target == 'esp32s2' else
                         ['USB_SERIAL_JTAG_CONF0_REG', 'USB_WRAP_OTG_CONF_REG'] if target == 'esp32p4' else
                         ['USB_SERIAL_JTAG_CONF0_REG'] if target not in ('esp32', 'esp32c2') else [])
                subprocess.run([str(exe), *[hex(registers[n]) for n in names]], check=True)


if __name__ == '__main__':
    unittest.main()
