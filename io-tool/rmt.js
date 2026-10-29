(function(root){
    'use strict';
    const node=typeof module==='object'&&module.exports;
    const protocol=node?require('../stub/protocol.js'):root.ESPIO.rpcProtocol;
    const {PeripheralHost}=node?require('./peripheral.js'):root.ESPIO;
    function symbol(level0,duration0,level1,duration1){
        if(![0,1].includes(level0)||![0,1].includes(level1)||![duration0,duration1].every(n=>Number.isInteger(n)&&n>0&&n<=32767))throw new Error('RMT: Pegel 0/1 und Dauern 1–32767 Ticks erforderlich.');
        return (duration0|(level0<<15)|(duration1<<16)|(level1<<31))>>>0;
    }
    function packRMT(sequence){
        if(!(sequence instanceof Uint32Array)||!sequence.length||sequence.length>32768)throw new Error('RMT: 1–32768 Symbole erforderlich.');
        const dictionary=[];let totalTicks=0;
        for(const w of sequence){if(!(w&32767)||!((w>>>16)&32767))throw new Error('RMT: Null-Dauer ist nur als internes Endezeichen zulässig.');totalTicks+=(w&32767)+((w>>>16)&32767);if(dictionary.length<3&&!dictionary.includes(w))dictionary.push(w);}
        let data,encoding;
        if(dictionary.length<=2){encoding=1;data=new Uint8Array(Math.ceil(sequence.length/8));for(let i=0;i<sequence.length;i++)if(sequence[i]!==dictionary[0])data[i>>3]|=1<<(7-(i&7));dictionary[1]??=dictionary[0];}
        else{encoding=0;data=new Uint8Array(sequence.length*4);const v=new DataView(data.buffer);sequence.forEach((w,i)=>v.setUint32(i*4,w,true));}
        if(data.length>4096)throw new Error('RMT: Sequenz benötigt mehr als 4096 Byte Upload-RAM (RAW: 1024 Symbole; zwei Symboltypen: 32768).');
        return{data,encoding,dictionary:dictionary.slice(0,2),symbols:sequence.length,totalTicks};
    }
    function ws2812Sequence(rgb,hz){
        if(!(rgb instanceof Uint8Array)||!rgb.length||rgb.length%3)throw new Error('WS2812: RGB-Bytes je LED erforderlich.');
        const period=Math.round(hz*1.25e-6),zero=Math.round(hz*.35e-6),one=Math.round(hz*.7e-6);
        if(!Number.isFinite(hz)||![zero,period-zero,one,period-one].every(n=>n>=1&&n<=32767))throw new Error('WS2812: RMT-Auflösung ungeeignet. Port freigeben und mit 20000000 Hz aktivieren; bei alten Stubs die aktuelle Version neu laden.');
        const words=[symbol(1,zero,0,period-zero),symbol(1,one,0,period-one)],result=new Uint32Array(rgb.length*8);let n=0;
        for(let led=0;led<rgb.length;led+=3)for(const component of [rgb[led+1],rgb[led],rgb[led+2]])for(let b=7;b>=0;b--)result[n++]=words[component>>>b&1];
        return result;
    }
    // Patterns live in JavaScript; the device only receives the encoded symbols.
    function rainbowPattern(count,brightness=.08,phase=0){
        if(!Number.isInteger(count)||count<1||count>1365||brightness<0||brightness>1)throw new Error('WS2812: 1–1365 LEDs und Helligkeit 0–1 wählen.');
        const rgb=new Uint8Array(count*3);
        for(let i=0;i<count;i++){const h=((i/count+phase)%1+1)%1*6,x=1-Math.abs(h%2-1),c=h<1?[1,x,0]:h<2?[x,1,0]:h<3?[0,1,x]:h<4?[0,x,1]:h<5?[x,0,1]:[1,0,x];c.forEach((v,j)=>rgb[i*3+j]=Math.round(v*255*brightness));}
        return rgb;
    }
    function animationDelay(ms,signal){
        return new Promise(resolve=>{
            const done=()=>{clearTimeout(timer);signal?.removeEventListener('abort',done);resolve();};
            const timer=setTimeout(done,ms);
            signal?.addEventListener('abort',done,{once:true});if(signal?.aborted)done();
        });
    }
    async function animateRMTRainbow(host,{count,brightness=.08,idleUs=80,signal,onFrame=()=>{}}={},timing={now:()=>performance.now(),wait:animationDelay}){
        const interval=10,cycle=256*interval,start=timing.now();let deadline=start,frames=0;
        while(!signal?.aborted){
            const sequence=ws2812Sequence(rainbowPattern(count,brightness,(timing.now()-start)/cycle),host.actualHz);
            try{await host.send(sequence,{signal,idleUs});}
            catch(error){if(signal?.aborted&&error.name==='AbortError')break;throw error;}
            frames++;if(signal?.aborted)break;
            onFrame({frames,elapsedMs:timing.now()-start});
            // One outstanding frame only. Slow links skip missed deadlines;
            // phase follows elapsed time, rather than slowing the color scroll.
            deadline=Math.max(deadline+interval,timing.now());
            await timing.wait(Math.max(0,deadline-timing.now()),signal);
        }
        return{frames,elapsedMs:timing.now()-start};
    }
    class RMTHost extends PeripheralHost{
        constructor(controller){super(controller,'RMT');}
        send(sequence,{signal,repeat=1,idleUs=80}={}){
            return this.transaction(async()=>{
                const p=packRMT(sequence);
                if(!Number.isInteger(repeat)||repeat<1||repeat>1000||!Number.isInteger(idleUs)||idleUs<0||idleUs>1000000)throw new Error('RMT: ungültige Wiederholung oder Endpause.');
                const duration=Math.ceil(p.totalTicks*repeat*1e6/this.actualHz)+idleUs;
                if(duration>29800000)throw new Error('RMT: maximal 29,8 Sekunden je Übertragung.');
                const check=()=>{if(signal?.aborted)throw new DOMException('RMT-Upload abgebrochen.','AbortError');};
                check();
                try{
                    await this.call(protocol.rmtOperations.BEGIN,[p.encoding,p.symbols,p.data.length,...p.dictionary]);
                    for(let offset=0;offset<p.data.length;offset+=768){check();await this.call(protocol.rmtOperations.APPEND,[offset],p.data.subarray(offset,offset+768));}
                    check();const r=await this.transport.peripheral('RMT',protocol.rmtOperations.SEND,this.config.port,[repeat,idleUs],new Uint8Array(),Math.max(100000,Math.ceil(duration+200000)));
                    this.expectData(r,0);if(r.values[0]!==p.symbols*repeat){this.transport.close();throw new Error('RMT: unvollständige Übertragung. Neu verbinden.');}return r;
                }catch(e){if(!this.transport.closed)try{await this.call(protocol.rmtOperations.ABORT);}catch{}throw e;}
            },signal);
        }
    }
    const api={RMTHost,rmtSymbol:symbol,packRMT,ws2812Sequence,rainbowPattern,animateRMTRainbow};
    if(node)module.exports=api;else Object.assign(root.ESPIO ||= {},api);
})(globalThis);
