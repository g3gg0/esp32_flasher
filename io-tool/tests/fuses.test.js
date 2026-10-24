const test=require('node:test'),assert=require('node:assert/strict');
const {parseFuseRecords,FusesHost}=require('../fuses.js'),protocol=require('../../stub/protocol.js'),type=protocol.fuseTypes;
function record(name,kind,bits,data){const text=new TextEncoder().encode(name),out=new Uint8Array(8+text.length+data.length),v=new DataView(out.buffer);v.setUint16(0,out.length,true);out[2]=text.length;out[3]=kind;v.setUint16(4,bits,true);v.setUint16(6,data.length,true);out.set(text,8);out.set(data,8+text.length);return out;}
test('generic typed parser supports chip-selected unknown names, MAC, 128-bit ID and counters',()=>{
    const mac=record('FUSE.MAC',type.MAC,48,Uint8Array.from([17,34,51,68,85,102]));assert.equal(parseFuseRecords(mac)[0].display,'11:22:33:44:55:66');
    const uid=record('FUSE.OPTIONAL_UNIQUE_ID',type.OPTIONAL_ID,128,Uint8Array.from({length:16},(_,i)=>i));assert.equal(parseFuseRecords(uid)[0].display,'000102030405060708090A0B0C0D0E0F');
    assert.match(parseFuseRecords(record('NEW.FUSE_DEFINED_ON_TARGET',type.OPTIONAL_ID,128,new Uint8Array(16)))[0].display,/nicht gesetzt/);
    assert.match(parseFuseRecords(record('X',type.ODD_PARITY,3,Uint8Array.of(3)))[0].display,/inaktiv/);
    assert.match(parseFuseRecords(record('X',type.ODD_PARITY,3,Uint8Array.of(7)))[0].display,/^aktiv/);
    assert.match(parseFuseRecords(record('X',type.BIT_COUNT,16,Uint8Array.of(7,1)))[0].display,/^4/);
    assert.equal(parseFuseRecords(record('FUTURE.TYPE',77,0,Uint8Array.of(0xab)))[0].raw,'AB');
});
test('truncated, oversized and inconsistent TLVs are rejected before display',()=>{
    const r=record('X',type.UNSIGNED,8,Uint8Array.of(1));
    assert.throws(()=>parseFuseRecords(r.subarray(0,r.length-1)));assert.throws(()=>parseFuseRecords(Uint8Array.of(1,2)));
    const wrong=r.slice();wrong[6]=4;assert.throws(()=>parseFuseRecords(wrong));
    assert.throws(()=>parseFuseRecords(record('X',type.UNSIGNED,1,Uint8Array.of(2))));
    assert.throws(()=>parseFuseRecords(record('BAD\0NAME',type.UNSIGNED,8,Uint8Array.of(1))));
});
test('paged enumeration is driven by device records and detects repeated cursor/schema',async()=>{
    const pages=[record('CHIP.FROM_DEVICE',type.TEXT,0,new TextEncoder().encode('esp32p4')),record('FUSE.FUTURE_FIELD',type.UNSIGNED,8,Uint8Array.of(42))],calls=[];
    const transport={closed:false,supports:k=>k==='FUSES',close(){this.closed=true;},async peripheral(kind,operation,port,args){calls.push([kind,operation,args]);return operation===4?{values:[2,1,512,2,0,0,0,99],data:new Uint8Array()}:{values:[args[0],1,args[0]+1,2,0,0,0,99],data:pages[args[0]]};}};
    const host=new FusesHost({transport,active:true,queue:{run:fn=>fn()}}),rows=await host.read();assert.equal(rows[1].display,'42');assert.equal(calls.length,3);
    const original=transport.peripheral;transport.peripheral=async(...args)=>{const r=await original(...args);if(args[1]===16)r.values[2]=0;return r;};
    await assert.rejects(host.read(),/Antwortseite/);assert.equal(transport.closed,true);
});
