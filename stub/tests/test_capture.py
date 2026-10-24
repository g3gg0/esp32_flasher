"""Actual native batched capture/calibration code with a bounded register model."""
import os
from pathlib import Path
import struct
import subprocess
import tempfile
import unittest
from test_wire import ROOT, SPEC, frame, unframe

def encode(name, values=None, trailing=b''):
    values=values or {};p=SPEC['packets'][name];payload=b''
    for field,kind,*count in p['fields']:
        n=count[0] if count else 1;v=values.get(field,[0]*n if count else 0)
        if not count:v=[v]
        payload+=struct.pack('<'+{'u16':'H','u32':'I','u8':'B'}[kind]*n,*(list(v)+[0]*(n-len(v))))
    return p['magic'].encode()+struct.pack('<I',8+len(payload)+len(trailing))+payload+trailing

def command(op,count=0,selection=0,data=b''):return encode('capture_command',{'operation':op,'count':count,'selection':selection},data)

def setup():
    units=[1,1000,1,0x60000304,30,10,*([0]*9),1,15,0,255]
    return encode('adc_setup',{'operation':6,'init_count':1,'analog_count':1,'unit_count':1,'bus_control':0x60000200,'block':0x69,'major':[0x60000300,0,2],'version_min':1,'version_exact':1,'units':units},struct.pack('<6I',0x60000400,0x33,0xff,2,7,15))

def plan(slot=0,pin=5):
    return encode('capture_plan',{'operation':2,'slot':slot,'pin':pin,'low_us':10,'steps':[0x60000100,0,1,0x60000104,16,0xffffffff,0x60000100,1,1],'wait_addr':0x60000108,'wait_mask':16,'data_addr':0x6000010c,'data_mask':4095,'cleanup_addr':0x60000100,'cleanup_mask':1})

class CaptureTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp=tempfile.TemporaryDirectory();cls.exe=Path(cls.temp.name)/'capture-test'
        subprocess.run(['cc','-std=c11','-Os','-Wall','-Wextra','-Werror','-fno-builtin','-DRPC_CAPTURE_TEST=1','-ffunction-sections','-fdata-sections','-Wl,--gc-sections','-I',str(ROOT/'include'),'-I',str(ROOT/'src'),*[str(ROOT/'src'/n) for n in ('stub.c', 'flash.c','capture.c','adc_calibration.c','peripheral.c','sdmmc.c','rmt.c')],str(ROOT/'tests/host-platform.c'),str(ROOT/'tests/capture-mock.c'),'-o',str(cls.exe)],check=True)
    @classmethod
    def tearDownClass(cls):cls.temp.cleanup()
    def exchange(self,*requests,mode=''):
        replies=unframe(subprocess.run([self.exe],input=b''.join(frame(r) for r in requests),capture_output=True,check=True,env={**os.environ,'CAPTURE_TEST_MODE':mode}).stdout)
        self.assertEqual(len(requests),len(replies))
        for r in replies:self.assertEqual(len(r),struct.unpack_from('<I',r,4)[0])
        return replies
    def status(self,r):return struct.unpack_from('<I',r,8)[0]
    def samples(self,r):return [struct.unpack_from('<HHII',r,o) for o in range(24,len(r),12)]
    def test_gpio_banks_in_one_reply_and_selection_bounds(self):
        r=self.exchange(command(1,2,data=struct.pack('<2I',0x60000000,0x60000004)),command(3,selection=3),command(3,selection=4))
        self.assertEqual(self.status(r[0]),0);self.assertEqual([(s[0],s[2]) for s in self.samples(r[1])],[(0,0x12345678),(1,0x89abcdef)])
        self.assertEqual(self.status(r[2]),3)
    def test_calibration_cross_word_efuse_and_native_restoration(self):
        gpio=command(1,3,data=struct.pack('<3I',0x60000210,0x60000214,0x60000400))
        r=self.exchange(gpio,setup(),command(3,selection=7),command(7),command(3,selection=7))
        self.assertEqual(self.status(r[1]),0);self.assertEqual(self.samples(r[1])[0][2],1343)
        self.assertEqual([x[2] for x in self.samples(r[-1])],[0xa5,0xa5,0xa5a5a5a5])
        self.assertNotEqual(self.samples(r[2]),self.samples(r[-1]))
    def test_native_sweep_discards_switched_channel_then_reuses_same_channel(self):
        r=self.exchange(setup(),plan(),command(4,selection=1),command(4,selection=1))
        self.assertEqual([self.status(x) for x in r],[0,0,0,0]);self.assertEqual(self.samples(r[2])[0][2],0x102);self.assertEqual(self.samples(r[3])[0][2],0x103)
        self.assertEqual(self.samples(r[2])[0][:2],(5,1))
    def test_no_adc_without_initialization_and_failure_has_no_partial_values(self):
        r=self.exchange(plan(),command(4,selection=1));self.assertEqual(self.status(r[1]),3)
        r=self.exchange(setup(),plan(),command(4,selection=1),command(1,1,data=struct.pack('<I',0x60000100)),command(3,selection=1),mode='timeout')
        self.assertEqual(self.status(r[2]),4);self.assertEqual(self.samples(r[2]),[]);self.assertEqual(self.samples(r[-1])[0][2]&1,0)
    def test_invalid_efuse_version_and_busy_calibration_restore_registers(self):
        gpio=command(1,1,data=struct.pack('<I',0x60000400))
        for mode,status in [('old-version',3),('busy',5)]:
            r=self.exchange(gpio,setup(),command(3,selection=1),mode=mode)
            self.assertEqual(self.status(r[1]),status);self.assertEqual(self.samples(r[1]),[]);self.assertEqual(self.samples(r[-1])[0][2],0xa5a5a5a5)
    def test_malformed_config_and_outside_register_window(self):
        r=self.exchange(command(1,1,data=struct.pack('<I',0x40000000)),plan(slot=24),command(1,5,data=b'\0'*20))
        self.assertTrue(all(self.status(x)!=0 for x in r))
