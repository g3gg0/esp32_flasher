// Local browser QA via the DevTools protocol. Start a separate headless Edge
// with --remote-debugging-port=9235 and the repository HTTP server on 8088.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const pages = await (await fetch('http://127.0.0.1:9235/json/list')).json();
const page = pages.find(item => item.type === 'page' && item.url.includes('/io-tool/'));
assert.ok(page, 'Open the io-tool page in the QA browser first.');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true }); });
let id = 0;
const pending = new Map(), errors = [];
ws.addEventListener('message', ({ data }) => {
    const message = JSON.parse(data);
    if (message.id) {
        const item = pending.get(message.id); if (!item) return;
        pending.delete(message.id); clearTimeout(item.timeout);
        message.error ? item.reject(new Error(JSON.stringify(message.error))) : item.resolve(message.result);
    } else if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails);
});
function call(method, params = {}) {
    return new Promise((resolve, reject) => {
        const requestId = ++id;
        const timeout = setTimeout(() => { pending.delete(requestId); reject(new Error(`CDP timeout: ${method}`)); }, 45000);
        pending.set(requestId, { resolve, reject, timeout }); ws.send(JSON.stringify({ id: requestId, method, params }));
    });
}
async function evaluate(expression) {
    const result = await call('Runtime.evaluate', { expression: `{${expression}\n}`, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
}
async function wait(expression) {
    return evaluate(`new Promise((resolve,reject) => { const start=performance.now(); const poll=()=>{if(${expression}) return resolve(true); if(performance.now()-start>30000) return reject(new Error('Wait failed: '+${JSON.stringify(expression)})); setTimeout(poll,30);}; poll(); })`);
}
async function screenshot(name, selector) {
    const dir = new URL('../screenshots/', import.meta.url); await mkdir(dir, { recursive: true });
    const clip = selector ? await evaluate(`const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();({x:r.x+scrollX,y:r.y+scrollY,width:r.width,height:r.height,scale:1})`) : undefined;
    const shot = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, ...(clip ? { clip } : {}) });
    await writeFile(new URL(`${name}.png`, dir), Buffer.from(shot.data, 'base64'));
    console.log(`Screenshot: ${fileURLToPath(new URL(`${name}.png`, dir))}`);
}

