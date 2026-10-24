"""Actual shared stream engine: hardware ring consumer verifies every symbol."""
import os
from pathlib import Path
import struct
import subprocess
import tempfile
import unittest
from test_wire import ROOT,frame,unframe
from test_peripheral import request

class RMTTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp=tempfile.TemporaryDirectory();cls.exe=Path(cls.temp.name)/'rmt-test'
        subprocess.run(['cc','-std=c11','-Os','-Wall','-Wextra','-Werror','-fno-builtin','-DRPC_RMT_TEST=1','-ffunction-sections','-fdata-sections','-Wl,--gc-sections','-I',str(ROOT/'include'),'-I',str(ROOT/'src'),*[str(ROOT/'src'/n) for n in ('stub.c', 'flash.c','rmt.c','peripheral.c','sdmmc.c','capture.c','adc_calibration.c')],str(ROOT/'tests/host-platform.c'),str(ROOT/'tests/rmt-mock.c'),'-o',str(cls.exe)],check=True)
    @classmethod
    def tearDownClass(cls):cls.temp.cleanup()
    def exchange(self,requests,env=None):
        replies=unframe(subprocess.run([self.exe],input=b''.join(frame(r) for r in requests),capture_output=True,check=True,env={**os.environ,**(env or {})}).stdout)
        self.assertEqual(len(replies),len(requests))
        for r in replies:self.assertEqual(r[:4],b'RMTR');self.assertEqual(len(r),56)
        return replies
    def upload(self,data,count,encoding=0,dictionary=(),repeat=1):
        return [request('RMT',1,args=[1000000,0]),request('RMT',16,args=[encoding,count,len(data),*dictionary]),*[request('RMT',17,args=[o],data=data[o:o+768]) for o in range(0,len(data),768)],request('RMT',18,args=[repeat,80],timeout=1500000)]
    def test_raw_streams_cross_half_ring_and_end_boundaries(self):
        for words in (8,48,64):
            for n in (words-1,words,words+1,511,1024):
                pattern=[(10+i%5)|0x8000|((15+i%7)<<16) for i in range(n)];data=struct.pack('<'+'I'*n,*pattern)
                r=self.exchange(self.upload(data,n),{'RMT_WORDS':str(words),'RMT_EXPECT':''.join(f'{w:08x}' for w in pattern),'RMT_COUNT':str(n),'RMT_TOTAL':str(n)})[-1]
                self.assertEqual(struct.unpack_from('<I',r,8)[0],0);self.assertEqual(struct.unpack_from('<I',r,24)[0],n)
                if n>=words:self.assertGreater(struct.unpack_from('<I',r,28)[0],0)
    def test_bitmap_max_buffer_and_repeat_preserve_exact_symbol_stream(self):
        n=32768;data=bytes((i*37)&255 for i in range(4096));dictionary=[0x00128007,0x000b800e]
        r=self.exchange(self.upload(data,n,1,dictionary),{'RMT_WORDS':'48','RMT_BITS':data.hex(),'RMT_EXPECT':''.join(f'{w:08x}' for w in dictionary),'RMT_COUNT':str(n),'RMT_TOTAL':str(n)})[-1]
        self.assertEqual(struct.unpack_from('<I',r,8)[0],0);self.assertEqual(struct.unpack_from('<I',r,24)[0],n)
        data=bytes([0x55]);n=8
        r=self.exchange(self.upload(data,n,1,dictionary,3),{'RMT_BITS':data.hex(),'RMT_EXPECT':''.join(f'{w:08x}' for w in dictionary),'RMT_COUNT':'8','RMT_TOTAL':'24'})[-1]
        self.assertEqual(struct.unpack_from('<I',r,24)[0],24)
    def test_invalid_offset_capacity_and_unfinished_upload_are_rejected(self):
        r=self.exchange([request('RMT',1,args=[1000000]),request('RMT',16,args=[0,1025,4100]),request('RMT',16,args=[0,2,8]),request('RMT',17,args=[1],data=b'1234'),request('RMT',18,args=[1,0])])
        for x in r[1:2]+r[3:]:self.assertNotEqual(struct.unpack_from('<I',x,8)[0],0)
    def test_timeout_underrun_and_hardware_error_never_claim_complete(self):
        pattern=[0x00128007]*64;data=struct.pack('<64I',*pattern)
        for mode in ('timeout','underrun','error'):
            r=self.exchange(self.upload(data,64),{'RMT_MODE':mode})[-1]
            self.assertNotEqual(struct.unpack_from('<I',r,8)[0],0);self.assertEqual(struct.unpack_from('<I',r,24)[0],0)
    def test_invalid_zero_duration_and_clock_budget_fail_before_start(self):
        for word in (0,0x8000,0x10000):
            r=self.exchange(self.upload(struct.pack('<I',word),1))[-1];self.assertNotEqual(struct.unpack_from('<I',r,8)[0],0)
