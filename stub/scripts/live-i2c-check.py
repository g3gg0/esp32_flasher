#!/usr/bin/env python3
"""Explicit live RAM-only check. Never writes flash, eFuses or supply controls.

Requires exclusive access to the selected serial port. Always 115200 baud.
"""
import argparse
import base64
import functools
import hashlib
import json
from pathlib import Path
import struct
import sys
import time

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'build/host-python'))
import serial
SPEC=json.loads((ROOT/'protocol.json').read_text())

def encode(name,values=None,data=b'',magic=None):
    values=values or {};p=SPEC['packets'][name];body=b''
    for field,kind,*count in p['fields']:
        n=count[0] if count else 1;v=values.get(field,[0]*n if count else 0)
        if kind=='char':body+=str(v).encode().ljust(n,b'\0');continue
        if not count:v=[v]
        body+=struct.pack('<'+{'u8':'B','u16':'H','u32':'I'}[kind]*n,*(list(v)+[0]*(n-len(v))))
    return (magic or p['magic']).encode()+struct.pack('<I',8+len(body)+len(data))+body+data

def decode(name,raw):
    if len(raw)<8 or struct.unpack_from('<I',raw,4)[0]!=len(raw):raise RuntimeError('Invalid RPC frame length')
    p=SPEC['packets'][name];o=8;r={}
    for field,kind,*count in p['fields']:
        n=count[0] if count else 1
        if kind=='char':r[field]=raw[o:o+n].split(b'\0')[0].decode();o+=n;continue
        fmt='<'+{'u8':'B','u16':'H','u32':'I'}[kind]*n;v=struct.unpack_from(fmt,raw,o);o+=struct.calcsize(fmt);r[field]=list(v) if count else v[0]
    r['data']=raw[o:];return r

