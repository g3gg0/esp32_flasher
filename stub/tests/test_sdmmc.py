"""Actual shared P4/S3 C driver + parser, with a simulated hardware boundary."""
import os
from pathlib import Path
import struct
import subprocess
import tempfile
import unittest
from test_wire import ROOT, SPEC, frame, packet, unframe


def module(operation, port=1, timeout=1000):
    return packet('SDMC', struct.pack('<HHI', operation, port, timeout))


def command(index=17, argument=7, response_type=1, data_bytes=512, application=0):
    return packet('SDMC', struct.pack('<HHIHHIHH', 2, 1, 1000, index, response_type, argument, data_bytes, application))


class SDMMCTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        cls.exe = Path(cls.temp.name) / 'sdmmc-test'
        subprocess.run(['cc', '-std=gnu11', '-Os', '-Wall', '-Wextra', '-Werror', '-fno-builtin', '-DRPC_SDMMC_TEST=1', '-ffunction-sections', '-fdata-sections', '-Wl,--gc-sections', '-I', str(ROOT / 'include'), '-I', str(ROOT / 'src'), '-I', str(ROOT / 'tests'), str(ROOT / 'src/stub.c'), str(ROOT / 'src/sdmmc.c'), str(ROOT / 'src/peripheral.c'), str(ROOT / 'tests/host-platform.c'), str(ROOT / 'tests/sdmmc-mock.c'), '-o', str(cls.exe)], check=True)

    @classmethod
    def tearDownClass(cls):
        cls.temp.cleanup()

    def exchange(self, *requests, mode=''):
        responses = unframe(subprocess.run([self.exe], input=b''.join(frame(r) for r in requests), capture_output=True, check=True, env={**os.environ, 'SD_TEST_MODE': mode}).stdout)
        self.assertEqual(len(responses), len(requests))
        for response in responses:
            self.assertEqual(struct.unpack_from('<I', response, 4)[0], len(response))
        return responses

    def status(self, response):
        self.assertEqual(response[:4], b'SDMR')
        return struct.unpack_from('<I', response, 8)[0]

    def test_p4_advertises_sdmmc_and_reads_exact_sector(self):
        iden, config, read, release = self.exchange(packet('SYNC'), module(1), command(), module(3))
        self.assertEqual(struct.unpack_from('<I', iden, 16)[0], 9)
        self.assertEqual(self.status(config), 0)
        self.assertEqual(self.status(read), 0)
        self.assertEqual(len(read), 64 + 512)
        self.assertEqual(read[64:], bytes((7 * 17 + i) & 255 for i in range(512)))
        self.assertEqual(struct.unpack_from('<I', read, 36)[0], 512)
        self.assertEqual(self.status(release), 0)

    def test_no_partial_or_stale_sector_leaves_firmware_on_any_failure(self):
        for mode in ['crc', 'data_timeout', 'short', 'ownership', 'dma', 'card_status', 'response_timeout', 'response_crc', 'no_done', 'start', 'stale']:
            config, response = self.exchange(module(1), command(), mode=mode)
            self.assertEqual(self.status(config), 0, mode)
            self.assertNotEqual(self.status(response), 0, mode)
            self.assertEqual(len(response), 64, mode)

    def test_write_commands_bad_lengths_ports_timeouts_and_unconfigured_reads_are_rejected(self):
        for request in [command(), module(1, port=0), module(1, timeout=0), module(1, timeout=1500001), packet('SDMC', b'')]:
            response, = self.exchange(request)
            self.assertNotEqual(self.status(response), 0)
        for index in [6, 18, 24, 25, 32, 33, 38, 42, 56]:
            _, response = self.exchange(module(1), command(index=index))
            self.assertEqual(self.status(response), 3)

    def test_application_command_requires_prefix_and_response_timeout_is_distinct(self):
        _, rejected = self.exchange(module(1), command(41, 0x40ff8000, 4, 0, 1))
        self.assertEqual(self.status(rejected), 3)
        _, prefix, acmd = self.exchange(module(1), command(55, 0, 1, 0), command(41, 0x40ff8000, 4, 0, 1))
        self.assertEqual(self.status(prefix), 0)
        self.assertEqual(self.status(acmd), 0)
        _, timeout = self.exchange(module(1), command(8, 0x1aa, 6, 0), mode='response_timeout')
        self.assertEqual(struct.unpack_from('<I', timeout, 24)[0], SPEC['sdmmcErrors']['RESPONSE_TIMEOUT'])

    def test_repeated_reads_release_and_reconfigure(self):
        responses = self.exchange(module(1), command(argument=0), command(argument=1), module(3), command(), module(1), command(argument=2))
        self.assertEqual(self.status(responses[4]), 5)
        for index, sector in [(1, 0), (2, 1), (6, 2)]:
            self.assertEqual(self.status(responses[index]), 0)
            self.assertEqual(responses[index][64:], bytes((sector * 17 + i) & 255 for i in range(512)))


if __name__ == '__main__':
    unittest.main()
