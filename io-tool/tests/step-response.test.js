'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {stepDelays,stepOptions,stepResponseHTML}=require('../step-response.js');
const {GPIOController,DemoTransport}=require('../gpio.js');
const chips=require('../configs/chips.js');
test('exponential delays include the exact configured maximum and support submicrosecond starts',()=>{
    const d=stepDelays();assert.deepEqual(d.slice(0,5),[1000,2000,4000,8000,16000]);assert.equal(d.at(-1),10000000);assert.equal(d.length,15);
    assert.equal(stepDelays({minDelayNs:500,maxDelayUs:10000}).length,16);
    assert.equal(stepOptions().budget,7055320);
    for(const config of [{minDelayNs:0},{minDelayNs:250},{repetitions:0},{settleUs:1000000}])assert.throws(()=>stepOptions(config));
});
test('step-only acquisition produces all averaged curves without the switching/load sweep and restores HP/LP pins',async()=>{
    for(const [chip,id] of [[chips.esp32c3,5],[chips.esp32s3,4],[chips.esp32c6,3]]){
        const t=new DemoTransport(chip),c=new GPIOController(t,chip);await c.initialize([id]);await c.configure(id,'output','up',1,2);
        const pin=c.descriptor(id),bank=chip.gpio.banks[Math.floor(id/32)],addresses=[pin.mux,bank.output,bank.enable];
        const before=await Promise.all(addresses.map(a=>t.read(a)));
        const [r]=await c.scanUsage([id],{switching:false,loadProfile:false,stepResponse:true,stepOptions:{maxDelayUs:4,settleUs:2,repetitions:2}});
        assert.equal(r.runs.length,0);assert.equal(r.loadProfile,undefined);assert.equal(r.switching,false);assert.equal(r.stepResponse.curves.length,10);
        assert.ok(r.stepResponse.curves.every(c=>c.points.length===3));assert.equal(r.stepResponse.simulation,true);
        assert.equal(c.pins.get(id).level,1);assert.equal(c.pins.get(id).driveStrength,2);
        assert.deepEqual(await Promise.all(addresses.map(a=>t.read(a))),before,chip.id);
        const html=stepResponseHTML(r);assert.match(html,/logarithmic time axis/);assert.match(html,/not voltage-calibrated|logic indicators/);
        await c.close();
    }
});
test('no selected measurement is rejected before GPIO configuration changes',async()=>{
    const t=new DemoTransport(chips.esp32c3),c=new GPIOController(t,chips.esp32c3);await c.initialize([5]);
    await assert.rejects(c.scanUsage([5],{switching:false,loadProfile:false,stepResponse:false}),/Select at least one/);
    assert.equal(c.fault,false);await c.close();
});
