const test = require('node:test');
const assert = require('node:assert/strict');
const ESPFlasher = require('../../flasher.js');
const { startAccelerated } = require('../accelerated.js');
function device() { return new ESPFlasher({ logMessage() {}, logWarning() {}, logError() {} }); }
test('ROM sync clears stale legacy-stub state on chips using register probes too', async () => {
    const f = device(); f.current_chip = 'esp32c3'; f.stubLoaded = true;
    f.getSecurityInfo = async () => ({ chip_id_hex: 5, flags_decoded: {} });
    f.executeCommand = async (packet, callback) => new Promise((resolve, reject) => callback(resolve, reject, { value: 0x55201207 }));
    await f.sync(); assert.equal(f.current_chip, 'esp32c3'); assert.equal(f.stubLoaded, false);
    f.executeCommand = async (packet, callback) => new Promise((resolve, reject) => callback(resolve, reject, { value: 0 }));
    await f.sync(); assert.equal(f.stubLoaded, true, 'failed reset must still be detected as legacy mode');
});
test('reset invalidates stale mode for every chip and mode probes store booleans', async () => {
    const f = device(); f.current_chip = 'esp32c3'; f.stubLoaded = true; f.port = {};
    f.setSignals = async () => {};
    assert.equal(await f.hardReset(true), true); assert.equal(f.stubLoaded, false);
    f.executeCommand = async () => true;
    assert.equal(await f.isStubLoader(), true); assert.equal(f.stubLoaded, true); assert.equal(typeof f.stubLoaded, 'boolean');
});
test('accelerated handoff reports reset, actual-chip and actual-mode failures before writing RAM', async () => {
    const f = device(), manifest = { chip: 'esp32c3' }; let commands = 0;
    f.executeCommand = async () => { commands++; };
    f.hardReset = async () => false; await assert.rejects(startAccelerated(f, manifest), /Could not reset/);
    f.hardReset = async () => true; f.sync = async () => { f.current_chip = 'esp32p4'; };
    await assert.rejects(startAccelerated(f, manifest), /detected esp32p4, expected esp32c3/);
    f.sync = async () => { f.current_chip = 'esp32c3'; f.stubLoaded = true; };
    await assert.rejects(startAccelerated(f, manifest), /SYNC still reports a legacy stub/);
    assert.equal(commands, 0);
});
