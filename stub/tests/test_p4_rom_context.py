import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from test_wire import ROOT

class P4ROMContextTest(unittest.TestCase):
    def test_actual_p4_driver_uses_revision_specific_rom_data_slots(self):
        idf=Path(os.environ.get('IDF_PATH',str(ROOT.parents[1]/'esptool-legacy-flasher-stub/esp-idf')))
        if not idf.is_dir():self.skipTest('ESP-IDF headers unavailable')
        components=idf/'components'
        include=[ROOT/'build/esp32p4',ROOT/'src',components/'esp_common/include',components/'esp_rom/include',components/'esp_rom/esp32p4/include',components/'soc/include',components/'soc/esp32p4/include',components/'soc/esp32p4/register/hw_ver1']
        with tempfile.TemporaryDirectory() as out:
            exe=Path(out)/'rom-context'
            subprocess.run(['cc','-std=c11','-Os','-Wall','-Wextra','-Werror','-DSTUB_HAS_FLASH=1',*[arg for p in include for arg in ('-isystem',str(p))],str(ROOT/'src/flash_port.c'),str(ROOT/'tests/p4-rom-context.c'),'-o',str(exe)],check=True)
            subprocess.run([exe],check=True,capture_output=True)
