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
        return {format:'esp-io-step-response-v1',measurement:analog?'adc':'digital',voltageCalibrated:false,firstADCTriggerNs:records.firstADCTriggerNs??null,referenceVolts:3.3,rawMax:analog?4095:1,...config,curves,simulation:!!controller.transport.simulation};
    }
    const escape=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    function stepResponseHTML(result){
        const r=result?.stepResponse;if(!r)return '';if(r.skipped)return `<section class="load-profile step-response"><h4>Step response</h4><p>${escape(r.skipped)}</p></section>`;
        const digital=r.measurement==='digital',width=560,height=260,left=digital?72:52,right=digital?32:22,top=26,bottom=56,base=height-bottom;
        const minimum=Math.min(r.minDelayNs,...r.curves.flatMap(c=>c.points.map(p=>p.actualDelayNs))),maximum=Math.max(r.maxDelayUs*1000,...r.curves.flatMap(c=>c.points.map(p=>p.actualDelayNs)));
        const x=ns=>left+(Math.log10(Math.max(ns,minimum))-Math.log10(minimum))/(Math.log10(maximum)-Math.log10(minimum)||1)*(width-left-right);
        const colors={falling:['#2e6b83','#3c89ad','#51a9d3','#67c9ff','#a2dfff'],rising:['#2a704e','#38956a','#4db884','#68e8a5','#aff8d2']};
        const plots=(digital?['falling','rising']:['analog']).map(direction=>{
            const curves=r.curves.filter(c=>!digital||c.direction===direction),band=(base-top-8*(curves.length-1))/Math.max(1,curves.length);
            const floor=i=>digital?top+i*(band+8)+band:base;
            const y=(mean,i)=>floor(i)-Math.max(0,Math.min(1,digital?(mean>=.5?1:0):mean/r.rawMax))*(digital?band:base-top);
            let svg=`<svg class="load-xy step-xy" viewBox="0 0 ${width} ${height}" role="img" aria-label="${digital?(direction==='falling'?'Falling':'Rising'):'Falling and rising'} step response: ${digital?'separate digital lanes':'voltage'} versus delay, logarithmic time axis">`;
            if(digital){
                curves.forEach((c,i)=>{
                    svg+=`<rect class="step-lane" x="${left}" y="${floor(i)-band}" width="${width-left-right}" height="${band}"/><text class="step-lane-label" x="${left-8}" y="${floor(i)-band/2+3}" text-anchor="end">${escape(c.label)}</text><text class="step-level" x="${width-right+5}" y="${floor(i)-band+4}">1</text><text class="step-level" x="${width-right+5}" y="${floor(i)}">0</text>`;
                });
            }else{
                for(let i=0;i<=4;i++){const py=base-i/4*(base-top);svg+=`<path class="load-grid" d="M${left},${py}H${width-right}"/><text x="${left-8}" y="${py+3}" text-anchor="end">${(3.3*i/4).toFixed(2)}</text>`;}
                svg+=`<text x="${left}" y="13">Nominal voltage (V)</text>`;
            }
            for(let ns=10**Math.ceil(Math.log10(minimum));ns<=maximum;ns*=10)svg+=`<path class="load-grid" d="M${x(ns)},${top}V${base}"/><text x="${x(ns)}" y="${base+19}" text-anchor="middle">${ns<1e6?ns/1000+' \u00b5s':ns/1e6+' ms'}</text>`;
            if(!digital)svg+=`<path class="load-grid" d="M${left},${top}H${width-right}V${base}H${left}Z"/>`;
            // Draw every translucent area before the lines, keeping all strokes crisp.
            const paths=curves.map((c,i)=>{
                const points=c.points,first=points[0],last=points.at(-1);if(!first)return '';
                const line=points.map((p,n)=>(n?(digital?'H'+x(p.actualDelayNs).toFixed(2)+'V':'L'+x(p.actualDelayNs).toFixed(2)+','):'M'+x(p.actualDelayNs).toFixed(2)+',')+y(p.mean,i).toFixed(2)).join(' ');
                const area=line+` L${x(last.actualDelayNs).toFixed(2)},${floor(i).toFixed(2)} H${x(first.actualDelayNs).toFixed(2)} Z`;
                svg+=`<path class="step-area${digital?' step-digital-area':''}" d="${area}" fill="${colors[c.direction][c.mode]}"/>`;
                return line;
            });
            curves.forEach((c,i)=>{
                const color=colors[c.direction][c.mode];svg+=`<path class="step-trace" d="${paths[i]}" fill="none" stroke="${color}" vector-effect="non-scaling-stroke"/>`;
                for(const p of c.points)svg+=`<circle class="step-point" cx="${x(p.actualDelayNs)}" cy="${y(p.mean,i)}" r="${digital?1.1:1.6}" fill="${color}"><title>${escape(c.direction+' '+c.label)}: ${(p.actualDelayNs/1000).toFixed(3)} \u00b5s (requested ${p.requestedDelayNs/1000} \u00b5s), ${((digital?(p.mean>=.5?1:0):p.mean/r.rawMax)*3.3).toFixed(3)} V</title></circle>`;
            });
            svg+=`<text x="${left+(width-left-right)/2}" y="${height-9}" text-anchor="middle">${digital?'Actual edge \u2192 measurement delay (log)':'Estimated conversion midpoint delay (log)'}</text></svg>`;
            const legend=digital?'':`<div class="load-legend step-legend">${curves.map(c=>`<span style="--load-color:${colors[c.direction][c.mode]}">${c.direction==='falling'?'\u2193':'\u2191'} ${escape(c.label)}</span>`).join('')}</div>`;
            return `<div class="step-direction step-${direction}">${digital?`<h5>${direction==='falling'?'HIGH \u2192 LOW':'LOW \u2192 HIGH'}</h5>`:''}${legend}${svg}</div>`;
        }).join('');
        const caption=digital?'Digital readback per edge; separate lane per drive level':'ADC means per edge; logarithmic delay axis';
        const adcTiming=!digital&&r.firstADCTriggerNs?`<br>First ADC trigger: ${r.firstADCTriggerNs===65535?'\u2265':''}${(r.firstADCTriggerNs/1000).toFixed(3)} \u00b5s after edge (requested ${r.minDelayNs/1000} \u00b5s)` : '';
        return `<section class="load-profile step-response"><h4>Step response \u00b7 HIGH \u2192 LOW / LOW \u2192 HIGH</h4><p class="load-profile-caption">${caption}</p><div class="step-directions">${plots}</div><p class="load-thresholds">${r.repetitions} repeats per point<br>${(r.settleUs/1000).toFixed(2)} ms settling at D3 before each edge<br>Requested delays: ${r.minDelayNs/1000} \u00b5s \u2013 ${r.maxDelayUs/1000} ms${adcTiming}</p><small>${digital?'Filled: HIGH; empty: LOW. Steps connect samples; the transition may lie between them.':'Blue: falling \u00b7 Green: rising. Dark: pulls; brighter: D0\u2013D3.'}</small><small>${digital?'Digital readback: LOW = 0 V, HIGH = 3.3 V (logic indicators).':'Nominal ADC scale 0\u20133.3 V, not voltage-calibrated. ADC timing estimates the conversion midpoint, not the sampling aperture.'}</small></section>`;
    }
    const api={stepDelays,stepOptions,measureStepResponse,stepResponseHTML};if(typeof module==='object'&&module.exports)module.exports=api;else Object.assign(root.ESPIO ||= {},api);
})(globalThis);
