#!/usr/bin/env python3
"""Explicit live RAM upload and read-only flash probe/check at 115200 baud.

Requires an explicitly selected port. Never sends flash write/erase commands.
"""
import argparse
import importlib.util
from pathlib import Path
import time
import zlib

ROOT=Path(__file__).resolve().parents[1]
module_spec=importlib.util.spec_from_file_location('live_io',ROOT/'scripts/live-i2c-check.py')
live=importlib.util.module_from_spec(module_spec);module_spec.loader.exec_module(live)

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--port',required=True);parser.add_argument('--chip',default='esp32p4');parser.add_argument('--no-reset',action='store_true');args=parser.parse_args()
    link=live.Link(args.port)
    from serial.tools import list_ports
    port=next((p for p in list_ports.comports() if p.device.lower()==args.port.lower()),None)
    if port and port.vid!=0x303a:
        def uart_reset():
            def pins(dtr,rts):
                if hasattr(link.s,'_reconfigure_port'):
                    # Apply both lines in one Windows DCB update, matching
                    # Web Serial setSignals on the board's transistor circuit.
                    link.s._dtrState=dtr;link.s._rtsState=rts;link.s._reconfigure_port()
                else:link.s.dtr=dtr;link.s.rts=rts
            link.s.reset_input_buffer()
            pins(False,False);pins(True,True);pins(False,True);time.sleep(.05)
            pins(True,False);time.sleep(.1);pins(False,False);time.sleep(.2)
        link.reset_rom=uart_reset
    if args.no_reset:link.reset_rom=lambda:None
    def command(operation,values):
        if operation not in (4,16,19,21):raise ValueError('Read-only operations only')
        link.send(live.encode('peripheral_command',{'operation':operation,'port':0,'timeout_us':2000000,'args':values},magic='FLAC'))
        raw=link.frame(time.monotonic()+4)
        if raw[:4]!=b'FLAR':raise RuntimeError('Unexpected packet '+raw.hex())
        reply=live.decode('peripheral_response',raw)
        if reply['status']:raise RuntimeError(str(reply))
        return reply
    try:
        link.load(ROOT/args.chip/'stub.json')
        identity=link.rpc('sync');print('SYNC:',identity,flush=True)
        names=['ROM context','clock / ROM attach','ROM read mode','JEDEC ID','ROM geometry','status register']
        for step,name in enumerate(names):
            print(f'FLASH phase {step}: {name} START',flush=True)
            reply=command(21,[step]);print('  OK',reply['values'],flush=True)
        read=command(16,[0,256]);check=command(19,[0,256])
        assert len(read['data'])==256 and zlib.crc32(read['data'])==check['values'][1]
        print('READ / CHECK: 256 bytes, matching CRC32; no flash modifications.',flush=True)
    finally:link.s.close()

if __name__=='__main__':main()
