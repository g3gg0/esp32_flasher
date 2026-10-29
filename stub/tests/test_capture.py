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

def setup(command_mask=0):
    units=[1,1000,1,0x60000304,30,10,*([0]*9),1,15,0,255]
    return encode('adc_setup',{'operation':6,'init_count':1,'analog_count':1,'unit_count':1,'bus_control':0x60000200,'bus_command_mask':command_mask,'block':0x69,'major':[0x60000300,0,2],'version_min':1,'version_exact':1,'units':units},struct.pack('<6I',0x60000400,0x33,0xff,2,7,15))

def plan(slot=0,pin=5):
    return encode('capture_plan',{'operation':2,'slot':slot,'pin':pin,'low_us':10,'steps':[0x60000100,0,1,0x60000104,16,0xffffffff,0x60000100,1,1],'wait_addr':0x60000108,'wait_mask':16,'data_addr':0x6000010c,'data_mask':4095,'cleanup_addr':0x60000100,'cleanup_mask':1})

class CaptureTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp=tempfile.TemporaryDirectory();cls.exe=Path(cls.temp.name)/'capture-test'
        subprocess.run(['cc','-std=c11','-Os','-Wall','-Wextra','-Werror','-fno-builtin','-DRPC_CAPTURE_TEST=1',*getattr(cls,'extra_flags',[]),'-ffunction-sections','-fdata-sections','-Wl,--gc-sections','-I',str(ROOT/'include'),'-I',str(ROOT/'src'),*[str(ROOT/'src'/n) for n in ('stub.c', 'fuses.c', 'flash.c','capture.c','adc_calibration.c','peripheral.c','sdmmc.c','rmt.c')],str(ROOT/'tests/host-platform.c'),str(ROOT/'tests/capture-mock.c'),'-o',str(cls.exe)],check=True)
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


    def step(self, **updates):
        q=dict(pin=5,slot=65535,min_delay_ns=1000,max_delay_us=4,settle_us=4,repetitions=2,mode_mask=31,mux_addr=0x60000518,pull_up=256,pull_down=128,output_addr=0x60000500,enable_addr=0x60000504,enable_set_addr=0x60000510,enable_clear_addr=0x60000514,set_addr=0x60000508,clear_addr=0x6000050c,input_addr=0x6000051c,bit_mask=32)
        q.update(updates)
        return encode('step_command',q)
    def record_values(self,r):
        start=8+sum({'u16':2,'u32':4}[t]*(n[0] if n else 1) for _,t,*n in SPEC['packets']['step_response']['fields'])
        return [struct.unpack_from('<HI',r,i) for i in range(start,len(r),6)]
    def test_both_edges_all_modes_averaged_in_one_bounded_packet(self):
        r=self.exchange(self.step())[0]
        self.assertEqual(r[:4],b'STPR');self.assertEqual(self.status(r),0)
        values=self.record_values(r);self.assertEqual(len(values),30)
        self.assertEqual([v for v,_ in values[:15]],[0]*15)
        self.assertEqual([v for v,_ in values[15:]],[16]*15)
        self.assertTrue(all(ns>=1000*(2**(i%3)) for i,(_,ns) in enumerate(values)))
        self.assertLessEqual(len(r),1024)
    def test_native_pin_state_is_restored_on_success_and_adc_timeout(self):
        inspect=command(1,3,data=struct.pack('<3I',0x60000500,0x60000504,0x60000518))
        for adc,mode in [(False,''),(True,'timeout')]:
            requests=([setup(),plan()] if adc else [])+[self.step(slot=0 if adc else 65535),inspect,command(3,selection=7)]
            r=self.exchange(*requests,mode=mode)
            self.assertEqual(self.status(r[-3]),4 if adc else 0)
            self.assertEqual([v[2] for v in self.samples(r[-1])],[32,32,0x80008800])
    def test_native_adc_average_and_latency_are_reported(self):
        r=self.exchange(setup(),plan(),self.step(slot=0,mode_mask=2))[2]
        self.assertEqual(self.status(r),0)
        self.assertEqual(self.record_values(r)[0][0],0x103*16)
        self.assertTrue(self.record_values(r)[0][1]>1000)
    def test_adc_start_low_preparation_is_before_edge_not_after_delay(self):
        # The host mock counts cycles in whole us. Its GPIO/ADC register access
        # overhead is included, but the plan's 10-us preparation must not be.
        r=self.exchange(setup(),plan(),self.step(slot=0,mode_mask=2,min_delay_ns=1000,max_delay_us=1,settle_us=100,repetitions=1))[2]
        self.assertEqual(self.status(r),0)
        values=self.record_values(r)
        self.assertEqual(len(values),2)
        for _,ns in values:
            self.assertGreaterEqual(ns,1000)
            self.assertLess(ns,10000)
    def test_adc_trigger_is_measured_separately_from_slow_conversion(self):
        r=self.exchange(setup(),plan(),self.step(slot=0,mode_mask=2,min_delay_ns=1000,max_delay_us=1,repetitions=2),mode='slow-adc')[2]
        self.assertEqual(self.status(r),0)
        header_size=8+sum({'u16':2,'u32':4}[t]*(n[0] if n else 1) for _,t,*n in SPEC['packets']['step_response']['fields'])
        trigger=struct.unpack_from('<H',r,header_size-2)[0]
        self.assertGreaterEqual(trigger,1000)
        self.assertLess(trigger,10000)
        self.assertGreater(self.record_values(r)[0][1],20000)
    def test_rejects_oversized_scans_bad_slot_registers_and_unbounded_times(self):
        for args in [dict(repetitions=0),dict(mode_mask=32),dict(min_delay_ns=1,max_delay_us=10000),dict(settle_us=1000000),dict(slot=24),dict(mux_addr=0x40000000),dict(bit_mask=64)]:
            r=self.exchange(self.step(**args))[0];self.assertNotEqual(self.status(r),0)


