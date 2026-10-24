(function(root){
    'use strict';const node=typeof module==='object'&&module.exports;
    const protocol=node?require('../stub/protocol.js'):root.ESPIO.rpcProtocol,types=protocol.fuseTypes,op=protocol.fuseOperations;
    const decoder=new TextDecoder('utf-8',{fatal:true}),hex=bytes=>Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join(' ');
    function parseFuseRecords(bytes){
        if(!(bytes instanceof Uint8Array))throw new Error('Fuses: ungültige Nutzdaten.');
        const records=[],view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);let offset=0;
        while(offset<bytes.length){
            if(bytes.length-offset<8)throw new Error('Fuses: abgeschnittener Datensatz.');
            const size=view.getUint16(offset,true),nameLength=bytes[offset+2],type=bytes[offset+3],bits=view.getUint16(offset+4,true),length=view.getUint16(offset+6,true);
            if(!nameLength||size!==8+nameLength+length||size>bytes.length-offset||bits>256)throw new Error('Fuses: ungültige Datensatzlänge.');
            const name=decoder.decode(bytes.subarray(offset+8,offset+8+nameLength)),data=bytes.slice(offset+8+nameLength,offset+size);
            if(/[\x00-\x1f\x7f]/.test(name))throw new Error('Fuses: ungültiger Feldname.');
            let value=0n;for(let i=data.length-1;i>=0;i--)value=value<<8n|BigInt(data[i]);
            const numeric=[types.UNSIGNED,types.HEX,types.BOOLEAN,types.BIT_COUNT,types.ODD_PARITY,types.MAC,types.BYTES,types.OPTIONAL_ID].includes(type);
            if(numeric&&(!bits||length!==Math.ceil(bits/8)||(value>>BigInt(bits))))throw new Error('Fuses: Bitbreite passt nicht zum Wert.');
            let display=hex(data),set=0;for(const b of data)for(let n=b;n;n&=n-1)set++;
            if(type===types.TEXT)display=decoder.decode(data);
            else if(type===types.UNSIGNED)display=value.toString();
            else if(type===types.HEX)display='0x'+value.toString(16).padStart(length*2,'0').toUpperCase();
            else if(type===types.BOOLEAN)display=value?'gesetzt':'nicht gesetzt';
            else if(type===types.BIT_COUNT)display=`${set} · ${set} Bits gesetzt`;
            else if(type===types.ODD_PARITY)display=`${set%2?'aktiv · ungerade':'inaktiv · gerade'} · ${set} Bits gesetzt`;
            else if(type===types.MAC){if(bits!==48)throw new Error('Fuses: MAC mit ungültiger Länge.');display=data.every(b=>b===0)||data.every(b=>b===255)?'nicht verfügbar':hex(data).replaceAll(' ',':').toUpperCase();}
            else if(type===types.OPTIONAL_ID)display=value?hex(data).replaceAll(' ','').toUpperCase():'nicht gesetzt oder nicht lesbar';
            records.push({name,type,bits,data,raw:hex(data).toUpperCase(),display});offset+=size;
        }
        return records;
    }
    class FusesHost{
        constructor(controller){this.controller=controller;this.transport=controller.transport;}
        read({signal,onProgress=()=>{}}={}){return this.controller.queue.run(async()=>{
            if(!this.controller.active||this.controller.fault||!this.transport.supports?.('FUSES'))throw new Error('Fuses: aktuellen beschleunigten Stub laden.');
            const check=()=>{if(signal?.aborted)throw new DOMException('Fuses-Abfrage abgebrochen.','AbortError');};
            try{
                check();const info=await this.transport.peripheral('FUSES',op.INFO,0),[total,version,page]=info.values,schema=info.values[7];
                if(info.data.length||version!==1||!Number.isInteger(total)||total<1||total>1024||!Number.isInteger(page)||page<192||page>512)throw new Error('Fuses: ungültige Seitenbeschreibung.');
                let cursor=0;const records=[],names=new Set();
                while(cursor<total){
                    check();const r=await this.transport.peripheral('FUSES',op.READ,0,[cursor,page]),rows=parseFuseRecords(r.data);
                    if(!rows.length||r.data.length>page||r.values[0]!==cursor||r.values[1]!==rows.length||r.values[2]!==cursor+rows.length||r.values[2]>total||r.values[3]!==total||r.values[7]!==schema)throw new Error('Fuses: unvollständige oder fremde Antwortseite.');
                    for(const row of rows){if(names.has(row.name))throw new Error('Fuses: doppelter Feldname.');names.add(row.name);records.push(row);}
                    cursor=r.values[2];onProgress(cursor,total);
                }
                return records;
            }catch(e){if(!e.response&&e.name!=='AbortError')this.transport.close();throw e;}
        });}
    }
    const api={FusesHost,parseFuseRecords};if(node)module.exports=api;else Object.assign(root.ESPIO ||= {},api);
})(globalThis);
