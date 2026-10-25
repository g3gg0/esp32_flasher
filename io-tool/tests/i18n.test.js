const test = require('node:test');
const assert = require('node:assert/strict');
const dictionary = require('../locales/de.js');
globalThis.ESPIO = { locales: { de: dictionary } };
const i18n = require('../i18n.js');

test('English terms and legacy German UI messages work in both locales', () => {
    i18n.setLocale('de-DE', false);
    assert.equal(i18n.t('BOOT button'), 'BOOT-Taster');
    assert.equal(i18n.t('GPIO3 is used by SPI; release the port first.'), 'GPIO3 wird von SPI verwendet; zuerst den Port freigeben.');
    i18n.setLocale('en-GB', false);
    assert.equal(i18n.t('BOOT-Taster'), 'BOOT button');
    assert.equal(i18n.t('GPIO3 wird von SPI verwendet; zuerst den Port freigeben.'), 'GPIO3 is used by SPI; release the port first.');
});

test('joined tooltips, newlines and source data survive round trips', () => {
    const text = 'GPIO9 · BOOT button; boot strapping pin';
    i18n.setLocale('de', false);
    const translated = i18n.t(text);
    assert.match(translated, /BOOT-Taster/);
    assert.equal(i18n.t('0x7F A5 FF\nGPIO0\nhttps://example.org/de/'), '0x7F A5 FF\nGPIO0\nhttps://example.org/de/');
    i18n.setLocale('en', false);
    assert.equal(i18n.t(translated), text);
    assert.equal(i18n.t('<untrusted payload>'), '<untrusted payload>');
    i18n.setLocale('fr-FR', false);
    assert.equal(i18n.locale, 'en');
});

test('scan progress translates the whole sentence without consuming the attempt denominator', () => {
    for (const [stage, german] of [
        ['Drive strength D2', 'Treiberstufe D2'],
        ['Internal pulls', 'Interne Pull-Widerstände'],
        ['High-Z', 'High-Z'],
        ['Observe only', 'Nur beobachten']
    ]) {
        const english = `Measuring GPIO19: ${stage} (attempt 4 of 4)...`;
        const translated = `GPIO19: ${german} messen (Versuch 4 von 4)...`;
        i18n.setLocale('en', false);
        assert.equal(i18n.t(english), english);
        i18n.setLocale('de', false);
        assert.equal(i18n.t(english), translated);
        assert.equal(i18n.t(translated), translated, 'DOM observer must not reinterpret translated output');
        i18n.setLocale('en', false);
        assert.equal(i18n.t(translated), english);
        assert.equal(i18n.t(i18n.t(translated)), english);
    }
});

test('all board descriptions and human pin notes have German translations', () => {
    i18n.setLocale('de', false);
    for (const board of require('../configs/boards.js').boards) {
        assert.notEqual(i18n.t(board.description), board.description, board.id);
        assert.notEqual(i18n.t(board.subtitle), board.subtitle, board.id);
        for (const note of Object.values(board.notes)) {
            if (/button|battery|voltage|enable|capability|backlight|pad|input only|strapping|onboard|power|shared|divider|measurement|supply/i.test(note)) {
                assert.notEqual(i18n.t(note), note, `${board.id}: ${note}`);
                assert.ok(!/\.$/.test(i18n.t(note)), `${board.id}: translated note ends with a full stop`);
            }
        }
    }
});