class C6CalibrationTest(unittest.TestCase):
    extra_flags=['-DRPC_C6_CAL_TEST=1']
    setUpClass=classmethod(CaptureTest.setUpClass.__func__)
    tearDownClass=classmethod(CaptureTest.tearDownClass.__func__)
    exchange=CaptureTest.exchange
    status=CaptureTest.status
    samples=CaptureTest.samples
    step=CaptureTest.step
    def test_c6_clock_and_fsm_are_native_and_restored(self):
        inspect=command(1,2,data=struct.pack('<2I',0x60000620,0x60000624))
        r=self.exchange(inspect,setup(),command(3,selection=3),command(7),command(3,selection=3))
        self.assertEqual(self.status(r[1]),0)
        self.assertEqual([x[2] for x in self.samples(r[2])],[0x0050f040,0x00640805])
        self.assertEqual([x[2] for x in self.samples(r[4])],[0,0])
    def test_c6_stabilizes_channel_once_before_repeated_edge_captures(self):
        inspect=command(1,3,data=struct.pack('<3I',0x60000630,0x60000634,0x60000100))
        r=self.exchange(setup(),plan(),self.step(slot=0,mode_mask=2),inspect,command(3,selection=7),command(7),command(3,selection=7))
        self.assertEqual(self.status(r[2]),0)
        values=[x[2] for x in self.samples(r[4])]
        self.assertEqual(values[:2],[1,1]) # one 50-us stabilization, one enable
        self.assertNotEqual(values[2]&(1<<31),0)
        self.assertEqual(self.samples(r[6])[2][2]&(1<<31),0)
    def test_cold_c6_bus_is_enabled_reset_and_restored(self):
        inspect=command(1,3,data=struct.pack('<3I',0x600af018,0x600af01c,0x600b0154))
        r=self.exchange(inspect,setup(command_mask=1<<26),command(3,selection=7),command(7),command(3,selection=7),mode='c6-cold')
        self.assertEqual(self.status(r[1]),0)
        self.assertEqual([x[2] for x in self.samples(r[2])],[0x84,0x44,0x0c000123])
        self.assertEqual([x[2] for x in self.samples(r[4])],[0x80,0x40,0x0c000123])
    def test_error_details_preserve_efuse_version_and_readback_values(self):
        r=self.exchange(setup(),mode='ignored-write')[0]
        status,count,slot,duration,detail=struct.unpack_from('<IHHII',r,8)
        self.assertEqual(status,5)
        self.assertEqual(count,0)
        self.assertEqual(slot,0x0302)
        self.assertEqual(detail&65535,1)
        self.assertEqual((detail>>16)&255,7)
        self.assertEqual(detail>>24,5)
