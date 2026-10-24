"""Device supplies named typed records; exercise the actual shared engine on every profile."""
from pathlib import Path
import struct
import subprocess
import tempfile
import unittest
from test_wire import ROOT,frame,unframe
from test_peripheral import request

class FusesTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp=tempfile.TemporaryDirectory();cls.executables={}
        for p in sorted(ROOT.glob('esp32*/target.json')):
            chip=p.parent.name;exe=Path(cls.temp.name)/chip
            flags=['-DRPC_FUSES_TEST=1',f'-DCONFIG_IDF_TARGET_{chip.upper()}=1',f'-DSTUB_CHIP="{chip}"','-DSTUB_CPU="test"','-DSTUB_CORES=1','-DSTUB_IDF="6.1"']
            subprocess.run(['cc','-std=c11','-Os','-Wall','-Wextra','-Werror','-fno-builtin',*flags,'-ffunction-sections','-fdata-sections','-Wl,--gc-sections','-I',str(ROOT/'include'),'-I',str(ROOT/'src'),*[str(ROOT/'src'/n) for n in ('stub.c','fuses.c','flash.c','rmt.c','peripheral.c','sdmmc.c','capture.c','adc_calibration.c')],str(ROOT/'tests/host-platform.c'),str(ROOT/'tests/fuses-mock.c'),'-o',str(exe)],check=True)
            cls.executables[chip]=exe
    @classmethod
    def tearDownClass(cls):cls.temp.cleanup()
    def exchange(self,chip,*requests):
        result=subprocess.run([self.executables[chip]],input=b''.join(frame(r) for r in requests),capture_output=True,check=True)
        replies=unframe(result.stdout);self.assertEqual(len(replies),len(requests))
        for r in replies:self.assertEqual(r[:4],b'FUSR');self.assertEqual(len(r),struct.unpack_from('<I',r,4)[0])
        return replies
    def test_each_chip_defines_complete_paged_records_without_host_register_knowledge(self):
        for chip in self.executables:
            info=self.exchange(chip,request('FUS',4))[0];total,version,size=struct.unpack_from('<3I',info,24)
            self.assertEqual(version,1);self.assertEqual(size,512);cursor=0;records={}
            while cursor<total:
                reply=self.exchange(chip,request('FUS',16,args=[cursor,192]))[0];self.assertEqual(struct.unpack_from('<I',reply,8)[0],0)
                start,count,next_,reported=struct.unpack_from('<4I',reply,24);self.assertEqual(start,cursor);self.assertEqual(reported,total);self.assertGreater(next_,cursor)
                pos=56;seen=0
                while pos<len(reply):
                    length,namesize,type_,bits,datasize=struct.unpack_from('<HBBHH',reply,pos);self.assertEqual(length,8+namesize+datasize)
                    name=reply[pos+8:pos+8+namesize].decode();data=reply[pos+8+namesize:pos+length]
                    self.assertNotIn(name,records);records[name]=(type_,bits,data);seen+=1;pos+=length
                self.assertEqual(seen,count);cursor=next_
            self.assertEqual(len(records),total);self.assertEqual(records['CHIP.MODEL'][2],chip.encode())
            self.assertIn('FUSE.MAC',records);self.assertIn('ROM.ECO_VERSION',records)
            self.assertNotIn('FUSE.KEY0',records)
            if chip=='esp32p4':
                self.assertEqual(records['FUSE.MAC'],(6,48,bytes.fromhex('112233445566')))
                self.assertEqual(records['ROM.FLASH_LAYOUT'][2],b'ECO5+')
                self.assertEqual(struct.unpack('<I',records['ROM.FLASH_DATA_SLOT'][2])[0],0x4ffbffe8)
                self.assertEqual(records['FUSE.OPTIONAL_UNIQUE_ID'][1],128)
    def test_unknown_and_write_operations_never_expose_writable_controller_access(self):
        for r in self.exchange('esp32p4',request('FUS',18),request('FUS',1),request('FUS',16,args=[0xffffffff,512]),request('FUS',16,args=[0,191]),request('FUS',16,args=[0,513]),request('FUS',4,data=b'X')):
            self.assertNotEqual(struct.unpack_from('<I',r,8)[0],0);self.assertEqual(len(r),56)