try {
    await call('Runtime.discardConsoleEntries'); await call('Runtime.enable'); await call('Page.enable');
    await call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false });
    await call('Page.navigate', { url: 'http://127.0.0.1:8088/io-tool/' });
    await wait(`document.querySelectorAll('[data-pin]').length === 13`);
    assert.equal(await evaluate(`document.getElementById('session-badge').textContent`), 'OFFLINE');
    await evaluate(`document.getElementById('demo').click()`);
    await wait(`document.getElementById('session-badge').textContent.includes('SIMULATION') && document.getElementById('sampling').textContent.includes('Samples/s')`);
    await evaluate(`document.querySelector('[data-pin="0"]').dispatchEvent(new MouseEvent('click',{bubbles:true})); const s=document.getElementById('pin-function');s.value='output';s.dispatchEvent(new Event('change'));`);
    await wait(`document.getElementById('pin-state').textContent === 'OUTPUT' && !document.getElementById('set-high').disabled`);
    await evaluate(`document.getElementById('set-high').click()`);
    await wait(`document.getElementById('read-level').textContent === '1 / HIGH' && document.getElementById('drive-level').textContent === '1 / HIGH'`);
    await evaluate(`new Promise(resolve=>setTimeout(resolve,1100))`);
    assert.equal(await evaluate(`document.querySelector('button[aria-label="GPIO 0 Ausgang umschalten"]').hidden`), false);
    await screenshot('c3-output');
    await evaluate(`const s=document.getElementById('pin-function');s.value='spi';s.dispatchEvent(new Event('change'));`);
    assert.equal(await evaluate(`document.getElementById('planned-function').hidden`), false);
    assert.equal(await evaluate(`document.getElementById('pin-state').textContent`), 'OUTPUT');
    await evaluate(`document.getElementById('pause').click()`);
    await wait(`document.getElementById('pause').textContent.includes('Fortsetzen')`);
    assert.equal(await evaluate(`document.getElementById('set-high').disabled`), true);
    assert.equal(await evaluate(`document.getElementById('read-level').textContent`), '—');
    await evaluate(`document.getElementById('pause').click()`);
    await wait(`document.getElementById('pause').textContent.includes('Pause')`);

    await evaluate(`document.getElementById('read-mode').value='adc';document.getElementById('read-mode').dispatchEvent(new Event('change'));`);
    await wait(`document.getElementById('read-label').textContent.includes('ADC') && Number(document.getElementById('read-level').textContent)>3000`);
    assert.equal(await evaluate(`document.getElementById('pin-state').textContent`), 'OUTPUT');
    await evaluate(`document.querySelector('[data-pin="7"]').dispatchEvent(new MouseEvent('click',{bubbles:true}));`);
    assert.equal(await evaluate(`document.getElementById('read-level').textContent`), 'kein ADC');
    assert.equal(await evaluate(`document.getElementById('scan-start').disabled`), false);
    await evaluate(`document.getElementById('scan-start').click();`);
    await wait(`document.getElementById('scan-state').textContent==='FERTIG'`);
    assert.ok(await evaluate(`document.getElementById('scan-results').textContent.includes('Nur digital gemessen')`));
    assert.ok(await evaluate(`document.getElementById('pin-scope-plot').textContent.includes('kein ADC')`));
    assert.equal(await evaluate(`document.getElementById('pin-scope-plot').textContent.includes('4095')`), false);
    await screenshot('usage-digital-pin');
    await evaluate(`document.querySelector('[data-pin="0"]').dispatchEvent(new MouseEvent('click',{bubbles:true}));document.getElementById('scan-start').click();`);
    await wait(`document.getElementById('scan-state').textContent==='FERTIG'`);
    assert.equal(await evaluate(`document.getElementById('pin-state').textContent`), 'OUTPUT');
    assert.equal(await evaluate(`document.getElementById('read-mode').value`), 'adc');
    assert.ok((await evaluate(`document.getElementById('scan-results').textContent`)).includes('SIMULATION'));
    assert.equal(await evaluate(`document.getElementById('scan-method')`), null);
    assert.deepEqual(await evaluate(`Array.from(document.getElementById('scan-settle').options, o=>o.value)`), ['50', '100', '200']);
    assert.equal(await evaluate(`document.getElementById('scan-start').disabled`), false);
    assert.equal(await evaluate(`document.getElementById('drive-ack')`), null);
    await evaluate(`document.getElementById('scan-start').click();`);
    await wait(`document.getElementById('scan-state').textContent==='FERTIG' && document.getElementById('scan-results').textContent.includes('Output')`);
    await wait(`document.getElementById('drive-level').textContent==='1 / HIGH'`);
    await evaluate(`document.getElementById('scan-start').click();`);
    await wait(`document.getElementById('scan-state').textContent==='FERTIG' && document.getElementById('scan-results').textContent.includes('Pull + Output')`);
    assert.equal(await evaluate(`document.getElementById('pin-scope').hidden`), false);
    assert.equal(await evaluate(`document.querySelectorAll('#scan-results .scope-plot svg').length`), 1);
    assert.ok(await evaluate(`document.getElementById('pin-scope-stats').textContent.includes('OUT D3:')`));
    assert.equal(await evaluate(`document.querySelectorAll('#pin-scope-plot [data-trace]').length`), 5);
    assert.ok(await evaluate(`document.querySelectorAll('#pin-scope-plot circle').length>12`));
    await screenshot('adc-pin-scope');
    await evaluate(`document.getElementById('scan-target').value='all';document.getElementById('scan-target').dispatchEvent(new Event('change'));document.getElementById('scan-start').click();`);
    await wait(`document.getElementById('scan-state').textContent==='FERTIG' && document.querySelectorAll('.scan-table tr').length===23`);
    await screenshot('adc-usage-scan');
    await evaluate(`document.getElementById('scan-settle').value='100';document.getElementById('scan-start').click();`);
    await wait(`document.getElementById('scan-state').textContent.includes('GPIO') && !document.getElementById('scan-cancel').hidden`);
    await evaluate(`document.getElementById('scan-cancel').click();`);
    await wait(`document.getElementById('scan-state').textContent==='ABGEBROCHEN' && !document.getElementById('pause').disabled`);
    await evaluate(`document.getElementById('read-mode').value='digital';document.getElementById('read-mode').dispatchEvent(new Event('change'));`);
    await wait(`document.getElementById('read-label').textContent==='GELESEN' && document.getElementById('read-level').textContent==='1 / HIGH'`);
    await evaluate(`document.getElementById('catalog-details').open=true;`);
    await wait(`document.querySelectorAll('.register-table tr').length > 1`);
    await evaluate(`document.getElementById('register-filter').value='RMT';document.getElementById('register-filter').dispatchEvent(new Event('input'));`);
    await wait(`document.getElementById('register-list').textContent.includes('RMT')`);
    await evaluate(`document.querySelector('[data-board="raw-esp32c3"]').click()`);
    await wait(`document.querySelectorAll('[data-pin]').length === 22 && !document.getElementById('pause').disabled`);
    await evaluate(`document.querySelector('[data-pin="18"]').dispatchEvent(new MouseEvent('click',{bubbles:true}));`);
    assert.equal(await evaluate(`document.getElementById('pin-state').textContent`), 'RESERVIERT');
    assert.equal(await evaluate(`document.getElementById('pin-function').disabled`), true);
    await evaluate(`document.getElementById('disconnect').click()`);
    await wait(`document.getElementById('session-badge').textContent === 'OFFLINE' && !document.getElementById('preview-chip').disabled`);
    for (const [chip, count, boardId] of [['esp32c6', 22], ['esp32p4', 34], ['esp32s3', 35, 's3-supermini'], ['esp32s3', 36, 'ai-s3'], ['esp32h2', 19, 'h2-supermini']]) {
        await evaluate(`const s=document.getElementById('preview-chip');s.value=${JSON.stringify(chip)};s.dispatchEvent(new Event('change'));`);
        if (boardId) await evaluate(`document.querySelector('[data-board="${boardId}"]').click()`);
        assert.equal(await evaluate(`document.querySelectorAll('[data-pin]').length`), count);
        assert.ok(await evaluate(`const svg=document.getElementById('board-svg'),box=svg.viewBox.baseVal;[...svg.querySelectorAll('[data-pin] circle')].every(p=>Number(p.getAttribute('cy'))+Number(p.getAttribute('r'))<box.height)`));
        await evaluate(`document.getElementById('demo').click()`);
        await wait(`document.getElementById('sampling').textContent.includes('SIMULIERT') && !document.getElementById('pause').disabled`);
        if (chip === 'esp32h2') await evaluate(`document.querySelector('[data-pin="1"]').dispatchEvent(new MouseEvent('click',{bubbles:true}));`);
        await evaluate(`document.getElementById('read-mode').value='adc';document.getElementById('read-mode').dispatchEvent(new Event('change'));`);
        await wait(`document.getElementById('read-label').textContent.includes('ADC') && Number.isFinite(Number(document.getElementById('read-level').textContent))`);
        await evaluate(`document.getElementById('scan-settle').value='50';document.getElementById('scan-target').value='selected';document.getElementById('scan-target').dispatchEvent(new Event('change'));document.getElementById('scan-start').click();`);
        await wait(`document.getElementById('scan-state').textContent==='FERTIG'`);
        await evaluate(`new Promise(resolve=>setTimeout(resolve,1100))`);
        await screenshot(boardId || chip);
        await evaluate(`document.getElementById('disconnect').click()`);
        await wait(`document.getElementById('session-badge').textContent === 'OFFLINE' && !document.getElementById('preview-chip').disabled`);
        const exported = await evaluate(`const old=URL.createObjectURL;URL.createObjectURL=blob=>{window.__qaExportBlob=blob;return old(blob)};document.getElementById('scan-export').click();URL.createObjectURL=old;window.__qaExportBlob.text().then(JSON.parse);`);
        assert.equal(exported.simulation, true); assert.equal(exported.chip, chip);
        assert.equal(exported.results[0].measurement, 'adc');
        assert.deepEqual(exported.results[0].runs.map(run => run.method), ['pull', 'drive']);
        assert.ok(exported.results[0].runs.every(run => run.samples.every(sample => Number.isFinite(sample.raw))));
    }

    // P4 SD: configuration is a draft until activation, then pin leases protect
    // native SDMMC routing while the existing GPIO poller remains running.
    await evaluate(`const s=document.getElementById('preview-chip');s.value='esp32p4';s.dispatchEvent(new Event('change'));document.querySelector('[data-peripheral="sd"]').click();`);
    assert.equal(await evaluate(`document.getElementById('sd-panel').hidden`), false);
    assert.equal(await evaluate(`document.getElementById('sd-identify').disabled`), true);
    await evaluate(`for(const [role,pin] of Object.entries({d0:4,cmd:15,clk:16})){const s=document.getElementById('sd-'+role);s.value=String(pin);s.dispatchEvent(new Event('change'));}`);
    assert.equal(await evaluate(`document.querySelectorAll('.sd-pin').length`), 3);
    await evaluate(`document.getElementById('demo').click();`);
    await wait(`!document.getElementById('sd-identify').disabled`);
    await evaluate(`const s=document.getElementById('sd-cmd');s.value='4';s.dispatchEvent(new Event('change'));`);
    assert.equal(await evaluate(`document.getElementById('sd-identify').disabled`), true);
    assert.ok(await evaluate(`document.getElementById('sd-config-note').textContent.includes('mehrfach')`));
    await evaluate(`const s=document.getElementById('sd-cmd');s.value='15';s.dispatchEvent(new Event('change'));document.querySelector('[data-pin="4"]').dispatchEvent(new MouseEvent('click',{bubbles:true}));const f=document.getElementById('pin-function');f.value='output';f.dispatchEvent(new Event('change'));`);
    await wait(`document.getElementById('pin-state').textContent==='OUTPUT' && !document.getElementById('set-high').disabled`);
    await evaluate(`document.getElementById('set-high').click()`);
    await wait(`document.getElementById('drive-level').textContent==='1 / HIGH'`);
    await evaluate(`document.getElementById('sd-identify').click()`);
    await wait(`document.getElementById('sd-progress').textContent.includes('Karte identifiziert') && !document.getElementById('sd-send').disabled`);
    assert.ok(await evaluate(`document.getElementById('sd-card').textContent.includes('DEMO4') && document.getElementById('sd-card').textContent.includes('8.589.934.592')`));
    assert.ok(await evaluate(`document.getElementById('sd-card').textContent.includes('SIMULIERTE KARTE')`));
    assert.equal(await evaluate(`document.getElementById('pin-state').textContent`), 'SD');
    assert.equal(await evaluate(`document.getElementById('pin-function').disabled`), true);
    assert.equal(await evaluate(`document.getElementById('scan-start').disabled`), true);
    assert.equal(await evaluate(`document.getElementById('sd-argument').value`), '0x12340000');
    await evaluate(`document.getElementById('sd-send').click();`);
    await wait(`document.getElementById('sd-progress').textContent.includes('CMD13 abgeschlossen.') && !document.getElementById('sd-send').disabled`);
    await evaluate(`document.querySelector('[data-peripheral="sd"]').click()`);
    assert.equal(await evaluate(`document.getElementById('sd-panel').hidden`), true);
    await evaluate(`document.querySelector('[data-peripheral="sd"]').click();document.getElementById('sd-release').click()`);
    await wait(`document.getElementById('sd-state').textContent==='NICHT AKTIV' && document.getElementById('pin-state').textContent==='OUTPUT'`);
    assert.equal(await evaluate(`document.getElementById('drive-level').textContent`), '1 / HIGH');
    await evaluate(`for(const [role,pin] of Object.entries({d1:5,d2:6,d3:14})){const s=document.getElementById('sd-'+role);s.value=String(pin);s.dispatchEvent(new Event('change'));}document.getElementById('sd-width').value='4';document.getElementById('sd-width').dispatchEvent(new Event('change'));document.getElementById('sd-identify').click();`);
    await wait(`document.getElementById('sd-state').textContent.includes('4 BIT') && !document.getElementById('sd-send').disabled`);
    assert.equal(await evaluate(`document.querySelectorAll('.sd-pin').length`), 6);
    assert.ok(await evaluate(`document.getElementById('sd-log').textContent.includes('ACMD6')`));
    await screenshot('p4-sd-identified');
    await screenshot('p4-sd-panel', '#sd-panel');
    await call('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await screenshot('p4-sd-mobile');
    assert.ok(await evaluate(`document.documentElement.scrollWidth<=document.documentElement.clientWidth+1`));
    await call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false });
    await evaluate(`document.getElementById('sd-release').click();`);
    await wait(`document.getElementById('sd-state').textContent==='NICHT AKTIV' && !document.getElementById('sd-identify').disabled`);
    await evaluate(`document.getElementById('sd-board-preset').click();`);
    assert.equal(await evaluate(`document.getElementById('sd-d0').value`), '39');
    assert.equal(await evaluate(`document.getElementById('sd-identify').disabled`), false);
    assert.equal(await evaluate(`document.querySelectorAll('.sd-pin').length`), 6);
    await evaluate(`document.querySelector('[data-pin="45"]').dispatchEvent(new MouseEvent('click',{bubbles:true}));document.querySelector('[data-peripheral="ldo4"]').click();`);
    assert.equal(await evaluate(`document.getElementById('ldo4-state').textContent`), 'UNBEKANNT');
    assert.equal(await evaluate(`document.getElementById('pin-function').disabled`), false);
    assert.ok(await evaluate(`document.getElementById('pin-note').textContent.includes('LDO4-Domäne')`));
    await evaluate(`document.getElementById('ldo4-refresh').click();`);
    await wait(`document.getElementById('ldo4-state').textContent==='AUS' && !document.getElementById('ldo4-apply').disabled`);
    assert.equal(await evaluate(`document.getElementById('pin-function').disabled`), false);
    await evaluate(`document.getElementById('ldo4-mode').value='bypass';document.getElementById('ldo4-apply').click();`);
    await wait(`document.getElementById('ldo4-state').textContent.includes('BYPASS') && !document.getElementById('pin-function').disabled`);
    await evaluate(`const s=document.getElementById('pin-function');s.value='output';s.dispatchEvent(new Event('change'));`);
    await wait(`document.getElementById('pin-state').textContent==='OUTPUT' && !document.getElementById('set-low').disabled`);
    await evaluate(`document.getElementById('set-low').click();document.querySelector('[data-peripheral="sd"]').click();`);
    await evaluate(`document.getElementById('sd-identify').click();`);
    await wait(`document.getElementById('sd-progress').textContent.includes('Karte identifiziert') && !document.getElementById('sd-send').disabled`);
    assert.equal(await evaluate(`document.getElementById('ldo4-apply').disabled`), true);
    await screenshot('p4-sd-onboard', '#sd-panel');
    await evaluate(`document.getElementById('sd-release').click();`);
    await wait(`document.getElementById('sd-state').textContent==='NICHT AKTIV' && !document.getElementById('sd-identify').disabled`);
    assert.ok(await evaluate(`document.getElementById('ldo4-state').textContent.includes('BYPASS')`));
    assert.equal(await evaluate(`document.getElementById('pin-state').textContent`), 'OUTPUT');
    await evaluate(`window.__sdCommand=ESPIO.SDHost.prototype.command;ESPIO.SDHost.prototype.command=async function(...args){await new Promise(resolve=>setTimeout(resolve,200));return window.__sdCommand.apply(this,args)};document.getElementById('sd-identify').click();`);
    await wait(`!document.getElementById('sd-cancel').hidden`);
    await evaluate(`document.getElementById('sd-cancel').click();`);
    await wait(`document.getElementById('sd-progress').textContent.includes('abgebrochen') && document.getElementById('sd-state').textContent==='NICHT AKTIV'`);
    await evaluate(`ESPIO.SDHost.prototype.command=window.__sdCommand;document.getElementById('sd-identify').click();`);
    await wait(`document.getElementById('sd-progress').textContent.includes('Karte identifiziert') && !document.getElementById('sd-send').disabled`);
    await evaluate(`document.querySelector('[data-board="raw-esp32p4"]').click();`);
    await wait(`document.getElementById('sd-state').textContent==='NICHT AKTIV' && !document.getElementById('pause').disabled`);
    assert.equal(await evaluate(`document.getElementById('ldo4-state').textContent`), 'UNBEKANNT');
    await evaluate(`document.querySelector('[data-pin="45"]').dispatchEvent(new MouseEvent('click',{bubbles:true}));document.querySelector('[data-peripheral="ldo4"]').click();document.getElementById('ldo4-mode').value='off';document.getElementById('ldo4-apply').click();`);
    await wait(`document.getElementById('ldo4-state').textContent==='AUS' && !document.getElementById('pin-function').disabled`);
    assert.equal(await evaluate(`document.getElementById('pin-state').textContent`), 'INPUT');
    assert.equal(await evaluate(`document.getElementById('sd-identify').disabled`), false);
    await evaluate(`document.getElementById('disconnect').click();`);
    await wait(`document.getElementById('session-badge').textContent==='OFFLINE' && !document.getElementById('preview-chip').disabled`);
    // S3 uses the same native SD protocol and download UI, but its own clock,
    // register map and GPIO matrix. Neither S3 board has a built-in SD socket.
    for (const boardId of ['s3-supermini', 'ai-s3']) {
        await evaluate(`const s=document.getElementById('preview-chip');s.value='esp32s3';s.dispatchEvent(new Event('change'));document.querySelector('[data-board="${boardId}"]').click();document.querySelector('[data-peripheral="sd"]').click();`);
        assert.equal(await evaluate(`document.getElementById('sd-configuration').hidden`), false);
        assert.ok(await evaluate(`document.getElementById('sd-backend').textContent.includes('ESP32-S3') && document.getElementById('sd-backend').textContent.includes('SDMMC')`));
        assert.equal(await evaluate(`document.querySelector('[data-peripheral="ldo4"]')`), null);
        assert.equal(await evaluate(`document.getElementById('sd-board-preset').hidden`), true);
        await evaluate(`for(const [role,pin] of Object.entries({d0:4,d1:5,d2:6,d3:7,cmd:12,clk:13})){const s=document.getElementById('sd-'+role);s.value=String(pin);s.dispatchEvent(new Event('change'));}document.getElementById('sd-width').value='4';document.getElementById('sd-width').dispatchEvent(new Event('change'));document.getElementById('demo').click();`);
        await wait(`!document.getElementById('sd-identify').disabled`);
        await evaluate(`document.getElementById('sd-identify').click();`);
        await wait(`document.getElementById('sd-state').textContent.includes('4 BIT') && !document.getElementById('sd-send').disabled`);
        assert.ok(await evaluate(`document.getElementById('sd-card').textContent.includes('SIMULIERTE KARTE')`));
        assert.ok(await evaluate(`document.getElementById('sd-log').textContent.includes('ACMD6')`));
        assert.equal(await evaluate(`document.querySelectorAll('.sd-pin').length`), 6);
        await evaluate(`window.__qaSavePicker=window.showSaveFilePicker;window.__qaSDChunks=[];window.__qaSDClosed=false;window.showSaveFilePicker=async()=>({createWritable:async()=>({write:async data=>window.__qaSDChunks.push(Array.from(data)),close:async()=>{window.__qaSDClosed=true}})});document.getElementById('sd-download-start').value='2';document.getElementById('sd-download-end').value='3';document.getElementById('sd-download-end').dispatchEvent(new Event('input'));document.getElementById('sd-download').click();`);
        await wait(`document.getElementById('sd-download-status').textContent.includes('Fertig') && window.__qaSDClosed`);
        const chunks = await evaluate(`window.__qaSDChunks`);
        assert.equal(chunks.length, 2);
        for (let sector = 0; sector < 2; sector++) {
            assert.equal(chunks[sector].length, 512);
            for (let byte = 0; byte < 512; byte++) assert.equal(chunks[sector][byte], ((sector + 2) * 17 + byte) & 255);
        }
        await evaluate(`window.showSaveFilePicker=window.__qaSavePicker;`);
        await screenshot(`${boardId}-sd`, '#sd-panel');
        await evaluate(`document.getElementById('sd-release').click();`);
        await wait(`document.getElementById('sd-state').textContent==='NICHT AKTIV' && !document.getElementById('sd-identify').disabled`);
        await evaluate(`document.getElementById('disconnect').click();`);
        await wait(`document.getElementById('session-badge').textContent==='OFFLINE' && !document.getElementById('preview-chip').disabled`);
    }
    await evaluate(`const s=document.getElementById('preview-chip');s.value='esp32c3';s.dispatchEvent(new Event('change'));document.querySelector('[data-peripheral="sd"]').click();`);
    assert.equal(await evaluate(`document.getElementById('sd-configuration').hidden`), true);
    assert.ok(await evaluate(`document.getElementById('sd-backend').textContent.includes('SPI')`));

    // GPIO-only profiles must offer a scan as well, including a digital export.
    await evaluate(`const s=document.getElementById('preview-chip');s.value='esp32s2';s.dispatchEvent(new Event('change'));document.getElementById('demo').click();`);
    await wait(`document.getElementById('session-badge').textContent.includes('SIMULATION') && !document.getElementById('scan-start').disabled`);
    assert.equal(await evaluate(`document.getElementById('read-mode').options[1].disabled`), true);
    await evaluate(`document.getElementById('scan-start').click();`);
    await wait(`document.getElementById('scan-state').textContent==='FERTIG'`);
    assert.ok(await evaluate(`document.getElementById('scan-results').textContent.includes('GPIO 0/1')`));
    const digitalExport = await evaluate(`const old=URL.createObjectURL;URL.createObjectURL=blob=>{window.__qaExportBlob=blob;return old(blob)};document.getElementById('scan-export').click();URL.createObjectURL=old;window.__qaExportBlob.text().then(JSON.parse);`);
    assert.equal(digitalExport.results[0].measurement, 'digital');
    assert.equal(digitalExport.results[0].baseline.raw, null);
    assert.ok(digitalExport.results[0].runs.every(run=>run.samples.every(sample=>sample.raw===null && [0,1].includes(sample.io))));
    await evaluate(`document.getElementById('disconnect').click()`);
    await wait(`document.getElementById('session-badge').textContent === 'OFFLINE' && !document.getElementById('preview-chip').disabled`);

    // Exercise the real connection UI against a simulated ESP transport. This
    // does not claim validation of the browser's serial chooser or real silicon.
    await evaluate(`window.__qaOriginalFlasher=ESPFlasher;window.__qaChip='esp32c3';window.__qaCalls=[];
        ESPFlasher=class extends window.__qaOriginalFlasher {
            constructor(options){super(options);this.mock=new ESPIO.DemoTransport(ESPIO.chips[window.__qaChip]||ESPIO.chips.esp32c3);window.__qaDevice=this;}
            async openPort(){window.__qaCalls.push('open');this.port={};}
            async hardReset(boot){window.__qaCalls.push(boot?'reset-boot':'reset-app');return true;}
            async sync(){window.__qaCalls.push('sync');this.current_chip=window.__qaChip;}
            async isStubLoader(){window.__qaCalls.push('probe-stub');return false;}
            async downloadStub(){window.__qaCalls.push('download-stub');this.stubLoaded=true;return true;}
            async disconnect(){window.__qaCalls.push('disconnect');this.port=null;this.disconnected?.();}
            async executeCommand(packet,callback){
                const view=new DataView(packet.payload.buffer,packet.payload.byteOffset,packet.payload.byteLength);
                const opcode=packet.command,address=view.getUint32(8,true);let value=0;
                window.__qaCalls.push(opcode===9?'write':'read');
                if(opcode===9)await this.mock.write(address,view.getUint32(12,true),view.getUint32(16,true));
                else if(opcode===10)value=await this.mock.read(address);
                else throw new Error('Unexpected command '+opcode);
                return new Promise((resolve,reject)=>callback(resolve,reject,{value,data:new Uint8Array(this.stubLoaded?2:4)}));
            }
        };`);
    for (const chip of ['esp32c3', 'esp32c6', 'esp32p4']) {
        await evaluate(`window.__qaChip=${JSON.stringify(chip)};window.__qaCalls=[];document.getElementById('connect').click();`);
        await wait(`document.getElementById('session-badge').textContent.includes('LIVE') && !document.getElementById('pause').disabled`);
        const calls = await evaluate(`window.__qaCalls.slice()`);
        assert.deepEqual(calls.slice(0, 5), ['open', 'reset-boot', 'sync', 'probe-stub', 'download-stub']);
        assert.ok(calls.indexOf('write') > calls.indexOf('download-stub'));
        assert.equal(await evaluate(`document.getElementById('preview-chip').value`), chip);
        assert.equal(await evaluate(`document.getElementById('pin-state').textContent`), 'INPUT');
        await evaluate(`document.getElementById('register-filter').value='GPIO_IN_REG';document.getElementById('register-filter').dispatchEvent(new Event('input'));`);
        const inputAddress = { esp32c3: '0x6000403c', esp32c6: '0x6009103c', esp32p4: '0x500e003c' }[chip];
        await wait(`document.getElementById('register-list').textContent.includes(${JSON.stringify(inputAddress)})`);
        if (chip === 'esp32c3') {
            await evaluate(`window.__qaDevice.disconnected();`);
            await wait(`document.getElementById('session-badge').textContent==='OFFLINE' && document.getElementById('status').textContent.includes('verloren')`);
        } else {
            await evaluate(`document.getElementById('disconnect').click()`);
            await wait(`document.getElementById('session-badge').textContent==='OFFLINE' && !document.getElementById('preview-chip').disabled`);
            assert.deepEqual(await evaluate(`window.__qaCalls.slice(-2)`), ['reset-app', 'disconnect']);
        }
    }
    await evaluate(`window.__qaChip='esp8266';window.__qaCalls=[];document.getElementById('connect').click();`);
    await wait(`document.getElementById('status').textContent.includes('ROM-Registerzugriff') && !document.getElementById('pause').disabled`);
    assert.deepEqual(await evaluate(`window.__qaCalls.slice(0,3)`), ['open', 'reset-boot', 'sync']);
    assert.equal(await evaluate(`window.__qaCalls.includes('download-stub')`), false);
    assert.equal(await evaluate(`window.__qaCalls.includes('write')`), false);
    await evaluate(`document.getElementById('disconnect').click();`);
    await wait(`document.getElementById('session-badge').textContent==='OFFLINE'`);
    await evaluate(`ESPFlasher=window.__qaOriginalFlasher;`);
    await call('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await screenshot('mobile');
    const overflow = await evaluate(`({width:document.documentElement.clientWidth,scroll:document.documentElement.scrollWidth})`);
    assert.ok(overflow.scroll <= overflow.width + 1, `Page overflow: ${JSON.stringify(overflow)}`);
    assert.deepEqual(errors, []);
    console.log('Browser checks passed: P4/S3 native SD identification, both S3 board downloads byte-exact, pin leases/restoration, manual commands, mobile SD panel, GPIO, ADC C3/C6/P4/S3/H2, scans, export, catalog, simulated connection, mobile overflow.');
} finally { ws.close(); }
