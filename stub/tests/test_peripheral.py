"""Exercise shared native command planning, bounds, recovery and timer ownership."""
import os
import struct
import subprocess
import tempfile
import unittest
from pathlib import Path
from test_wire import ROOT, SPEC, frame, packet, unframe


def request(kind, op, port=0, args=(), data=b'', timeout=1000):
    return packet(kind+'C', struct.pack('<HHI8I', op, port, timeout, *(list(args)+[0]*(8-len(args))))+data)


class PeripheralTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        cls.exe = Path(cls.temp.name)/'peripheral-test'
        subprocess.run(['cc', '-std=c11', '-Os', '-Wall', '-Wextra', '-Werror', '-fno-builtin', '-DRPC_PERIPHERAL_TEST=1', '-ffunction-sections', '-fdata-sections', '-Wl,--gc-sections', '-I', str(ROOT/'include'), '-I', str(ROOT/'src'), *[str(ROOT/'src'/s) for s in ('stub.c', 'fuses.c', 'flash.c', 'sdmmc.c', 'capture.c', 'adc_calibration.c', 'rmt.c', 'peripheral.c')], str(ROOT/'tests/host-platform.c'), str(ROOT/'tests/peripheral-mock.c'), '-o', str(cls.exe)], check=True)

    @classmethod
    def tearDownClass(cls):
        cls.temp.cleanup()

    def exchange(self, *requests, mode=''):
        replies = unframe(subprocess.run([self.exe], input=b''.join(frame(r) for r in requests), capture_output=True, check=True, env={**os.environ, 'IO_TEST_MODE': mode}).stdout)
        self.assertEqual(len(replies), len(requests))
        for r in replies: self.assertEqual(len(r), struct.unpack_from('<I', r, 4)[0])
        return replies

    def status(self, reply): return struct.unpack_from('<I', reply, 8)[0]
    def error(self, reply): return struct.unpack_from('<I', reply, 16)[0]

    def test_i2c_combined_read_and_fifo_bounds(self):
        config=request('I2C', 1, args=[400000])
        r=self.exchange(config, request('I2C', 2, args=[0x50, 2, 32], data=b'\x12\x34'))[-1]
        self.assertEqual(r[:4], b'I2CR'); self.assertEqual(self.status(r), 0); self.assertEqual(r[56:], bytes(range(0xa0,0xc0)))
        for args,data in [([128,0,1],b''),([80,31,1],b'x'*31),([80,0,33],b''),([80,1,1],b'')]:
            self.assertNotEqual(self.status(self.exchange(config, request('I2C',2,args=args,data=data))[-1]),0)
        self.assertNotEqual(self.status(self.exchange(config,request('I2C',2,args=[80,0,17]),mode='fifo16')[-1]),0)

    def test_i2c_failures_and_nack_recovery(self):
        for mode, code in [('nack',1),('timeout',2),('busy',2),('arbitration',3),('short',4)]:
            r=self.exchange(request('I2C',1,args=[100000]),request('I2C',2,args=[80,0,1]),mode=mode)[-1]
            self.assertEqual(self.error(r),code); self.assertEqual(len(r),56)

    def test_spi_ports_data_and_timeout_deactivation(self):
        cfg=request('SPI',1,1,[1000000,3,1]); tx=bytes(range(64))
        r=self.exchange(cfg,request('SPI',2,1,[64],tx))[-1]
        self.assertEqual(r[:4],b'SPIR'); self.assertEqual(r[56:],bytes(x^255 for x in tx))
        self.assertNotEqual(self.status(self.exchange(request('SPI',1,0,[1000000]))[0]),0)
        r=self.exchange(cfg,request('SPI',2,1,[1],b'a'),request('SPI',2,1,[1],b'a'),mode='timeout')
        self.assertEqual(self.error(r[1]),2); self.assertEqual(self.error(r[2]),5)

    def test_scan_nack_stop_without_complete_irq_then_next_device_read(self):
        # STOP releases BUS_BUSY while the original NACK remains latched;
        # no new TRANS_COMPLETE/command-DONE event is required by IDF.
        r=self.exchange(request('I2C',1,args=[100000]),request('I2C',2,args=[3,0,0]),request('I2C',2,args=[0x18,0,1]),mode='probe-nack')
        self.assertEqual(self.error(r[1]),1);self.assertEqual(self.status(r[2]),0);self.assertEqual(r[2][56:],b'\xa0')
        r=self.exchange(request('I2C',1,args=[100000]),request('I2C',2,args=[3,0,0]),mode='stop-timeout')
        self.assertEqual(self.error(r[1]),7);self.assertEqual(len(r[1]),56)

    def test_ledc_shared_timer_conflict_release_and_full_duty(self):
        r=self.exchange(request('PWM',1,0,[1000,10,0,1000]),request('PWM',1,1,[2000,10,0,500]),request('PWM',1,1,[1000,10,0,0]),request('PWM',3,0),request('PWM',2,1,[1000]),request('PWM',3,1),request('PWM',1,2,[2000,10,0,500]))
        self.assertEqual([self.status(x)==0 for x in r],[True,False,True,True,True,True,True]); self.assertEqual(self.error(r[1]),6)
        r=self.exchange(request('PWM',1,0,[1,19,0,500]))[0]
        self.assertEqual(self.status(r),0)  # divider * 2^bits exceeds 32 bits
        self.assertGreater(struct.unpack_from('<I',r,20)[0],0)

    def test_invalid_lengths_operations_and_release(self):
        for kind,port in [('I2C',0),('SPI',1),('PWM',0)]:
            r=self.exchange(request(kind,4,port),request(kind,3,port),request(kind,2,port),packet(kind+'C'),request(kind,1,port,timeout=0))
            self.assertEqual(self.status(r[0]),0);self.assertEqual(self.status(r[1]),0)
            self.assertNotEqual(self.status(r[2]),0);self.assertNotEqual(self.status(r[3]),0);self.assertNotEqual(self.status(r[4]),0)

    def test_i2c_argument_errors_identify_rejected_parameter(self):
        r=self.exchange(request('I2C',1,2,[100000]),request('I2C',1,0,[12345]),request('I2C',1,0,[100000],timeout=0))
        self.assertEqual([self.error(x) for x in r],[8,10,12])
