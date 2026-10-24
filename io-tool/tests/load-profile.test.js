const test=require('node:test'),assert=require('node:assert/strict');
const chips=require('../configs/chips.js'),adc=require('../configs/adc.js');
const {GPIOController,DemoTransport}=require('../gpio.js');
const {summarizeLoadPhase,loadProfileThresholds,loadProfileHTML}=require('../load-profile.js');
const {scopeSVG,scopeLegend}=require('../scope.js');
const {readFileSync}=require('node:fs');

test('scan UI has no method selection and offers only windows from 50 ms',()=>{
    const html=readFileSync(require.resolve('../index.html'),'utf8');
    assert.doesNotMatch(html,/id="scan-method"/);
    const select=html.match(/<select id="scan-settle">([\s\S]*?)<\/select>/)[1];
    assert.deepEqual([...select.matchAll(/<option value="(\d+)"/g)].map(m=>Number(m[1])),[50,100,200]);
    assert.match(select,/<option value="50" selected>/);
});

test('strength sweep visits D0-D3 on every writable ADC profile and restores the actual pad strength',async()=>{
    for(const chip of Object.values(chips).filter(c=>!c.readOnlyGPIO&&adc[c.id])){
        const pin=chip.pins.find(p=>p.output&&p.pulls&&!p.reserved&&adc[chip.id].channels[p.id]),t=new DemoTransport(chip),c=new GPIOController(t,chip);
        await c.initialize([pin.id]);await c.configure(pin.id,'output','up',1);await t.write(pin.mux,2<<10,3072);
        const before=new Map(t.registers),writes=[],write=t.write.bind(t);t.write=async(...a)=>{writes.push(a);return write(...a);};
        const [r]=await c.scanUsage([pin.id],{method:'compare',settleMs:5,loadProfile:true,maxDrive:3});
        assert.deepEqual(r.loadProfile.stages.map(s=>s.label),['Idle','Pulls','D0','D1','D2','D3'],chip.id);assert.equal(r.runs.length,5);
        assert.deepEqual(r.runs.map(run=>run.method==='pull'?'Pulls':`D${run.driveStrength}`),r.loadProfile.stages.slice(1).map(stage=>stage.label));
        const html=loadProfileHTML(r);assert.match(html,/ADC raw/);assert.match(html,/Idle \(High-Z\)/);
        const route=adc[chip.id].padRoute,mux=route?route.mux+pin.id*4:pin.mux;
        const expectedWrites=r.runs.filter(run=>run.method==='drive').flatMap(run=>Array(run.timingQuality.attempts).fill(run.driveStrength));
        assert.deepEqual(writes.filter(([a,v,m])=>a===mux&&m===3072).map(([a,v])=>v>>>10),expectedWrites,chip.id);
        for(const [address,value]of before)assert.equal(t.registers.get(address),value,`${chip.id}: ${address.toString(16)}`);
        assert.equal(c.pins.get(pin.id).mode,'output');assert.equal(c.pins.get(pin.id).level,1);
        await c.close();
    }
});

test('pins without ADC channel get a digital load profile over the full ladder',async()=>{
    for(const chip of Object.values(chips).filter(c=>!c.readOnlyGPIO)){
        const pin=chip.pins.find(p=>p.output&&p.pulls&&!p.reserved&&!adc[chip.id]?.channels[p.id]);if(!pin)continue;
        const t=new DemoTransport(chip),c=new GPIOController(t,chip);await c.initialize([pin.id]);
        const writes=[],write=t.write.bind(t);t.write=async(...a)=>{writes.push(a);return write(...a);};
        const [r]=await c.scanUsage([pin.id],{method:'compare',settleMs:5,loadProfile:true});
        assert.equal(r.measurement,'digital',chip.id);assert.equal(r.loadProfile.measurement,'digital');assert.equal(r.loadProfile.rawMax,null);
        const labels=r.loadProfile.stages.map(s=>s.label);assert.deepEqual(labels.slice(0,3),['Idle','Pulls','D0'],chip.id);
        for(const s of r.loadProfile.stages)for(const k of ['low','high'])assert.ok(Number.isFinite(s[k].highFraction)&&s[k].meanRaw===null,chip.id);
        const html=loadProfileHTML(r);assert.match(html,/keinen ADC-Kanal: digitaler HIGH-Anteil/);assert.match(html,/<svg/);assert.doesNotMatch(html,/NaN|undefined/);
        if(r.loadProfile.maxDrive>0)assert.ok(writes.some(([a,v,m])=>a===pin.mux&&m===3072&&v),chip.id);
        await c.close();
    }
});

