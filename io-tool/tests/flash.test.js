const test=require('node:test'),assert=require('node:assert/strict');
const {FlashHost,flashRange}=require('../flash.js'),op=require('../../stub/protocol.js').flashOperations;
function fixture(){
    const memory=new Uint8Array(16384).fill(255),calls=[];
    const transport={closed:false,supports:()=>true,close(){this.closed=true;},async peripheral(kind,operation,port,args,data){
        calls.push({operation,args,data:data.slice()});const [a,n]=args,values=new Array(8).fill(0);values[0]=n;
        if(operation===op.INFO)return{values:[0x1440ef,memory.length,4096,256,768,0,memory.length,1],data:new Uint8Array()};
        if(operation===op.READ)return{values,data:memory.slice(a,a+n)};
        if(operation===op.ERASE)memory.fill(255,a,a+n);
        if(operation===op.WRITE){for(let i=0;i<n;i++)if((memory[a+i]&data[i])!==data[i])throw new Error('NEEDS_ERASE');memory.set(data,a);}
        if(operation===op.VERIFY)assert.deepEqual(memory.slice(a,a+n),data);
        return{values,data:new Uint8Array()};
    }};
    const host=new FlashHost({transport,active:true,queue:{run:fn=>fn()}});return{host,memory,calls,transport};
}
test('flash ranges reject wraparound, misalignment and out of device writes',()=>{
    for(const args of [[-1,4,4096],[0,0,4096],[4092,8,4096],[0xffffffff,4,4096],[1,4,4096],[0,3,4096],[0,Infinity,4096]])assert.throws(()=>flashRange(...args));
    assert.deepEqual(flashRange(4092,4,4096),{address:4092,length:4,end:4096});
});
test('program preserves both partial sector edges and verifies all affected bytes',async()=>{
    const {host,memory,calls}=fixture();memory.set(Uint8Array.from({length:8192},(_,i)=>i&255));const original=memory.slice();
    await host.probe();const bytes=new Uint8Array(4101).fill(0xa5),progress=[];
    await host.program(3,new Blob([bytes]),{onProgress:n=>progress.push(n)});
    assert.deepEqual(memory.slice(0,3),original.slice(0,3));assert.deepEqual(memory.slice(3,4104),bytes);assert.deepEqual(memory.slice(4104),original.slice(4104));
    assert.equal(calls.filter(c=>c.operation===op.ERASE).length,2);assert.equal(calls.filter(c=>c.operation===op.VERIFY).length,12);
    assert.equal(progress.at(-1),bytes.length);await host.verify(3,new Blob([bytes]));
    memory[10]^=1;await assert.rejects(host.verify(3,new Blob([bytes])),/0xa/);
});
test('without erase, programming cannot set zero bits to one; cancellation finishes the active sector',async()=>{
    const a=fixture();await a.host.probe();a.memory[100]=0;
    await assert.rejects(a.host.program(100,new Blob([Uint8Array.of(255)]),{erase:false}),/NEEDS_ERASE/);
    assert.ok(!a.calls.some(c=>c.operation===op.ERASE));
    const b=fixture();await b.host.probe();const abort=new AbortController();
    await assert.rejects(b.host.program(0,new Blob([new Uint8Array(8192)]),{signal:abort.signal,onProgress:()=>abort.abort()}),{name:'AbortError'});
    assert.ok(b.memory.slice(0,4096).every(b=>b===0));assert.ok(b.memory.slice(4096).every(b=>b===255));
    assert.equal(b.calls.filter(c=>c.operation===op.ERASE).length,1);
});
test('download streams bounded exact bytes; invalid responses close the transport',async()=>{
    const {host,memory,transport}=fixture();await host.probe();memory.set(Uint8Array.from({length:memory.length},(_,i)=>i&255));const chunks=[];
    await host.download(4,8192,{write:async b=>chunks.push(b)});assert.deepEqual(chunks[0],memory.slice(4,8196));
    transport.peripheral=async()=>({values:[4],data:new Uint8Array(3)});
    await assert.rejects(host.read(0,4),/unvoll/);assert.equal(transport.closed,true);
});
