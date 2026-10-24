"""Exercise the actual C parser with malformed/fractured/oversized frames."""
import json
from pathlib import Path
import struct
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
SPEC = json.loads((ROOT / "protocol.json").read_text())


def frame(payload):
    return b'\xc0' + payload.replace(b'\xdb', b'\xdb\xdd').replace(b'\xc0', b'\xdb\xdc') + b'\xc0'


def packet(magic, payload=b''):
    return magic.encode() + struct.pack('<I', len(payload) + 8) + payload


def unframe(data):
    return [part.replace(b'\xdb\xdc', b'\xc0').replace(b'\xdb\xdd', b'\xdb') for part in data.split(b'\xc0') if part]


class WireTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        cls.exe = Path(cls.temp.name) / "wire-test"
        subprocess.run(['cc', '-std=c11', '-Os', '-Wall', '-Wextra', '-Werror', '-fno-builtin', '-ffunction-sections', '-fdata-sections', '-Wl,--gc-sections', '-I', str(ROOT / 'include'), '-I', str(ROOT / 'src'), str(ROOT / 'src/stub.c'), str(ROOT / 'src/sdmmc.c'), str(ROOT / 'src/rmt.c'), str(ROOT / 'src/capture.c'), str(ROOT / 'src/adc_calibration.c'), str(ROOT / 'src/peripheral.c'), str(ROOT / 'tests/host-platform.c'), '-o', str(cls.exe)], check=True)

    @classmethod
    def tearDownClass(cls):
        cls.temp.cleanup()

    def exchange(self, raw):
        return unframe(subprocess.run([self.exe], input=raw, capture_output=True, check=True).stdout)

    def assert_error(self, response, magic, status):
        self.assertEqual(response, packet('ERRO', magic + struct.pack('<I', status)))

    def test_sync_is_exactly_eight_bytes_and_identity_has_no_flash_claim(self):
        response, = self.exchange(frame(packet('SYNC')))
        self.assertEqual(response[:8], b'IDEN' + struct.pack('<I', 120))
        self.assertEqual(struct.unpack_from('<HH', response, 8), (SPEC['version']['major'], SPEC['version']['minor']))
        self.assertEqual(struct.unpack_from('<IIII', response, 12), (1024, 1, 0, 0))
        self.assertEqual(response[40:56].rstrip(b'\0'), b'esp32c3')

    def test_every_reserved_module_answers_with_matching_tag_and_correlation(self):
        for module in SPEC['modules'].values():
            payload = struct.pack('<HHI', 2, 7, 123456) + b'\xc0\xdb'
            response, = self.exchange(frame(packet(module['command'], payload)))
            self.assertEqual(response, packet(module['response'], struct.pack('<IHH', SPEC['status']['UNSUPPORTED'], 2, 7)))

    def test_malformed_length_short_frames_unknown_tag_and_oversize_resynchronize(self):
        requests = [b'AB', b'SYNC\x00\x00\x00\x00', packet('SYNC', b'extra'), packet('I2CC'), packet('????'), packet('SYNC', b'x' * 2000)]
        for request in requests:
            responses = self.exchange(frame(request) + frame(packet('SYNC')))
            self.assertEqual(len(responses), 2)
            self.assert_error(responses[0], request[:4].ljust(4, b'\0'), 1 if request[:4] == b'????' else 2)
            self.assertEqual(responses[1][:4], b'IDEN')

    def test_invalid_escape_and_trailing_escape_resynchronize(self):
        for raw in [b'\xc0SYNC\x08\0\0\0\xdb\xc0', b'\xc0SYNC\xdb\x99\xc0']:
            responses = self.exchange(raw + frame(packet('SYNC')))
            self.assert_error(responses[0], b'SYNC', 2)
            self.assertEqual(responses[1][:4], b'IDEN')

    def test_register_validation_returns_error_without_touching_address(self):
        for op, address, delay in [(9, 0x60004000, 0), (0, 1, 0), (1, 0x40380000, 0), (1, 0x60004000, 100001)]:
            response, = self.exchange(frame(packet('REGC', struct.pack('<IIIII', op, address, 0, 0xffffffff, delay))))
            self.assertEqual(response, packet('REGR', struct.pack('<II', 3, 0)))


if __name__ == '__main__':
    unittest.main()