test('analog load plot keeps distinct HIGH/LOW values across strengths and reports the first rail-reaching stage',async()=>{
    const chip=chips.esp32p4,t=new DemoTransport(chip),c=new GPIOController(t,chip);await c.initialize([16]);
    const [r]=await c.scanUsage([16],{method:'compare',settleMs:5,loadProfile:true});
    const drive=r.loadProfile.stages.filter(s=>s.method==='drive');
    assert.ok(drive.every((s,i)=>!i||s.high.meanRaw>drive[i-1].high.meanRaw));
    assert.ok(drive.every((s,i)=>!i||s.low.meanRaw<drive[i-1].low.meanRaw));
    assert.equal(loadProfileThresholds(r.loadProfile).high.first,'D2');assert.equal(loadProfileThresholds(r.loadProfile).low.first,'D0');
    const html=loadProfileHTML(r);assert.match(html,/ADC raw/);assert.match(html,/>Idle</);assert.equal((html.match(/data-level="1"/g)||[]).length,6);assert.equal((html.match(/data-level="0"/g)||[]).length,6);
    assert.deepEqual(r.runs.map(run=>run.driveStrength),[null,0,1,2,3]);await c.close();
});

test('every load profile keeps all driven stages in the time plot too',async()=>{
    const chip=chips.esp32c3,P=chip.pins.find(p=>p.output&&p.pulls&&!p.reserved&&adc.esp32c3.channels[p.id]).id,t=new DemoTransport(chip),c=new GPIOController(t,chip);await c.initialize([P]);
    const writes=[],write=t.write.bind(t);t.write=async(...a)=>{writes.push(a);return write(...a);};
    const [r]=await c.scanUsage([P],{method:'pull',settleMs:5,loadProfile:true});
    assert.deepEqual(r.loadProfile.stages.map(s=>s.label),['Idle','Pulls','D0','D1','D2','D3']);assert.equal(r.loadProfile.maxDrive,3);
    assert.deepEqual(r.runs.map(run=>run.method),['pull','drive','drive','drive','drive']);assert.ok(writes.some(([a])=>a===c.bank(P).enableSet));
    const [limited]=await c.scanUsage([P],{method:'drive',settleMs:5,loadProfile:true,maxDrive:1});assert.deepEqual(limited.loadProfile.stages.map(s=>s.strength),[null,null,0,1]);
    const [clamped]=await c.scanUsage([P],{method:'drive',settleMs:5,loadProfile:true,maxDrive:9});assert.equal(clamped.loadProfile.maxDrive,3);
    await assert.rejects(c.scanUsage([P],{loadProfile:true,maxDrive:-1}),/Scanparameter/);await c.close();
});

