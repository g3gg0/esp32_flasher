"""Shared parser/flash engine with independent flash memory and CRC reference."""
import os
from pathlib import Path
import struct
import subprocess
import tempfile
import unittest
import zlib
from test_wire import ROOT,frame,unframe
from test_peripheral import request

class FlashTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp=tempfile.TemporaryDirectory();cls.exe=Path(cls.temp.name)/'flash-test'
        subprocess.run(['cc','-std=c11','-Os','-Wall','-Wextra','-Werror','-fno-builtin','-DRPC_FLASH_TEST=1','-ffunction-sections','-fdata-sections','-Wl,--gc-sections','-I',str(ROOT/'include'),'-I',str(ROOT/'src'),*[str(ROOT/'src'/n) for n in ('stub.c','flash.c','rmt.c','peripheral.c','sdmmc.c','capture.c','adc_calibration.c')],str(ROOT/'tests/host-platform.c'),str(ROOT/'tests/flash-mock.c'),'-o',str(cls.exe)],check=True)
    @classmethod
    def tearDownClass(cls):cls.temp.cleanup()
    def exchange(self,*requests,**env):
        replies=unframe(subprocess.run([self.exe],input=b''.join(frame(r) for r in requests),capture_output=True,check=True,env={**os.environ,**env}).stdout)
        self.assertEqual(len(replies),len(requests))
        for r in replies:self.assertEqual(r[:4],b'FLAR');self.assertEqual(len(r),struct.unpack_from('<I',r,4)[0])
        return replies
    def status(self,r):return struct.unpack_from('<I',r,8)[0]
    def value(self,r,index):return struct.unpack_from('<I',r,24+index*4)[0]
    def test_read_write_verify_crc_and_erase(self):
        data=bytes(range(256));probe=request('FLA',4);write=request('FLA',17,args=[4096,256],data=data)
        replies=self.exchange(probe,write,request('FLA',16,args=[4096,768]),request('FLA',20,args=[4096,256],data=data),request('FLA',19,args=[0,65536]),request('FLA',18,args=[4096,4096]),request('FLA',19,args=[0,65536]))
        self.assertTrue(all(self.status(r)==0 for r in replies));self.assertEqual(replies[2][56:],data+b'\xff'*512)
        memory=bytearray(b'\xff'*65536);memory[4096:4352]=data
        self.assertEqual(self.value(replies[4],1),zlib.crc32(memory));self.assertEqual(self.value(replies[4],2),4096)
        self.assertEqual(self.value(replies[6],1),zlib.crc32(b'\xff'*65536));self.assertEqual(self.value(replies[6],2),0xffffffff)
    def test_absent_flash_not_probed_and_overflow_never_modify_memory(self):
        self.assertNotEqual(self.status(self.exchange(request('FLA',16,args=[0,4]))[0]),0)
        self.assertNotEqual(self.status(self.exchange(request('FLA',4),NO_FLASH='1')[0]),0)
        bad=[request('FLA',16,args=[0xffffffff,4]),request('FLA',18,args=[1,4096]),request('FLA',18,args=[0,8192]),request('FLA',16,args=[131068,8]),request('FLA',17,args=[0,260],data=b'\0'*260),request('FLA',20,args=[0,8],data=b'\0'*4)]
        replies=self.exchange(request('FLA',4),*bad,request('FLA',19,args=[0,65536]))
        self.assertTrue(all(self.status(r)!=0 for r in replies[1:-1]));self.assertEqual(self.value(replies[-1],2),0xffffffff)
    def test_zero_to_one_requires_erase_and_verify_reports_exact_address(self):
        replies=self.exchange(request('FLA',4),request('FLA',17,args=[16,4],data=b'\x00'*4),request('FLA',17,args=[16,4],data=b'\xff'*4),request('FLA',20,args=[16,4],data=b'\0\0\x01\0'))
        self.assertEqual(struct.unpack_from('<I',replies[2],16)[0],5);self.assertEqual(self.value(replies[2],1),16)
        self.assertEqual(struct.unpack_from('<I',replies[3],16)[0],6);self.assertEqual(self.value(replies[3],1),18)