class Link:
    def __init__(self,port):
        self.s=serial.Serial(port=None,baudrate=115200,timeout=.03,write_timeout=2)
        self.s.dtr=False;self.s.rts=False;self.s.port=port;self.s.open()
        self.raw=bytearray()
    def send(self,packet):self.s.write(b'\xc0'+packet.replace(b'\xdb',b'\xdb\xdd').replace(b'\xc0',b'\xdb\xdc')+b'\xc0');self.s.flush()
    def frame(self,deadline):
        buf=bytearray();started=False;escape=False
        while time.monotonic()<deadline:
            b=self.s.read(1)
            if not b:continue
            self.raw.extend(b);self.raw=self.raw[-2048:];b=b[0]
            if b==0xc0:
                if started and buf:return bytes(buf)
                started=True;buf.clear();escape=False;continue
            if not started:continue
            if escape:buf.append({0xdc:0xc0,0xdd:0xdb}.get(b,b));escape=False
            elif b==0xdb:escape=True
            else:buf.append(b)
        raise TimeoutError('No response; serial tail='+repr(bytes(self.raw[-350:])))
    def rom(self,op,data=b'',checksum=0):
        self.send(struct.pack('<BBHI',0,op,len(data),checksum)+data);deadline=time.monotonic()+3
        while True:
            r=self.frame(deadline)
            if len(r)<8 or r[0]!=1 or r[1]!=op:continue
            if r[-4:-2]!=b'\0\0':raise RuntimeError(f'ROM {op:#x}: {r.hex()}')
            return r
    def rpc(self,name,values=None,data=b'',magic=None,response=None):
        tag=(magic or SPEC['packets'][name]['magic']);reply=SPEC['packets'][response or SPEC['packets'][name].get('response',name)]['magic']
        self.send(encode(name,values,data,magic));deadline=time.monotonic()+2
        while True:
            r=self.frame(deadline)
            if r[:4]==reply.encode():return decode(response or SPEC['packets'][name].get('response',name),r)
            if r[:4]==b'ERRO':raise RuntimeError('RPC error '+r.hex())
    def reset_rom(self):
        # Installed esptool's USBJTAGSerialReset, including Windows DTR latch.
        self.s.rts=False;self.s.dtr=False;time.sleep(.1)
        self.s.dtr=True;self.s.rts=False;time.sleep(.1)
        self.s.rts=True;self.s.dtr=False;self.s.rts=True;time.sleep(.1)
        self.s.dtr=False;self.s.rts=False;time.sleep(.2);self.s.reset_input_buffer()
    def load(self,manifest):
        m=json.loads(Path(manifest).read_text());assert m['ramOnly'] and m['requiresRom']
        self.reset_rom();self.rom(8,b'\x07\x07\x12\x20'+b'\x55'*32)
        sec=self.rom(0x14,struct.pack('<I',0));chip=struct.unpack_from('<I',sec,20)[0]
        names={0:'esp32',2:'esp32s2',5:'esp32c3',9:'esp32s3',12:'esp32c2',13:'esp32c6',16:'esp32h2',18:'esp32p4',20:'esp32c61',23:'esp32c5'}
        print('ROM chip:',names.get(chip,chip),flush=True)
        if names.get(chip)!=m['chip']:raise RuntimeError(f"Chip mismatch; will not upload {m['chip']} to chip ID {chip}")
        for seg in m['segments']:
            data=base64.b64decode(seg['data']);assert hashlib.sha256(data).hexdigest()==seg['sha256'] and len(data)==seg['length']
            block=0x1800;self.rom(5,struct.pack('<4I',len(data),(len(data)+block-1)//block,block,seg['address']))
            for i,o in enumerate(range(0,len(data),block)):
                part=data[o:o+block];check=functools.reduce(lambda a,b:a^b,part,0xef)
                self.rom(7,struct.pack('<4I',len(part),i,0,0)+part,check)
        self.rom(6,struct.pack('<2I',0,m['entry']));time.sleep(.05)
        print('RAM upload acknowledged; querying SYNC',flush=True)
    def peripheral(self,op,args=None):return self.rpc('peripheral_command',{'operation':op,'port':0,'timeout_us':100000,'args':args or []},magic='I2CC',response='peripheral_response')
    def read(self,a):
        r=self.rpc('register_command',{'operation':0,'address':a},response='register_response')
        if r['status']:raise RuntimeError('REG read failed '+str(r))
        return r['value']
    def write(self,a,v,m=0xffffffff):
        r=self.rpc('register_command',{'operation':1,'address':a,'value':v&0xffffffff,'mask':m},response='register_response')
        if r['status']:raise RuntimeError('REG write failed '+str(r))

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--port',required=True);parser.add_argument('--manifest');parser.add_argument('--pins',type=Path);parser.add_argument('--scan',action='store_true');a=parser.parse_args()
    link=Link(a.port);saved={}
    def set_(addr,value,mask):
        old,known=saved.get(addr,(0,0));fresh=mask&~known
        if fresh:old|=link.read(addr)&fresh;saved[addr]=(old,known|mask)
        link.write(addr,value,mask)
    try:
        print(a.port,'115200 baud',flush=True)
        if a.manifest:link.load(a.manifest)
        identity=link.rpc('sync');print('IDENT:',json.dumps({k:v for k,v in identity.items() if k not in ('data','mac')}),flush=True)
        if not a.scan:return
        if not a.pins:raise RuntimeError('--pins profile required for explicit I2C routing')
        p=json.loads(a.pins.read_text());g=p['gpio'];info=link.peripheral(4)
        if info['status']:raise RuntimeError('I2C INFO failed')
        v=info['values'];r=link.peripheral(1,[100000]);assert not r['status']
        for role,pin in enumerate(p['pins']):
            n=pin['id'];b=g['banks'][n//32];bit=1<<(n%32)
            set_(b['enable'],0,bit)
            for route in pin['digitalRoute']:set_(route['address'],0,route['mask'])
            set_(g['pinConfig']+n*4,4,g['pinConfigMask']);set_(pin['mux'],g['muxGPIO']|g['pullUp'],g['muxMask'])
            set_(v[4]+v[role*2+1]*4,n|128,255);set_(g['matrix']+n*4,v[role*2],g['matrixMask']);set_(b['enable'],bit,bit)
        found=[]
        for address in range(3,0x78):
            r=link.peripheral(2,[address,0,0])
            if not r['status']:found.append(address);print(f'{address:#04x} ACK',flush=True)
            elif r['error']!=1:raise RuntimeError(f'{address:#04x}: '+str(r))
        print('SCAN:',[hex(x) for x in found],flush=True)
        if 0x18 in found:
            r=link.peripheral(2,[0x18,1,1]) if False else link.rpc('peripheral_command',{'operation':2,'port':0,'timeout_us':100000,'args':[0x18,1,1]},b'\0',magic='I2CC',response='peripheral_response')
            assert not r['status'];print('0x18 register 0:',r['data'].hex(),flush=True)
    finally:
        if a.scan and saved:
            try:
                link.peripheral(3)
                for addr,(value,mask) in reversed(list(saved.items())):link.write(addr,value,mask)
            except Exception as e:print('Restore failed:',e,flush=True)
        link.s.close()
if __name__=='__main__':main()
