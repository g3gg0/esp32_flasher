const test = require('node:test');
const assert = require('node:assert/strict');
const { boards, raw } = require('../configs/boards.js');
const chips = require('../configs/chips.js');

test('every active board has a complete source URL and valid GPIO notes', () => {
    assert.equal(boards.length, 19);
    assert.equal(new Set(boards.map(board => board.id)).size, boards.length);
    for (const board of boards) {
        assert.equal(new URL(board.source).protocol, 'https:', board.id);
        const pins = new Set(chips[board.chip].pins.map(pin => pin.id));
        for (const [gpio, text] of Object.entries(board.notes)) {
            assert.ok(pins.has(Number(gpio)), `${board.id}: invalid GPIO${gpio}`);
            assert.ok(!/\.$/.test(text), `${board.id}: trailing full stop`);
        }
    }
});

test('imported variants keep their own notes and explicit sources', () => {
    const c6 = boards.find(board => board.id === 'c6-supermini');
    const h2 = boards.find(board => board.id === 'h2-supermini');
    for (const board of [c6, h2]) {
        assert.ok(!Object.values(board.notes).some(note => /Ethernet|I2S|LDO4/.test(note)), board.id);
        assert.equal(board.notes[9], 'BOOT button');
    }
    const touch = boards.find(board => board.id === 'esp32-c6-touch-lcd-1-47');
    assert.equal(touch.source, 'https://docs.waveshare.com/ESP32-C6-Touch-LCD-1.47');
    assert.match(touch.notes[9], /BOOT/);
    assert.equal(touch.notes[8], undefined);
    const heltec = boards.find(board => board.id === 'heltec-wifi-kit-32-v3');
    assert.deepEqual(heltec.extra, [17, 18]);
    assert.match(heltec.notes[17], /OLED.*SDA/);
    assert.match(heltec.notes[18], /OLED.*SCL/);
    assert.equal(boards.at(-1).id, 'toniebox-esp32');
    assert.deepEqual(raw(chips.esp32p4).notes, {});
});
