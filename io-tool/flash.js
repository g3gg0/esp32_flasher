(function(root){
    'use strict';
    const node=typeof module==='object'&&module.exports;
    const protocol=node?require('../stub/protocol.js'):root.ESPIO.rpcProtocol,op=protocol.flashOperations;
    const abort=signal=>{if(signal?.aborted)throw new DOMException('Flash-Vorgang abgebrochen.','AbortError');};
    function flashRange(address,length,capacity,alignment=4){
        if(![address,length,capacity].every(Number.isSafeInteger)||address<0||length<=0||address>=capacity||length>capacity-address||address%alignment||length%alignment)throw new Error(`Flash: Bereich außerhalb des erkannten Speichers oder nicht an ${alignment} Byte ausgerichtet.`);
        return{address,length,end:address+length};
    }
    class FlashHost{
        constructor(controller){this.controller=controller;this.transport=controller.transport;this.info=null;}
        run(fn){return this.controller.queue.run(async()=>{if(!this.controller.active||this.controller.fault||!this.transport.supports?.('FLASH'))throw new Error('Flash: aktuellen beschleunigten Stub laden.');return fn();});}
        async call(operation,address=0,length=0,data=new Uint8Array()){
            const r=await this.transport.peripheral('FLASH',operation,0,[address,length],data,operation===op.ERASE?10000000:2000000);
            const expected=operation===op.READ?length:0;
            if(r.data.length!==expected||(operation!==op.INFO&&r.values[0]!==length)){this.transport.close();throw new Error('Flash: unvollständige Antwort; neu verbinden.');}
            return r;
        }
        probe(){return this.run(async()=>{this.info=null;const r=await this.call(op.INFO),v=r.values;
            if(!v[0]||v[2]!==4096||v[3]!==256||v[4]<4||v[4]>768||v[6]>v[1]||v[6]<4096){this.transport.close();throw new Error('Flash: ungültige Geometrie.');}
            return this.info={id:v[0],size:v[1],sector:v[2],page:v[3],chunk:v[4]&~3,status:v[5],capacity:v[6]};
        });}
        range(address,length,alignment=4){if(!this.info)throw new Error('Flash zuerst erkennen.');return flashRange(address,length,this.info.capacity,alignment);}
        async readUnqueued(address,length){const bytes=new Uint8Array(length);for(let offset=0;offset<length;){const n=Math.min(this.info.chunk,length-offset);bytes.set((await this.call(op.READ,address+offset,n)).data,offset);offset+=n;}return bytes;}
        read(address,length,{signal}={}){return this.run(async()=>{this.range(address,length);abort(signal);return this.readUnqueued(address,length);});}
        download(address,length,sink,{signal,onProgress=()=>{}}={}){return this.run(async()=>{
            this.range(address,length);let done=0;
            while(done<length){abort(signal);const n=Math.min(65536,length-done);const bytes=await this.readUnqueued(address+done,n);await sink.write(bytes);done+=n;onProgress(done,length);}
            return done;
        });}
        erase(address,length,{signal,onProgress=()=>{}}={}){return this.run(async()=>{
            this.range(address,length,4096);for(let done=0;done<length;done+=4096){abort(signal);await this.call(op.ERASE,address+done,4096);onProgress(done+4096,length);}return length;
        });}
        check(address,length,{signal,onProgress=()=>{},onChunk=()=>{}}={}){return this.run(async()=>{
            this.range(address,length);let first=null;const chunks=[];
            for(let done=0;done<length;){abort(signal);const n=Math.min(65536,length-done),r=await this.call(op.CHECK,address+done,n);const row={address:address+done,length:n,crc:r.values[1],first:r.values[2]===0xffffffff?null:r.values[2]};
                if(first===null&&row.first!==null)first=row.first;chunks.push(row);onChunk(row);done+=n;onProgress(done,length);}
            return{first,chunks};
        });}
        verify(address,file,{signal,onProgress=()=>{}}={}){return this.run(async()=>{
            this.range(address,file.size,1);for(let done=0;done<file.size;){abort(signal);const n=Math.min(768,file.size-done),start=(address+done)&~3,end=Math.ceil((address+done+n)/4)*4;
                const bytes=await this.readUnqueued(start,end-start),expected=new Uint8Array(await file.slice(done,done+n).arrayBuffer());
                for(let i=0;i<n;i++)if(bytes[address+done-start+i]!==expected[i])throw new Error(`Flash: Vergleich fehlgeschlagen bei 0x${(address+done+i).toString(16)}.`);
                done+=n;onProgress(done,file.size);}
            return file.size;
        });}
        program(address,file,{erase=true,verify=true,signal,onProgress=()=>{}}={}){return this.run(async()=>{
            this.range(address,file.size,1);let completed=0;
            // Finish each read/erase/program/verify sector before accepting cancellation.
            // This preserves bytes outside the file on both partial edge sectors.
            for(let sector=Math.floor(address/4096)*4096;sector<address+file.size;sector+=4096){
                abort(signal);const bytes=await this.readUnqueued(sector,4096),first=Math.max(address,sector),last=Math.min(address+file.size,sector+4096);
                const incoming=new Uint8Array(await file.slice(first-address,last-address).arrayBuffer());
                if(!erase)for(let i=0;i<incoming.length;i++)if((bytes[first-sector+i]&incoming[i])!==incoming[i])throw new Error(`Flash: zuerst löschen (NEEDS_ERASE bei 0x${(first+i).toString(16)}).`);
                bytes.set(incoming,first-sector);
                if(erase)await this.call(op.ERASE,sector,4096);
                for(let offset=0;offset<4096;offset+=256){const page=bytes.subarray(offset,offset+256);if(erase?page.some(b=>b!==255):sector+offset<last&&sector+offset+256>first)await this.call(op.WRITE,sector+offset,256,page);}
                if(verify)for(let offset=0;offset<4096;offset+=768){const n=Math.min(768,4096-offset);await this.call(op.VERIFY,sector+offset,n,bytes.subarray(offset,offset+n));}
                completed+=last-first;onProgress(completed,file.size);
            }
            return completed;
        });}
    }
    const api={FlashHost,flashRange};if(node)module.exports=api;else Object.assign(root.ESPIO ||= {},api);
})(globalThis);
