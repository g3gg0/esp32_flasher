// Start the repo HTTP server on 8088 and a headless Edge with CDP on 9235.
// Exercises the actual UI with a simulated serial peer; never accesses hardware.
import assert from 'node:assert/strict';
const chip = process.argv.find(arg => arg.startsWith('--chip='))?.slice(7) || (process.argv.includes('--p4-sd') ? 'esp32p4' : 'esp32c3');
const sd = ['esp32p4', 'esp32s3'].includes(chip);
const baseUrl = process.env.IO_QA_HTTP || 'http://127.0.0.1:8088';
const cdpUrl = process.env.IO_QA_CDP || 'http://127.0.0.1:9235';
const pages = await (await fetch(cdpUrl + '/json/list')).json();
const page = pages.find(item => item.type === 'page' && item.url.startsWith(baseUrl + '/io-tool/'));
assert.ok(page, 'Open /io-tool/ in the QA browser.');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise(resolve => ws.addEventListener('open', resolve, { once: true }));
let id = 0;
const pending = new Map(), errors = [];
ws.addEventListener('message', ({ data }) => {
    const message = JSON.parse(data);
    if (message.id) {
        const item = pending.get(message.id); if (!item) return;
        pending.delete(message.id); clearTimeout(item.timer);
        message.error ? item.reject(new Error(JSON.stringify(message.error))) : item.resolve(message.result);
    } else if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails);
});
function call(method, params = {}) {
    return new Promise((resolve, reject) => {
        const requestId = ++id, timer = setTimeout(() => reject(new Error(`CDP timeout: ${method}`)), 30000);
        pending.set(requestId, { resolve, reject, timer }); ws.send(JSON.stringify({ id: requestId, method, params }));
    });
}
async function evaluate(expression) {
    const result = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
}
async function wait(expression) {
    await evaluate(`new Promise((resolve,reject) => { const start=performance.now();const tick=()=>{if(${expression}) return resolve(); if(performance.now()-start>20000)return reject(new Error('UI wait failed'));setTimeout(tick,25);};tick();})`);
}
const $ = id => `document.getElementById('${id}')`;
async function exercisePeripherals(backend) {
    await evaluate(`document.querySelector('[data-peripheral=\"gpio\"]').click()`);
    await evaluate(`window.busPins=ESPIO.chips[window.peerChip].pins.filter(p=>!p.reserved&&p.output).slice(0,4).map(p=>p.id);`);
    await evaluate(`document.querySelector('[data-peripheral="i2c"]').click();for(const [i,role] of ['sda','scl'].entries()){const s=document.getElementById('i2c-'+role);s.value=String(busPins[i]);s.dispatchEvent(new Event('change'));}document.getElementById('i2c-apply').click();`);
    await wait(`${$('i2c-state')}.textContent.startsWith('AKTIV') && !${$('i2c-release')}.disabled`);
    await evaluate(`${$('i2c-register-bits')}.value='16';${$('i2c-register-start')}.value='0x123';${$('i2c-register-end')}.value='0x125';${$('i2c-register-endian')}.value='LE';${$('i2c-register-read')}.value='2';${$('i2c-register-scan')}.click();`);
    await wait(`${$('i2c-progress')}.textContent.includes('fertig')`);
    assert.equal(await evaluate(`${$('i2c-register-body')}.children.length`),3);
    assert.ok((await evaluate(`${$('i2c-register-body')}.textContent`)).includes('23 01'));
    await evaluate(`${$('i2c-register-start')}.value='97';${$('i2c-register-end')}.value='101';${$('i2c-register-scan')}.click();`);
    await wait(`${$('i2c-progress')}.textContent.includes('fertig') && ${$('i2c-register-body')}.children.length===5`);
    assert.equal(await evaluate(`${$('i2c-register-body')}.querySelectorAll('.bus-error').length`), 1);
    await evaluate(`${$('i2c-release')}.click()`);await wait(`${$('i2c-release')}.hidden`);
    await evaluate(`document.querySelector('[data-peripheral="spi"]').click();for(const [i,role] of ['clk','mosi','miso','cs'].entries()){const s=document.getElementById('spi-'+role);s.value=String(busPins[i]);s.dispatchEvent(new Event('change'));}${$('spi-apply')}.click();`);
    await wait(`!${$('spi-transfer')}.disabled`);await evaluate(`${$('spi-transfer')}.click()`);await wait(`${$('spi-result')}.textContent.startsWith('RX ')`);
    assert.equal(await evaluate(`${$('spi-result')}.textContent`),'RX 60 FF FF FF');
    await evaluate(`${$('spi-release')}.click()`);await wait(`${$('spi-release')}.hidden`);
    await evaluate(`document.querySelector('[data-peripheral="pwm"]').click();${$('pwm-pin')}.value=String(busPins[0]);${$('pwm-pin')}.dispatchEvent(new Event('change'));${$('pwm-apply')}.click();`);
    await wait(`!${$('pwm-update')}.disabled`);await evaluate(`${$('pwm-duty')}.value='750';${$('pwm-update')}.click()`);await wait(`${$('pwm-result')}.textContent.includes('750')`);
    await evaluate(`${$('pwm-release')}.click()`);await wait(`${$('pwm-release')}.hidden`);
    if (!['esp32c2','esp32c61'].includes(chip)) {
        await evaluate(`document.querySelector('[data-peripheral="rmt"]').click();${$('rmt-pin')}.value=String(busPins[0]);${$('rmt-pin')}.dispatchEvent(new Event('change'));${$('rmt-apply')}.click();`);
        await wait(`!${$('rmt-send')}.disabled`);
        await evaluate(`${$('rmt-count')}.value='1365';${$('rmt-send')}.click()`);
        await wait(`${$('rmt-result')}.textContent.startsWith('Gesendet')`);
        assert.ok((await evaluate(`${$('rmt-result')}.textContent`)).includes('32760'));
        assert.equal(await evaluate('serialPeer.rmtBytes'), 4095);
        await evaluate(`${$('rmt-release')}.click()`);await wait(`${$('rmt-release')}.hidden`);
    } else assert.equal(await evaluate(`!document.querySelector('[data-peripheral="rmt"]') || document.querySelector('[data-peripheral="rmt"]').disabled`), true);
    console.log(`PASS: ${chip} ${backend} I2C register table, SPI full duplex, LEDC duty and release.`);
}
try {
    await call('Runtime.enable'); await call('Page.enable');
    errors.length = 0; // Runtime.enable can replay exceptions from the previous page.
    await call('Network.enable'); await call('Network.setCacheDisabled', { cacheDisabled: true });
    await call('Page.navigate', { url: baseUrl + '/io-tool/' });
    await wait(`typeof ESPIO !== 'undefined' && !!ESPIO.startAccelerated && ${$('connect')} && document.querySelectorAll('[data-pin]').length`);
    assert.equal(await evaluate(`${$('load-accelerated')}.hidden`), true);
    await evaluate(`(() => {
        window.peerChip = ${JSON.stringify(chip)};
        const Native = ESPFlasher;
        const nativeFetch = window.fetch.bind(window);
        window.failStubFetch = false;
        window.fetch = (url, options) => window.failStubFetch && String(url).endsWith('/stub.json') ? Promise.resolve(new Response('', {status:404})) : nativeFetch(url, options);
        ESPFlasher = class extends Native {
            constructor(options) { super(options); this.model = new ESPIO.DemoTransport(ESPIO.chips[window.peerChip]); this.mockDecoder = new this.slipLayer.constructor(); this.sectorReads = 0; window.serialPeer = this; }
            async openPort() { this.port = { writable: true }; }
            async hardReset() { this.stubLoaded = false; }
            async sync() { this.current_chip = window.peerChip; this.stubLoaded = false; }
            async isStubLoader() { return false; }
            async downloadStub() { this.stubLoaded = true; return true; }
            async disconnect() { this.port = null; }
            async _writeFrame(frame) {
                for (const packet of this.mockDecoder.decode(frame)) {
                    const view = new DataView(packet.buffer, packet.byteOffset), word = offset => view.getUint32(offset, true);
                    if (packet[0] === 0) {
                        let value = 0;
                        if (packet[1] === 10) value = await this.model.read(word(8));
                        if (packet[1] === 9) await this.model.write(word(8), word(12), word(16), word(20));
                        const size = this.stubLoaded ? 2 : 4, response = new Uint8Array(8 + size);
                        response.set([1, packet[1], size, 0]); new DataView(response.buffer).setUint32(4, value, true);
                        await this.processPacket(response);
                    } else if (new TextDecoder().decode(packet.slice(0,4)) === 'SYNC') {
                        const target = ESPIO.acceleratedTargets[window.peerChip];
                        await this.processPacket(ESPIO.rpcEncode('identity', { protocol_major:1, protocol_minor:8, max_packet_length:1024, capabilities:1536 | (target.sdmmc ? 303 : 295) | (["esp32c2","esp32c61"].includes(window.peerChip)?0:16), chip:window.peerChip, cpu:target.cpu, cpu_cores:target.cores, build:ESPIO.rpcProtocol.buildVersion, idf:'6.1' }));
                    } else if (new TextDecoder().decode(packet.slice(0,4)) === 'IOCC') {
                        await this.processPacket(await this.captureReply(packet));
                    } else if (['I2CC','SPIC','PWMC','RMTC'].includes(new TextDecoder().decode(packet.slice(0,4)))) {
                        const tag=new TextDecoder().decode(packet.slice(0,4)),q=ESPIO.rpcDecode(packet,'peripheral_command',tag),v=new Array(8).fill(0);
                        let data=new Uint8Array(),status=0,error=0;
                        if(q.operation===4){if(tag==='I2CC'){v.splice(0,8,20,20,21,21,0x60000000,32,2,0);}else if(tag==='SPIC'){v.splice(0,8,22,23,24,25,0x60000000,2,64,0);}else if(tag==='RMTC'){v.splice(0,8,27,8,48,4096,40000000,3,0,0);}else{v.splice(0,8,26,8,4,19,0x3ffff,0,0,0);}}
                        if(q.operation===2&&tag==='I2CC')data=Uint8Array.from({length:q.args[2]},(_,i)=>(q.data[0]||0)+i);
                        if(q.operation===2&&tag==='SPIC')data=Uint8Array.from(q.data,b=>b^255);
                        if(tag==='I2CC'&&q.operation===2&&q.data[0]===99){status=5;error=9;data=new Uint8Array();}
                        if(tag==='RMTC'){if(q.operation===16){this.rmtSymbols=q.args[1];this.rmtBytes=0;}if(q.operation===17){if(q.args[0]!==this.rmtBytes)throw new Error('RMT upload offset');this.rmtBytes+=q.data.length;}if(q.operation===18){v[0]=this.rmtSymbols*q.args[0];v[1]=Math.ceil(v[0]/24);v[2]=v[0]*1.25+q.args[1];}}
                        await this.processPacket(ESPIO.rpcEncode('peripheral_response',{status,error,operation:q.operation,port:q.port,actual_hz:q.args[0]||1000000,values:v},tag.slice(0,3)+'R',data));
                    } else if (new TextDecoder().decode(packet.slice(0,4)) === 'FUSC') {
                        const q=ESPIO.rpcDecode(packet,'peripheral_command','FUSC'),record=(name,type,bits,data)=>{const text=new TextEncoder().encode(name),r=new Uint8Array(8+text.length+data.length),v=new DataView(r.buffer);v.setUint16(0,r.length,true);r[2]=text.length;r[3]=type;v.setUint16(4,bits,true);v.setUint16(6,data.length,true);r.set(text,8);r.set(data,8+text.length);return r;};
                        const records=[record('CHIP.MODEL',8,0,new TextEncoder().encode(window.peerChip)),record('ROM.ECO_VERSION',1,8,Uint8Array.of(5)),record('FUSE.MAC',6,48,Uint8Array.of(17,34,51,68,85,102)),record('FUSE.OPTIONAL_UNIQUE_ID',9,128,Uint8Array.from({length:16},(_,i)=>i)),record('FUSE.DEVICE_ONLY_'+window.peerChip,3,1,Uint8Array.of(1))],v=new Array(8).fill(0);v[3]=records.length;v[7]=1234;let data=new Uint8Array();
                        if(q.operation===4){v[0]=records.length;v[1]=1;v[2]=512;}
                        else{let cursor=q.args[0],length=0;const chunks=[];while(cursor<records.length&&length+records[cursor].length<=q.args[1]){chunks.push(records[cursor]);length+=records[cursor++].length;}data=new Uint8Array(length);let offset=0;for(const chunk of chunks){data.set(chunk,offset);offset+=chunk.length;}v[0]=q.args[0];v[1]=chunks.length;v[2]=cursor;}
                        await this.processPacket(ESPIO.rpcEncode('peripheral_response',{operation:q.operation,port:0,values:v},'FUSR',data));
                    } else if (new TextDecoder().decode(packet.slice(0,4)) === 'FLAC') {
                        const q=ESPIO.rpcDecode(packet,'peripheral_command','FLAC'),[a,n]=q.args,v=new Array(8).fill(0);
                        if(q.operation===21&&window.failFlashStep===q.args[0])continue;
                        this.flashMemory ||= new Uint8Array(131072).fill(255);let data=new Uint8Array();v[0]=n;
                        if(q.operation===21)v[0]=q.args[0];
                        if(q.operation===4||(q.operation===21&&q.args[0]===5))v.splice(0,8,0x1140ef,131072,4096,256,768,0,131072,1);
                        if(q.operation===16)data=this.flashMemory.slice(a,a+n);
                        if(q.operation===17)this.flashMemory.set(q.data,a);
                        if(q.operation===18)this.flashMemory.fill(255,a,a+n);
                        if(q.operation===20&&q.data.some((b,i)=>b!==this.flashMemory[a+i]))throw new Error('Flash verify mismatch');
                        if(q.operation===19){let crc=0xffffffff,first=0xffffffff;for(let i=0;i<n;i++){const b=this.flashMemory[a+i];if(b!==255&&first===0xffffffff)first=a+i;crc^=b;for(let j=0;j<8;j++)crc=(crc>>>1)^(crc&1?0xedb88320:0);}v[1]=(crc^0xffffffff)>>>0;v[2]=first;}
                        await this.processPacket(ESPIO.rpcEncode('peripheral_response',{operation:q.operation,port:0,values:v},'FLAR',data));
                    } else if (new TextDecoder().decode(packet.slice(0,4)) === 'SDMC') {
                        await this.processPacket(await this.sdReply(packet));
                    } else {
                        const cmd = ESPIO.rpcDecode(packet, 'register_command'); let value = 0;
                        if (cmd.operation === 0) {this.registerReads=(this.registerReads||0)+1;value = await this.model.read(cmd.address);}
                        else await this.model.write(cmd.address, cmd.value, cmd.mask, cmd.delay_us);
                        await this.processPacket(ESPIO.rpcEncode('register_response', { value }));
                    }
                }
            }
            async captureReply(packet) {
                const q=ESPIO.rpcDecode(packet,'capture_command'), samples=[];let detail=0;
                this.capturePlans ||= new Map();this.captureBanks ||= [];
                if(q.operation===1){const v=new DataView(q.data.buffer,q.data.byteOffset);this.captureBanks=Array.from({length:q.count},(_,i)=>v.getUint32(i*4,true));}
                if(q.operation===2){const p=ESPIO.rpcDecode(packet,'capture_plan');this.capturePlans.set(p.slot,p);}
                if(q.operation===3)for(const [bank,a]of this.captureBanks.entries())if(q.selection&1<<bank)samples.push([bank,0,await this.model.read(a),10]);
                if(q.operation===4){this.adcSweeps=(this.adcSweeps||0)+1;for(const [slot,p]of this.capturePlans)if(q.selection&1<<slot){const s=await this.adcReference.read(p.pin);samples.push([p.pin,1,s.raw,10]);}}
                if(q.operation===6){this.adcReference=new ESPIO.ADCReader(this.model,ESPIO.adcProfiles[window.peerChip]);await this.adcReference.open();detail=this.adcReference.calibration.version;for(const [unit,code]of Object.entries(this.adcReference.calibration.codes))samples.push([Number(unit),2,code,0]);}
                if(q.operation===5||q.operation===7){await this.adcReference?.close();this.adcReference=null;this.capturePlans.clear();}
                const data=new Uint8Array(samples.length*12),v=new DataView(data.buffer);samples.forEach(([pin,kind,value,us],i)=>{const o=i*12;v.setUint16(o,pin,true);v.setUint16(o+2,kind,true);v.setUint32(o+4,value,true);v.setUint32(o+8,us,true);});
                return ESPIO.rpcEncode('capture_response',{count:samples.length,failed_slot:65535,duration_us:100,detail},'IOCR',data);
            }
            async sdReply(packet) {
                const base = ESPIO.rpcDecode(packet, 'module_command', 'SDMC'), result = { operation:base.operation, port:base.port };
                let data = new Uint8Array();
                if (base.operation === 2) {
                    const cmd = ESPIO.rpcDecode(packet, 'sdmmc_command'), p = ESPIO.sdProfiles[window.peerChip], r = p.registers;
                    Object.assign(result, { command:cmd.command, response_type:cmd.response_type, argument:cmd.argument });
                    let flags = p.flags.start | p.flags.hold | 1<<16 | cmd.command;
                    flags |= cmd.command === 0 ? p.flags.initialClocks : p.flags.waitData;
                    if (cmd.response_type) flags |= p.flags.response;
                    if (cmd.response_type === 3) flags |= p.flags.longResponse;
                    if (![0,4].includes(cmd.response_type)) flags |= p.flags.crc;
                    if (cmd.data_bytes) {
                        this.sectorReads++;
                        const b=p.dmaBuffer, cpu=b.address+b.cpuOffset, regs=this.model.registers;
                        regs.set(cpu,0x8000001e);regs.set(cpu+4,512);regs.set(cpu+8,b.address+64);regs.set(cpu+12,0);
                        regs.set(r.descriptorList,b.address);regs.set(r.control,1<<5|1<<25);regs.set(r.dma,0x82);
                        flags |= p.flags.dataExpected;
                    }
                    await this.model.write(r.events,0xffff);await this.model.write(r.argument,cmd.argument);await this.model.write(r.command,flags);
                    result.events=this.model.registers.get(r.events)||0;
                    for(let i=0;i<4;i++)result['response'+i]=this.model.registers.get(r.response+4*i)||0;
                    if(cmd.data_bytes){
                        const b=p.dmaBuffer,cpu=b.address+b.cpuOffset;
                        Object.assign(result,{data_events:result.events,transferred:512,descriptor:this.model.registers.get(cpu)>>>0});
                        data=new Uint8Array(512);const view=new DataView(data.buffer);
                        for(let i=0;i<128;i++)view.setUint32(i*4,this.model.registers.get(cpu+64+i*4)||0,true);
                    }
                }
                return ESPIO.rpcEncode('sdmmc_response',result,'SDMR',data);
            }
        };
    })()`);
    assert.ok(['115200', '921600'].includes(await evaluate(`${$('baud')}.value`)));
    await evaluate(`${$('connection-options')}.click()`);
    assert.equal(await evaluate(`${$('connection-menu')}.hidden`), false);
    await evaluate(`document.querySelector('[name="connection-baud"][value="921600"]').click()`);
    assert.equal(await evaluate(`${$('baud')}.value`), '921600');
    assert.equal(await evaluate(`document.querySelectorAll('[name="connection-baud"]:checked').length`), 1);
    await evaluate(`document.querySelector('[name="connection-baud"][value="115200"]').click();document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}));`);
    assert.equal(await evaluate(`${$('connection-menu')}.hidden`), true);
    assert.equal(await evaluate(`${$('session-badge')}.textContent`), 'OFFLINE');
    await evaluate(`${$('classic-stub')}.checked=true;${$('baud')}.value='115200';${$('connect')}.click()`);
    await wait(`!${$('load-accelerated')}.hidden && !${$('load-accelerated')}.disabled`);
    await evaluate(`document.querySelector('.board-card:last-child').click()`);
    await wait(`!${$('disconnect')}.disabled`);
    assert.equal(await evaluate(`${$('read-mode')}.disabled && ${$('pin-function')}.disabled && ${$('set-high')}.disabled && document.querySelectorAll('[data-peripheral]:not([data-peripheral=\"gpio\"]):not(:disabled)').length===0`), true);
    assert.equal(await evaluate(`${$('pin-drive')}.disabled`), true, 'classic mode cannot change drive strength');
    assert.equal(await evaluate(`!!${$('load-accelerated')}.closest('.peripheral-panel')`), true);
    await evaluate(`window.failStubFetch=true;${$('load-accelerated')}.click()`);
    await wait(`${$('status')}.textContent.includes('HTTP 404') && !${$('load-accelerated')}.disabled`);
    assert.equal(await evaluate(`${$('connect')}.textContent`), 'Trennen', 'failed fetch preserves the legacy session');
    assert.equal(await evaluate(`${$('disconnect')}.hidden`), true);
    await evaluate(`window.failStubFetch=false;${$('load-accelerated')}.click()`);
    await wait(`${$('load-accelerated')}.textContent === ESPIO.i18n.t('Accelerated stub active') && ${$('status')}.textContent.includes('SYNC')`);
    await wait(`document.querySelector('[data-peripheral="fuses"]') && !document.querySelector('[data-peripheral="fuses"]').disabled`);
    assert.equal(await evaluate(`!!document.querySelector('[data-peripheral="uart"], [data-peripheral="i2s"]')`),false);
    await evaluate(`document.querySelector('[data-peripheral="fuses"]').click()`);
    assert.equal(await evaluate(`${$('fuses-panel')}.hidden || ${$('fuses-read')}.disabled`),false,'FUSES must open directly after accelerated handoff without GPIO or board clicks');
    assert.ok((await evaluate(`${$('accelerated-info')}.textContent`)).includes('1.8'));
    assert.equal(await evaluate(`${$('load-accelerated')}.disabled`), true);
    await evaluate(`document.querySelector('.board-card:last-child').click()`);
    await wait(`!${$('disconnect')}.disabled`);
    await evaluate(`const pin = ESPIO.chips[window.peerChip].pins.find(p=>p.id===4&&!p.reserved&&p.output)||ESPIO.chips[window.peerChip].pins.find(p=>!p.reserved&&p.output);document.querySelector('[data-pin="'+pin.id+'"]').dispatchEvent(new MouseEvent('click',{bubbles:true}));${$('pin-function')}.value='output';${$('pin-function')}.dispatchEvent(new Event('change'));`);
    await wait(`${$('pin-state')}.textContent === ESPIO.i18n.t('OUTPUT') && !${$('set-high')}.disabled`);
    await evaluate(`${$('set-high')}.click()`);
    await wait(`${$('drive-level')}.textContent === '1 / HIGH'`);
    for (const strength of [3, 0, 2]) {
        await evaluate(`${$('pin-drive')}.value='${strength}';${$('pin-drive')}.dispatchEvent(new Event('change'));`);
        await wait(`!${$('pin-drive')}.disabled`);
        assert.equal(await evaluate(`${$('pin-drive')}.value`), String(strength));
        assert.equal(await evaluate(`${$('drive-level')}.textContent`), '1 / HIGH');
    }
    await evaluate(`${$('pin-pull')}.value='up';${$('pin-pull')}.dispatchEvent(new Event('change'));`);
    await wait(`!${$('pin-pull')}.disabled`);
    assert.equal(await evaluate(`${$('pin-drive')}.value`), '2', 'pull changes retain drive strength');
    assert.equal(await evaluate(`(()=>{const a=${$('pin-pull')}.getBoundingClientRect(),b=${$('pin-drive')}.getBoundingClientRect();return Math.abs(a.width-b.width)<1&&Math.abs(a.y-b.y)<1&&a.right<b.left;})()`), true, 'pull and drive occupy equal columns on one row');
    await wait(`!${$('disconnect')}.disabled`);
    if (process.argv.includes('--gpio-only')) {
        await evaluate(`${$('disconnect')}.click()`);
        await wait(`${$('session-badge')}.textContent === 'OFFLINE'`);
        assert.deepEqual(errors, []);
        console.log(`PASS: ${chip} drive D0-D3, retained HIGH and pull settings, equal-width controls and classic-mode lockout; simulated serial peer.`);
    } else {
    await exercisePeripherals('accelerated');
    await evaluate(`document.querySelector('[data-peripheral="flash"]').click();${$('flash-probe')}.click();`);
    await wait(`!${$('flash-download')}.disabled`);
    assert.ok((await evaluate(`${$('flash-info')}.textContent`)).includes('131.072'));
    await evaluate(`${$('flash-check')}.click()`);await wait(`${$('flash-result')}.textContent.startsWith('Leer')`);
    await evaluate(`serialPeer.flashMemory.fill(0x55,0,3);serialPeer.flashMemory.fill(0x33,4104,8192);window.flashBytes=Uint8Array.from({length:4101},(_,i)=>i&255);const dt=new DataTransfer();dt.items.add(new File([flashBytes],'test.bin'));${$('flash-file')}.files=dt.files;${$('flash-file')}.dispatchEvent(new Event('change'));${$('flash-address')}.value='3';${$('flash-write')}.click();`);
    await wait(`${$('flash-result')}.textContent.startsWith('Geschrieben')`);
    assert.equal(await evaluate(`serialPeer.flashMemory.slice(3,4104).every((b,i)=>b===flashBytes[i]) && serialPeer.flashMemory[0]===0x55 && serialPeer.flashMemory[4104]===0x33`),true);
    await evaluate(`${$('flash-verify')}.click()`);await wait(`${$('flash-result')}.textContent.startsWith('Vergleich OK')`);
    await evaluate(`${$('flash-address')}.value='0';${$('flash-length')}.value='8192';window.flashDump=[];window.flashClosed=false;window.showSaveFilePicker=async()=>({createWritable:async()=>({write:async bytes=>flashDump.push(bytes.slice()),close:async()=>{window.flashClosed=true;},abort:async()=>{}})});${$('flash-download')}.click();`);
    await wait(`window.flashClosed && ${$('flash-result')}.textContent.startsWith('Download fertig')`);
    assert.equal(await evaluate(`flashDump.length===1 && flashDump[0].every((b,i)=>b===serialPeer.flashMemory[i])`),true);
    await evaluate(`window.confirm=()=>true;${$('flash-erase')}.click();`);await wait(`${$('flash-result')}.textContent.startsWith('Gelöscht')`);
    await evaluate(`${$('flash-check')}.click()`);await wait(`${$('flash-result')}.textContent.startsWith('Leer')`);
    console.log(`PASS: ${chip} FLASH probe, CRC/blank check, partial-sector program with preserved edges, verify, streaming download and erase; simulated memory.`);
    await evaluate(`document.querySelector('[data-peripheral="fuses"]').click();${$('fuses-read')}.click();`);
    await wait(`${$('fuses-state')}.textContent === '5 FELDER'`);
    assert.ok((await evaluate(`${$('fuses-records')}.textContent`)).includes('11:22:33:44:55:66'));
    assert.ok((await evaluate(`${$('fuses-records')}.textContent`)).includes('000102030405060708090A0B0C0D0E0F'));
    await evaluate(`${$('fuses-filter')}.value='DEVICE_ONLY';${$('fuses-filter')}.dispatchEvent(new Event('input'));`);
    assert.equal(await evaluate(`${$('fuses-records')}.querySelectorAll('tbody tr').length`),1);
    await evaluate(`window.nativeObjectURL=URL.createObjectURL;URL.createObjectURL=blob=>{window.fuseExport=blob;return nativeObjectURL(blob);};window.nativeAnchorClick=HTMLAnchorElement.prototype.click;HTMLAnchorElement.prototype.click=function(){};${$('fuses-export')}.click();URL.createObjectURL=nativeObjectURL;HTMLAnchorElement.prototype.click=nativeAnchorClick;`);
    assert.equal(await evaluate(`fuseExport.text().then(s=>JSON.parse(s).records.length)`),5);
    console.log(`PASS: ${chip} FUSES renders device-defined TLVs, exact MAC/128-bit ID, an unknown chip-specific field, filtering and JSON export.`);
    await evaluate(`document.querySelector('[data-peripheral="gpio"]').click();window.loadPin=ESPIO.chips[window.peerChip].pins.find(p=>!p.reserved&&p.output&&ESPIO.adcProfiles[window.peerChip]?.channels[p.id]&&p.id%3===1)||ESPIO.chips[window.peerChip].pins.find(p=>p.id===4&&!p.reserved&&p.output)||ESPIO.chips[window.peerChip].pins.find(p=>!p.reserved&&p.output);document.querySelector('[data-pin="'+loadPin.id+'"]').dispatchEvent(new MouseEvent('click',{bubbles:true}));${$('scan-target')}.value='selected';${$('scan-settle')}.value='50';${$('scan-load-profile')}.checked=true;${$('scan-start')}.click();`);
    await wait(`${$('scan-state')}.textContent === 'FERTIG' && !${$('scan-start')}.disabled`);
    assert.equal(await evaluate(`${$('scan-results')}.querySelectorAll('.load-xy [data-level="1"]').length`),5);
    assert.equal(await evaluate(`${$('scan-results')}.querySelectorAll('.load-xy [data-level="0"]').length`),5);
    assert.equal(await evaluate(`${$('scan-results')}.innerHTML.includes('NaN')`),false);
    await evaluate(`window.nativeObjectURL=URL.createObjectURL;URL.createObjectURL=blob=>{window.loadExport=blob;return nativeObjectURL(blob);};window.nativeAnchorClick=HTMLAnchorElement.prototype.click;HTMLAnchorElement.prototype.click=function(){};${$('scan-export')}.click();URL.createObjectURL=nativeObjectURL;HTMLAnchorElement.prototype.click=nativeAnchorClick;`);
    assert.deepEqual(await evaluate(`loadExport.text().then(s=>JSON.parse(s).results[0].loadProfile.stages.map(r=>r.label))`),['Pulls','D0','D1','D2','D3']);
    console.log(`PASS: ${chip} Usage load sweep plots separate HIGH/LOW curves over Pull/D0-D3, with exact JSON export and restored GPIO.`);
    if(await evaluate(`!!ESPIO.adcProfiles[window.peerChip]`)){
        await evaluate(`const id=Object.keys(ESPIO.adcProfiles[window.peerChip].channels).map(Number).find(id=>document.querySelector('[data-pin="'+id+'"]')&&!ESPIO.chips[window.peerChip].pins.find(p=>p.id===id).reserved);document.querySelector('[data-pin="'+id+'"]').dispatchEvent(new MouseEvent('click',{bubbles:true}));${$('read-mode')}.value='adc';${$('read-mode')}.dispatchEvent(new Event('change'));`);
        await wait(`!${$('adc-info')}.hidden && (serialPeer.adcSweeps||0)>3 && !${$('read-mode')}.disabled`);
        const before=await evaluate(`({reads:serialPeer.registerReads,sweeps:serialPeer.adcSweeps})`);
        await wait(`serialPeer.adcSweeps>${before.sweeps}+5`);
        assert.equal(await evaluate(`serialPeer.registerReads`),before.reads);
        await evaluate(`${$('read-mode')}.value='digital';${$('read-mode')}.dispatchEvent(new Event('change'));`);
        await wait(`${$('adc-info')}.hidden && !${$('read-mode')}.disabled`);
        console.log(`PASS: ${chip} native ADC calibration and one-command sweeps; no register polling during acquisition.`);
    }

    if (sd) {
        await evaluate(`document.querySelector('[data-peripheral="sd"]').click();for(const [role,pin] of Object.entries({d0:4,cmd:15,clk:16})){const s=document.getElementById('sd-'+role);s.value=String(pin);s.dispatchEvent(new Event('change'));}${chip === 'esp32p4' ? `${$('sd-clock')}.value='5000000';${$('sd-clock')}.dispatchEvent(new Event('change'));` : ''}`);
        assert.equal(await evaluate(`${$('sd-identify')}.disabled`), false);
        assert.ok((await evaluate(`${$('sd-backend')}.textContent`)).includes('Accelerated RPC'));
        await evaluate(`${$('sd-identify')}.click()`);
        await wait(`!${$('sd-card')}.hidden && !${$('sd-download')}.disabled`);
        assert.ok((await evaluate(`${$('sd-card')}.textContent`)).includes(chip === 'esp32p4' ? '5000 kHz' : '400 kHz'));
        await evaluate(`window.dumpChunks=[];window.dumpClosed=false;window.showSaveFilePicker=async()=>({createWritable:async()=>({write:async bytes=>dumpChunks.push(bytes.slice()),close:async()=>{window.dumpClosed=true;},truncate:async()=>{}})});${$('sd-download-start')}.value='20';${$('sd-download-mib')}.value='1';${$('sd-download-size')}.click();`);
        assert.equal(await evaluate(`${$('sd-download-end')}.value`), '2067');
        await evaluate(`${$('sd-download')}.click()`);
        await wait(`window.dumpClosed && ${$('sd-download-status')}.textContent.includes('Fertig')`);
        assert.equal(await evaluate(`window.dumpChunks.length`), 16);
        assert.equal(await evaluate(`window.serialPeer.sectorReads`), 2048);
        assert.equal(await evaluate(`window.dumpChunks.every((chunk,ci)=>chunk.length===65536 && chunk.every((byte,bi)=>byte===((20+ci*128+Math.floor(bi/512))*17+bi%512 & 255)))`), true);
        console.log(`PASS: ${chip} SD UI uses shared RPC, identifies card, sets a 1-MiB range and downloads exact sectors to 64-KiB file batches.`);
    }
    await evaluate(`${$('disconnect')}.click()`);
    await wait(`${$('load-accelerated')}.hidden && ${$('session-badge')}.textContent === 'OFFLINE'`);
    await evaluate(`${$('classic-stub')}.checked=false;${$('connect')}.click()`);
    await wait(`${$('load-accelerated')}.textContent === 'Accelerated stub active' && ${$('status')}.textContent.includes('SYNC verified')`);
    if(chip==='esp32p4'){
        await evaluate(`window.failFlashStep=2;document.querySelector('[data-peripheral="flash"]').click();${$('flash-probe')}.click();`);
        await wait(`${$('flash-result')}.textContent.includes('Schritt 2') && ${$('status')}.textContent.includes('Schritt 2')`);
        assert.ok((await evaluate(`${$('status')}.textContent`)).includes('ROM Lesemodus'));
        console.log('PASS: P4 injected flash timeout retains the exact probe phase in the panel and stopped-measurement banner.');
    }
    await evaluate(`${$('connect')}.click()`);
    await wait(`${$('session-badge')}.textContent === 'OFFLINE'`);
    assert.deepEqual(errors, []);
    console.log(`PASS: ${chip} legacy connect, missing-build recovery, RAM upload/SYNC, identity display, GPIO via RPC and disconnect; simulated serial peer.`);
    }
} finally { ws.close(); }