test('fixed sweep plots every strength in increasing greens and each actual command in red, with or without load profile',async()=>{
    for(const loadProfile of [false,true])for(const id of [16,32]){
        const chip=chips.esp32p4,c=new GPIOController(new DemoTransport(chip),chip);await c.initialize([id]);
        const [r]=await c.scanUsage([id],{method:'sweep',settleMs:1,loadProfile});
        assert.equal(r.measurement,id===16?'adc':'digital');
        assert.deepEqual(r.runs.map(run=>run.driveStrength),[null,0,1,2,3]);
        const svg=scopeSVG(r),legend=scopeLegend(r);
        const traces=[...svg.matchAll(/data-trace="([^"]+)"[^>]*stroke="([^"]+)"/g)];
        assert.deepEqual(traces.map(m=>m[1]),['Pull','OUT D0','OUT D1','OUT D2','OUT D3']);
        assert.equal(new Set(traces.map(m=>m[2])).size,5);
        assert.equal(traces[0][2],'#246b42');
        const lightness=traces.slice(1).map(m=>Number(m[2].match(/, ([\d.]+)%\)$/)[1]));
        assert.ok(lightness.every((v,i)=>!i||v>lightness[i-1]));
        for(const [,label,color]of traces){
            assert.ok(legend.includes(`--trace:${color}`));
            assert.ok(svg.includes(`data-command="${label}"`));
        }
        assert.equal((svg.match(/data-command="[^"]+"[^>]*stroke="#ff7786"/g)||[]).length,5);
        assert.doesNotMatch(svg,/NaN|undefined|#67c9ff/);
        assert.equal(!!r.loadProfile,loadProfile);
        await c.close();
    }
});

test('1 ms window is accepted and every phase holds a sample started in the settled last third',async()=>{
    const chip=chips.esp32p4,t=new DemoTransport(chip),c=new GPIOController(t,chip);await c.initialize([16]);
    const [r]=await c.scanUsage([16],{method:'compare',settleMs:1,loadProfile:true});
    for(const s of r.loadProfile.stages)for(const v of [s.low,s.high])assert.equal(v.settledBy,'time',s.label);
    await assert.rejects(c.scanUsage([16],{settleMs:.5}),/Scanparameter/);await c.close();
});

test('settled value ignores early transient samples by start time, not by count',()=>{
    const samples=[...Array.from({length:9},(_,i)=>({raw:2000,io:0,startedMs:i*.05,t:i})),{raw:4000,io:1,startedMs:.8,t:9}];
    const v=summarizeLoadPhase(samples,1,4095,1);assert.equal(v.settledBy,'time');assert.equal(v.tailSamples,1);assert.equal(v.meanRaw,4000);assert.equal(v.matches,true);
});

test('floating Idle level near a rail is shown as reference, never as the threshold stage',()=>{
    const ph=(raw,level)=>summarizeLoadPhase([{raw,io:raw>2047?1:0,startedMs:1,t:0}],level,4095,1);
    const profile={rawMax:4095,stages:[{method:'idle',strength:null,label:'Idle',low:ph(368,0),high:ph(368,1),returnLow:ph(368,0)},{method:'pull',strength:null,label:'Pulls',low:ph(1,0),high:ph(3441,1),returnLow:ph(1,0)}]};
    assert.equal(loadProfileThresholds(profile).low.first,'Pulls');
    assert.match(loadProfileHTML({id:1,measurement:'adc',loadProfile:profile}),/Idle \(High-Z\): 368 raw · 9\.0 %/);
});

test('cancellation during a stronger output stage restores the previous latch, drive and pull',async()=>{
    const chip=chips.esp32c3,P=chip.pins.find(p=>p.output&&p.pulls&&!p.reserved&&adc.esp32c3.channels[p.id]).id,t=new DemoTransport(chip),c=new GPIOController(t,chip);await c.initialize([P]);await c.configure(P,'output','up',1);
    const pin=chip.pins.find(p=>p.id===P);await t.write(pin.mux,3<<10,3072);const before=new Map(t.registers),abort=new AbortController();
    await assert.rejects(c.scanUsage([P],{method:'drive',settleMs:5,loadProfile:true,signal:abort.signal,onPhase:(id,phase)=>{if(phase==='drive D2 high')abort.abort();}}),{name:'AbortError'});
    for(const [address,value]of before)assert.equal(t.registers.get(address),value);assert.equal(c.fault,false);await c.close();
});

test('C6 ADC sweep uses LP pad drive strength and restores both LP and HP fields',async()=>{
    const chip=chips.esp32c6,t=new DemoTransport(chip),c=new GPIOController(t,chip);await c.initialize([0]);await c.setReadMode('adc');await c.configure(0,'output','up',1);
    const hp=chip.pins.find(p=>p.id===0).mux,lp=adc.esp32c6.padRoute.mux;await t.write(hp,2<<10,3072);await t.write(lp,1<<10,3072);
    const [r]=await c.scanUsage([0],{method:'drive',settleMs:5,loadProfile:true,maxDrive:2});assert.equal(r.measurement,'adc');assert.equal(r.loadProfile.stages.length,5);
    assert.equal((t.registers.get(hp)>>>10)&3,2);assert.equal((t.registers.get(lp)>>>10)&3,1);assert.equal(c.adc.ready,true);await c.release();await c.close();
});

test('load thresholds use settled tails, require LOW return and expose nonmonotonic behavior',()=>{
    const summary=(value,level)=>summarizeLoadPhase(Array.from({length:6},(_,i)=>({raw:(i<4?.5:value)*4095,io:value>.5?1:0,t:i})),level);
    const low=summary(.03,0),high=summary(.98,1),opposed=summary(.5,0);
    assert.ok(low.matches&&high.matches);assert.equal(low.tailSamples,2);
    const profile={stages:[{label:'Pulls',method:'pull',low:opposed,high,returnLow:opposed},{label:'D0',method:'drive',strength:0,low,high,returnLow:low},{label:'D1',method:'drive',strength:1,low,high,returnLow:opposed}]};
    const thresholds=loadProfileThresholds(profile);assert.equal(thresholds.low.first,'D0');assert.equal(thresholds.low.nonMonotonic,true);
    const html=loadProfileHTML({id:4,measurement:'adc',loadProfile:profile});assert.match(html,/Lastprofil/);assert.match(html,/wechselnde Reaktion/);assert.match(html,/<svg/);assert.match(html,/data-level="1"/);assert.match(html,/data-level="0"/);assert.doesNotMatch(html,/NaN|undefined|load-matrix/);
});
