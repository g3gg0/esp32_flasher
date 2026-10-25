// Start the repository HTTP server on 8088 and a separate QA Edge instance on CDP 9235.
import assert from 'node:assert/strict';
const pages = await (await fetch('http://127.0.0.1:9235/json/list')).json();
const page = pages.find(item => item.type === 'page' && item.url.includes('/io-tool/'));
assert.ok(page, 'Open io-tool in the QA browser first');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise(resolve => ws.addEventListener('open', resolve, { once: true }));
let id = 0;
const pending = new Map(), exceptions = [];
ws.addEventListener('message', ({ data }) => {
    const message = JSON.parse(data);
    if (message.id) {
        const request = pending.get(message.id);
        if (request) { pending.delete(message.id); clearTimeout(request.timer); message.error ? request.reject(message.error) : request.resolve(message.result); }
    } else if (message.method === 'Runtime.exceptionThrown') exceptions.push(message.params.exceptionDetails);
});
function call(method, params = {}) {
    return new Promise((resolve, reject) => {
        const requestId = ++id, timer = setTimeout(() => reject(new Error(`CDP timeout: ${method}`)), 15000);
        pending.set(requestId, { resolve, reject, timer });
        ws.send(JSON.stringify({ id: requestId, method, params }));
    });
}
async function evaluate(expression) {
    const result = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
}
async function wait(expression) {
    return evaluate(`new Promise((resolve,reject)=>{const start=performance.now();const check=()=>{if(${expression})resolve(true);else if(performance.now()-start>8000)reject(new Error('Timed out'));else setTimeout(check,25);};check();})`);
}
const settle = () => evaluate('new Promise(resolve=>setTimeout(resolve,40))');
try {
    await call('Runtime.enable'); await call('Page.enable');
    await evaluate("localStorage.removeItem('esp-io-language')");
    const version = await call('Browser.getVersion');
    await call('Emulation.setUserAgentOverride', { userAgent: version.userAgent, acceptLanguage: 'de-DE,de;q=0.9,en;q=0.8' });
    await call('Page.navigate', { url: 'http://127.0.0.1:8088/io-tool/' });
    await wait("globalThis.ESPIO?.i18n && document.querySelectorAll('[data-board]').length > 0");
    await settle();
    assert.equal(await evaluate('document.documentElement.lang'), 'de');
    assert.equal(await evaluate("document.getElementById('connect').textContent"), 'Verbinden');
    assert.equal(await evaluate("document.getElementById('board-description').textContent.startsWith('SuperMini-Standardlayout')"), true);

    const inventory = await evaluate('ESPIO.boardConfigs.boards.map(({id,chip,notes})=>({id,chip,notes}))');
    for (const board of inventory) {
        await evaluate(`(()=>{const s=document.getElementById('preview-chip');s.value=${JSON.stringify(board.chip)};s.dispatchEvent(new Event('change'));})()`);
        await wait(`document.querySelector('[data-board="${board.id}"]')`);
        await evaluate(`document.querySelector('[data-board="${board.id}"]').click()`);
        await wait(`document.querySelector('[data-board="${board.id}"]').getAttribute('aria-pressed')==='true'`);
        const note = Object.entries(board.notes).find(([gpio]) => Number(gpio) !== 26);
        if (note) {
            const [gpio, text] = note;
            const found = await evaluate(`(()=>{const p=document.querySelector('#board-svg [data-pin="${gpio}"]');if(!p)return false;p.dispatchEvent(new MouseEvent('click',{bubbles:true}));return true;})()`);
            assert.equal(found, true, `${board.id}: note has no selectable marker`);
            await settle();
            assert.equal(await evaluate(`document.getElementById('pin-note').textContent.includes(ESPIO.i18n.t(${JSON.stringify(text)}))`), true, board.id);
        }
        assert.equal(await evaluate(`document.getElementById('board-source').getAttribute('href')===ESPIO.boardConfigs.boards.find(b=>b.id==='${board.id}').source`), true);
    }
    console.log(`Verified ${inventory.length} boards, source links and localized pin notes`);

    // Locale changes preserve the existing demo session and editable form state.
    await evaluate("(()=>{const s=document.getElementById('preview-chip');s.value='esp32c3';s.dispatchEvent(new Event('change'));})()");
    await wait("document.querySelector('[data-board=\"c3-supermini\"]')");
    await evaluate("document.querySelector('[data-board=\"c3-supermini\"]').click()");
    await wait("!document.getElementById('demo').disabled");
    await evaluate("document.getElementById('demo').click()");
    await wait("document.getElementById('session-badge').textContent.includes('SIMULATION')");
    await evaluate("document.querySelector('#board-svg [data-pin=\"0\"]').dispatchEvent(new MouseEvent('click',{bubbles:true}));document.getElementById('i2c-address').value='0x3C';ESPIO.i18n.setLocale('en',false)");
    await settle();
    assert.equal(await evaluate('document.documentElement.lang'), 'en');
    assert.equal(await evaluate("document.getElementById('connect').textContent"), 'Disconnect');
    assert.equal(await evaluate("document.getElementById('i2c-address').value"), '0x3C');
    assert.equal(await evaluate("document.getElementById('pin-name').textContent"), 'GPIO 0');
    assert.equal(await evaluate("document.getElementById('session-badge').textContent.includes('SIMULATION')"), true);
    assert.equal(await evaluate("document.body.innerText.includes('geplant') || document.body.innerText.includes('jetzt')"), false);
    assert.equal(await evaluate("document.getElementById('flash-write').textContent"), 'Write file');
    assert.equal(await evaluate("document.getElementById('fuses-read').textContent"), 'Read fuses / chip information');
    assert.equal(await evaluate("document.getElementById('rmt-sequence').placeholder.includes('custom symbols')"), true);
    await evaluate("document.getElementById('rmt-sequence').value='BOOT button'");
    await evaluate("ESPIO.i18n.setLocale('de',false)"); await settle();
    assert.equal(await evaluate("document.getElementById('connect').textContent"), 'Trennen');
    assert.equal(await evaluate("document.getElementById('i2c-address').value"), '0x3C');
    assert.equal(await evaluate("document.getElementById('rmt-sequence').value"), 'BOOT button');
    assert.equal(await evaluate("document.getElementById('rmt-sequence').placeholder.includes('Eigene Symbole')"), true);
    // Data cells are never passed through the automatic translator.
    assert.equal(await evaluate("(()=>{const e=document.createElement('div');e.setAttribute('translate','no');e.id='i18n-raw-test';e.textContent='BOOT button';document.body.append(e);return true;})()"), true);
    await settle();
    assert.equal(await evaluate("document.getElementById('i18n-raw-test').textContent"), 'BOOT button');
    await evaluate("document.getElementById('i18n-raw-test').remove();document.getElementById('disconnect').click()");
    await wait("document.getElementById('session-badge').textContent==='OFFLINE'");
    assert.deepEqual(exceptions, []);
    console.log('Automatic German locale, English/German switching, demo continuity and raw-data exclusions passed');
} finally { ws.close(); }
