(function(root){
    'use strict';
    const spec=typeof module==='object'&&module.exports?require('../stub/protocol.js'):root.ESPIO.rpcProtocol;
    const limits=spec.stepResponse;
    function stepDelays({minDelayNs=1000,maxDelayUs=10000}={}){
        if(!Number.isInteger(minDelayNs)||minDelayNs<1||!Number.isInteger(maxDelayUs)||maxDelayUs<1||maxDelayUs>1000000||minDelayNs>maxDelayUs*1000)throw new Error('Invalid step-response delay range.');
        const result=[];for(let d=minDelayNs;;d*=2){result.push(Math.min(d,maxDelayUs*1000));if(result.length>limits.maxPoints)throw new Error('Step response supports at most 16 delay steps; increase the minimum delay.');if(d>=maxDelayUs*1000)return result;}
    }
    function stepOptions(options={},modeMask=31){
        const q={minDelayNs:1000,maxDelayUs:10000,settleUs:10000,repetitions:4,...options},delays=stepDelays(q);
        if(!Number.isInteger(q.settleUs)||q.settleUs<0||q.settleUs>1000000||!Number.isInteger(q.repetitions)||q.repetitions<1||q.repetitions>16)throw new Error('Invalid step-response settling time or repetitions.');
        const modes=[0,1,2,3,4].filter(m=>modeMask&1<<m),budget=(delays.reduce((a,b)=>a+Math.ceil(b/1000),0)+q.settleUs*delays.length)*q.repetitions*modes.length*2;
        if(budget>limits.maxDurationUs)throw new Error('Step response exceeds the 8-second device budget; reduce settling time, range or repetitions.');
        return {...q,delays,modeMask,budget};
    }
    async function measureStepResponse(controller,id,options={},signal){
        const pin=controller.descriptor(id);
        if(!pin.output)return {skipped:'Input-only pin; no output driver.'};
        const config=stepOptions(options,pin.pulls?31:30),adc=controller.adc,analog=!!adc?.channel(id),bank=controller.bank(id);
        if(signal?.aborted)throw new DOMException('Scan cancelled.','AbortError');
        await controller.configurePin(id,'output','none',0);
        const route=controller.analogRoute(id),gpio=route||controller.chip.gpio;
        let slot=65535;
        if(analog&&controller.transport.captureStep){await adc.capture([id]);slot=adc.captureSlots.get(id);}
        const values={pin:id,slot,min_delay_ns:config.minDelayNs,max_delay_us:config.maxDelayUs,settle_us:config.settleUs,repetitions:config.repetitions,mode_mask:config.modeMask,
            mux_addr:route?route.mux+id*4:pin.mux,pull_up:gpio.pullUp,pull_down:gpio.pullDown,output_addr:bank.output,enable_addr:bank.enable,enable_set_addr:bank.enableSet,enable_clear_addr:bank.enableClear,set_addr:bank.set,clear_addr:bank.clear,input_addr:bank.input,bit_mask:(2**(id%32))>>>0};
        let records;
        if(controller.transport.simulation){
            records=[];for(let direction=0;direction<2;direction++)for(let mode=0;mode<5;mode++)if(config.modeMask&1<<mode)for(const ns of config.delays){const actual=ns+(analog?12000:50),tau=mode?80000/mode:500000,fall=Math.exp(-actual/tau);records.push({mean:analog?(direction?1-fall:fall)*4095:(direction?1-fall:fall)>.5?1:0,actualDelayNs:actual});}
        }else{
            if(!controller.transport.captureStep||!controller.transport.supportsStepResponse())throw new Error('Load accelerated stub 0.9.0 or newer for step-response measurement.');
            records=await controller.transport.captureStep(values,config);
        }
        if(signal?.aborted)throw new DOMException('Scan cancelled.','AbortError');
        const curves=[];let index=0;
        for(const direction of ['falling','rising'])for(let mode=0;mode<5;mode++)if(config.modeMask&1<<mode){const points=config.delays.map(requestedDelayNs=>({requestedDelayNs,...records[index++]}));curves.push({direction,mode,label:mode?`D${mode-1}`:direction==='falling'?'Pull-down':'Pull-up',points});}
        return {format:'esp-io-step-response-v1',measurement:analog?'adc':'digital',voltageCalibrated:false,referenceVolts:3.3,rawMax:analog?4095:1,...config,curves,simulation:!!controller.transport.simulation};
    }
    const escape=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    function stepResponseHTML(result){
        const r=result?.stepResponse;if(!r)return '';if(r.skipped)return `<p>${escape(r.skipped)}</p>`;
        const width=600,height=270,left=45,right=15,top=22,bottom=42;
        const minimum=Math.min(r.minDelayNs,...r.curves.flatMap(c=>c.points.map(p=>p.actualDelayNs))),maximum=Math.max(r.maxDelayUs*1000,...r.curves.flatMap(c=>c.points.map(p=>p.actualDelayNs)));
        const x=ns=>left+(Math.log10(Math.max(ns,minimum))-Math.log10(minimum))/(Math.log10(maximum)-Math.log10(minimum)||1)*(width-left-right),y=mean=>height-bottom-Math.max(0,Math.min(1,r.measurement==='digital'?(mean>=.5?1:0):mean/r.rawMax))*(height-top-bottom);
        let svg=`<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Step response: voltage versus delay, logarithmic time axis">`;
        for(const volts of [0,1.1,2.2,3.3]){const py=height-bottom-volts/3.3*(height-top-bottom);svg+=`<path d="M${left},${py}H${width-right}" stroke="#35414b"/><text x="${left-7}" y="${py+4}" text-anchor="end" fill="#9aa9b6" font-size="10">${volts.toFixed(1)} V</text>`;}
        for(let ns=10**Math.ceil(Math.log10(minimum));ns<=maximum;ns*=10)svg+=`<text x="${x(ns)}" y="${height-23}" text-anchor="middle" fill="#9aa9b6" font-size="10">${ns<1e6?ns/1000+' µs':ns/1e6+' ms'}</text>`;
        const colors={falling:['#a05b63','#bc626e','#d76e7e','#ed8c99','#ffb5c0'],rising:['#385f49','#47805c','#55a76c','#77cf8a','#b5f386']};
        for(const c of r.curves){const color=colors[c.direction][c.mode];svg+=`<path d="${c.points.map((p,i)=>(i?'L':'M')+x(p.actualDelayNs).toFixed(2)+','+y(p.mean).toFixed(2)).join(' ')}" fill="none" stroke="${color}" stroke-width="1.7"/>`;for(const p of c.points)svg+=`<circle cx="${x(p.actualDelayNs)}" cy="${y(p.mean)}" r="2" fill="${color}"><title>${escape(c.direction+' '+c.label)}: ${(p.actualDelayNs/1000).toFixed(3)} µs (requested ${p.requestedDelayNs/1000} µs), ${((r.measurement==='digital'?(p.mean>=.5?1:0):p.mean/r.rawMax)*3.3).toFixed(3)} V</title></circle>`;}
        svg+=`<text x="${width/2}" y="${height-5}" text-anchor="middle" fill="#9aa9b6" font-size="10">Actual edge → measurement delay (log)</text></svg>`;
        const legend=r.curves.map(c=>`<span><i style="background:${colors[c.direction][c.mode]}"></i>${c.direction==='falling'?'↓':'↑'} ${escape(c.label)}</span>`).join('');
        return `<section class="step-response"><strong>Step response · HIGH → LOW / LOW → HIGH</strong>${svg}<div class="step-legend">${legend}</div><p class="muted">Red: falling · Green: rising. Dark: pulls; brighter: D0–D3. ${r.repetitions} repeats; ${(r.settleUs/1000).toFixed(2)} ms settling at D3 before each edge. ${r.measurement==='adc'?'Nominal ADC scale 0–3.3 V, not voltage-calibrated. Conversion latency is included in the actual delay.':'Digital readback: LOW = 0 V, HIGH = 3.3 V (logic indicators).'}</p></section>`;
    }
    const api={stepDelays,stepOptions,measureStepResponse,stepResponseHTML};if(typeof module==='object'&&module.exports)module.exports=api;else Object.assign(root.ESPIO ||= {},api);
})(globalThis);
