import sys
import tempfile
import unittest
from pathlib import Path

from test_wire import ROOT

sys.path.insert(0, str(ROOT / 'scripts'))
from build import include_dirs


class BuildTest(unittest.TestCase):
    def test_includes_target_specific_esp_rom_caps_directory(self):
        with tempfile.TemporaryDirectory() as temp:
            components = Path(temp) / 'components'
            (components / 'esp_rom/esp32').mkdir(parents=True)

            self.assertIn(components / 'esp_rom/esp32', include_dirs(components, 'esp32', Path(temp) / 'out'))


if __name__ == '__main__':
    unittest.main()
