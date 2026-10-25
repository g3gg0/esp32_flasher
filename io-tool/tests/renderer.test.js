'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');
function section(start, end) { return source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start))); }

test('scan callback formats driver, pull and observation progress as complete sentences', () => {
    const dictionary = require('../locales/de.js');
    globalThis.ESPIO = { locales: { de: dictionary } };
    const i18n = require('../i18n.js');
    const callback = section('                onPhase: (id, phase,', '                onResult:');
    for (const locale of ['en', 'de']) {
        i18n.setLocale(locale, false);
        const nodes = { 'scan-state': {}, 'scan-progress': {} };
        const context = vm.createContext({ t: i18n.t, $: id => nodes[id] });
        vm.runInContext(`let lastStage = ''; const callbacks = { ${callback} };`, context);
        for (const phase of ['drive D2 low', 'drive D2 high', 'drive D2 return-low', 'pull low', 'idle idle', 'observe observe']) {
            context.phase = phase;
            vm.runInContext('callbacks.onPhase(19, phase, {attempt: 4, maxAttempts: 4})', context);
            const stages = {
                'drive': ['Drive strength D2', 'Treiberstufe D2'],
                'pull': ['Internal pulls', 'Interne Pull-Widerstände'],
                'idle': ['High-Z', 'High-Z'],
                'observe': ['Observe only', 'Nur beobachten']
            };
            const stage = stages[phase.split(' ')[0]][locale === 'en' ? 0 : 1];
            const expected = locale === 'en'
                ? `Measuring GPIO19: ${stage} (attempt 4 of 4)...`
                : `GPIO19: ${stage} messen (Versuch 4 von 4)...`;
            assert.equal(nodes['scan-progress'].textContent, expected);
            assert.equal(i18n.t(expected), expected, 'DOM localization preserves the complete progress message');
        }
    }
});

test('GPIO actions do not post success banners, but still expose errors and release the UI', async () => {
    for (const fail of [false, true]) {
        let writes = 0, configurations = 0, updates = 0;
        const errors = [], expected = new Error('write failed');
        const timers = new Set();
        const context = vm.createContext({
            operation: false, busy: false, gpioFeedbackPending: false, selectedPin: 17,
            setTimeout(callback) { timers.add(callback); return callback; },
            clearTimeout(callback) { timers.delete(callback); },
            controller: {
                running: true, pins: new Map([[17, { level: 1 }]]),
                async configure() { configurations++; if (fail) throw expected; },
                async setLevel() { writes++; if (fail) throw expected; }
            },
            updateControls() { updates++; },
            async failure(error) { errors.push(error); },
            status() { assert.fail('GPIO actions must not post success banners'); }
        });
        vm.runInContext(section('    function controlsLocked()', '    function updateLDO4Controls()'), context);
        await vm.runInContext('changePin("output", "none")', context);
        await vm.runInContext('changeLevel(17, 1)', context);
        assert.equal(configurations, 1); assert.equal(writes, 1);
        assert.equal(updates, 2); assert.equal(context.operation, false);
        assert.equal(context.gpioFeedbackPending, false);
        assert.equal(timers.size, 0, 'fast operations cancel delayed disabled feedback');
        assert.deepEqual(errors, fail ? [expected, expected] : []);
    }
});

test('GPIO lock is immediate but disabled feedback waits 150 ms, including frame updates', async () => {
    for (const fail of [false, true]) {
        let finish, reject, timer, delay, writes = 0;
        const updates = [], errors = [];
        const pending = new Promise((resolve, rejectPromise) => { finish = resolve; reject = rejectPromise; });
        const context = vm.createContext({
            operation: false, busy: false, gpioFeedbackPending: false, selectedPin: 17,
            controller: { running: true, setLevel() { writes++; return pending; } },
            setTimeout(callback, ms) { timer = callback; delay = ms; return callback; },
            clearTimeout() { timer = null; },
            updateControls() { updates.push(context.operation); },
            async failure(error) { errors.push(error); },
        });
        vm.runInContext(section('    function controlsLocked()', '    function updateLDO4Controls()'), context);
        const action = vm.runInContext('changeLevel(17, 1)', context);
        assert.equal(context.operation, true, 'concurrent command handlers stay locked');
        assert.equal(vm.runInContext('controlsLocked()', context), false, 'RAF must not disable during grace period');
        assert.equal(delay, 150);
        assert.deepEqual(updates, []);
        await vm.runInContext('changeLevel(17, 0)', context);
        assert.equal(writes, 1, 'second click must not enqueue another GPIO write');
        timer();
        assert.equal(vm.runInContext('controlsLocked()', context), true);
        assert.deepEqual(updates, [true]);
        const error = new Error('serial failure');
        if (fail) reject(error); else finish();
        await action;
        assert.deepEqual(updates, [true, false]);
        assert.equal(context.operation, false);
        assert.equal(context.gpioFeedbackPending, false);
        assert.equal(timer, null);
        assert.deepEqual(errors, fail ? [error] : []);
    }
});

test('busy/operation changes reuse board cards rather than replacing images', () => {
    const buttons = [{ disabled: false }, { disabled: false }];
    const nodes = {
        'preview-chip': {}, 'chip-badge': {},
        'board-cards': {
            children: buttons,
            replaceChildren() { assert.fail('unchanged board cards must retain DOM identity'); }
        }
    };
    const context = vm.createContext({
        chip: { id: 'esp32s3', name: 'ESP32-S3' }, board: { id: 'toniebox-esp32' },
        session: 'hardware', busy: false, operation: true,
        ESPIO: { i18n: { locale: 'en' } }, $: id => nodes[id]
    });
    vm.runInContext(section("    let devicesKey = '';", '    function renderMap()'), context);
    vm.runInContext("devicesKey = 'esp32s3:toniebox-esp32:en'; renderDevices()", context);
    assert.ok(buttons.every(button => button.disabled));
    vm.runInContext('operation = false; renderDevices()', context);
    assert.ok(buttons.every(button => !button.disabled));
    assert.equal(nodes['preview-chip'].disabled, true);
});
