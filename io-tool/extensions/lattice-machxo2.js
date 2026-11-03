// Lattice MachXO2 sysCONFIG over I²C or slave SPI: identify, status, feature readout, erase, SRAM load (I²C) and config-flash programming.
// Commands and IDs follow g3gg0/sat_snooper main/fpga.c/fpga.h and TN1204; the SPI flash sequence follows the Linux driver drivers/fpga/machxo2-spi.c.
(function () {
    const CMD = {
        READ_ID: 0xE0, ENABLE_TRANSPARENT: 0x74, ENABLE_OFFLINE: 0xC6, READ_BUSY: 0xF0, READ_STATUS: 0x3C, ERASE: 0x0E,
        READ_USERCODE: 0xC0, INIT_ADDRESS: 0x46, PROG_INCR_NV: 0x70, PROG_DONE: 0x5E, READ_TRACEID: 0x19, READ_FEATURE_ROW: 0xE7, READ_FEABITS: 0xFB, DISABLE: 0x26, BYPASS: 0xFF, REFRESH: 0x79, BURST: 0x7A
    };
    // ISC_ERASE operand bits 16..19 (TN1204); the sat_snooper header has flash/feature swapped.
    const ERASE = { sram: 0x01, feature: 0x02, flash: 0x04, ufm: 0x08 };
    const DEVICES = {
        0x012B0043: 'LCMXO2-256ZE', 0x012B1043: 'LCMXO2-640ZE', 0x012B2043: 'LCMXO2-1200ZE', 0x012B3043: 'LCMXO2-2000ZE / 2000HE',
        0x012B4043: 'LCMXO2-4000ZE / 4000HE / 2000UHE', 0x012B5043: 'LCMXO2-7000ZE / 7000HE', 0x012B8043: 'LCMXO2-256HC', 0x012B9043: 'LCMXO2-640HC',
        0x012BA043: 'LCMXO2-1200HC / 640UHC', 0x012BB043: 'LCMXO2-2000HC / 1200UHC', 0x012BC043: 'LCMXO2-4000HC / 2000UHC', 0x012BD043: 'LCMXO2-7000HC'
    };
    const STATUS_BITS = [
        [0, 1, 'JTAG transparent'], [1, 3, 'Config target'], [4, 1, 'JTAG active'], [5, 1, 'PWD protect'], [6, 1, 'OTP'], [7, 1, 'Decrypt enable'], [8, 1, 'DONE'], [9, 1, 'ISC enable'],
        [10, 1, 'Write enable'], [11, 1, 'Read enable'], [12, 1, 'Busy'], [13, 1, 'Fail'], [14, 1, 'FEA OTP'], [15, 1, 'Decrypt only'], [16, 1, 'PWD enable'], [17, 1, 'UFM OTP'],
        [18, 1, 'ASSP'], [19, 1, 'SDM en'], [20, 1, 'Encrypt preamble'], [21, 1, 'Std preamble'], [22, 1, 'SPIm fail 1'], [23, 3, 'BSE error code'], [26, 1, 'Execution error'],
        [27, 1, 'ID error'], [28, 1, 'Invalid command'], [29, 1, 'SED error'], [30, 1, 'Bypass'], [31, 1, 'Flow-through']
    ];
    const FEABITS = ['SECURE_PWD', 'DEC_ONLY', 'PWD_ENABLE', 'PWD_ENABLE_ALL', 'MY_ASSP_ENABLE', 'PRG_PERSIST_DIS', 'INIT_PERSIST_EN', 'DONE_PERSIST_EN', 'JTAG_PERSIST_DIS', 'SSP_PERSIST_DIS', 'I2C_PERSIST_DIS', 'MSPI_PERSIST_EN', 'BOOTSEL0', 'BOOTSEL1', 'RES2', 'RES1'];
    const hexBytes = bytes => [...bytes].map(b => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');
    // Lattice .bit files carry an ASCII header; the raw stream starts at the FF FF BD B3 preamble.
    function stripHeader(data) {
        for (let i = 0; i + 3 < Math.min(data.length, 4096); i++) if (data[i] === 0xFF && data[i + 1] === 0xFF && data[i + 2] === 0xBD && data[i + 3] === 0xB3) return { data: data.subarray(i), skipped: i };
        return { data, skipped: 0, noPreamble: true };
    }

    module.exports = {
        id: 'lattice-machxo2',
        name: 'Lattice MachXO2',
        version: '1.1',
        description: 'MachXO2 über I²C (Konfigurationsadresse 0x40) oder Slave-SPI: ID, Status, FEABITS, Feature Row, Erase, Config-Flash programmieren und (nur I²C, experimentell) SRAM-Bitstream laden.',
        interfaces: [{ id: 'bus', kinds: ['i2c', 'spi'], label: 'Physical Layer (I²C oder SPI)' }],
        gpios: [
            { id: 'programn', label: 'PROGRAMN', mode: 'output', level: 1, optional: true, hint: 'Wird nur während des Ladens LOW gezogen (wie fpga_prog() in sat_snooper).' },
            { id: 'done', label: 'DONE', mode: 'input', optional: true, hint: 'Optional: DONE-Pin zur Kontrolle nach dem Laden.' }
        ],
        async load(api) {
            const host = api.interfaces.bus.host, programn = api.gpios.programn, done = api.gpios.done;
            const spi = api.interfaces.bus.kind === 'spi';
            const fifo = host.info?.[5] ?? 16, chunkSize = Math.max(1, fifo - 2);
            const block = api.ui.block(`MachXO2 sysCONFIG (${spi ? 'SPI' : 'I²C'})`);
            const address = spi ? null : block.row().field('Config-Adresse 0x', { value: '40', width: '60px' });
            const addr = () => parseInt(address.value, 16);
            if (spi && (host.config?.mode || host.config?.lsb)) block.text('Hinweis: Der MachXO2-Slave-SPI-Port erwartet SPI-Mode 0, MSB first. Im SPI-Block anpassen.', '');
            // SPI sends opcode, operand and dummy bytes in one CS cycle and returns the bytes after the four command bytes.
            const cmd = spi
                ? async (opcode, operand = [0, 0, 0], read = 0) => {
                    const tx = new Uint8Array(4 + read);
                    tx.set([opcode, operand[0] ?? 0, operand[1] ?? 0, operand[2] ?? 0]);
                    return (await host.transfer(tx, api.signal)).subarray(4);
                }
                : (opcode, operand = [0, 0, 0], read = 0) => host.transfer(addr(), Uint8Array.of(opcode, ...operand), read, api.signal);
            const out = block.output('Noch keine Abfrage.');
            const be32 = b => ((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) >>> 0;

            async function readId() {
                if (!spi) {
                    try { await host.transfer(0x43, Uint8Array.of(0), 0, api.signal); } catch { /* the reset address is optional */ }
                    await cmd(CMD.ENABLE_TRANSPARENT, [0, 0]);
                }
                const id = await cmd(CMD.READ_ID, [0, 0, 0], 4), value = be32(id), name = DEVICES[value & 0x0FFFFFFF];
                return { id, value, name };
            }
            async function readStatus() {
                const b = await cmd(CMD.READ_STATUS, [0, 0, 0], 4);
                // SPI: MSB first as in the Linux driver; I²C keeps the byte order of the sat_snooper reference (little-endian).
                return { bytes: b, raw: spi ? be32(b) : (b[0] | b[1] << 8 | b[2] << 16 | b[3] << 24) >>> 0 };
            }
            const statusText = raw => STATUS_BITS.map(([bit, width, name]) => `${name.padEnd(18)} ${(raw >>> bit) & (2 ** width - 1)}`).join('\n');
            const busy = async () => (await cmd(CMD.READ_BUSY, [0, 0, 0], 1))[0];
            async function waitBusy(timeoutMs = 5000) {
                const end = performance.now() + timeoutMs;
                while (performance.now() < end) { if (!((await busy()) & 0x80)) return; await api.sleep(5); }
                throw new Error('Timeout: Busy-Flag bleibt gesetzt.');
            }
            const levelText = () => done ? `DONE-Pin: ${done.read() ?? '?'}` : '';

            const info = block.row();
            info.button('ID lesen', async () => {
                const { id, value, name } = await readId();
                out.set(`Device ID: ${hexBytes(id)}  (0x${value.toString(16).toUpperCase().padStart(8, '0')})\n${name ? `Erkannt: ${name}` : 'Unbekanntes Gerät (Revision im oberen Nibble wird ignoriert)'}`);
                block.setStatus(name || 'unbekannt');
            }, { primary: true });
            info.button('Status lesen', async () => {
                const { raw, bytes } = await readStatus();
                out.set(`Status ${hexBytes(bytes)} = 0x${raw.toString(16).toUpperCase().padStart(8, '0')}\n${statusText(raw)}\n${levelText()}`.trim());
                block.setStatus((raw >>> 8) & 1 ? 'DONE' : 'nicht konfiguriert', (raw >>> 13) & 1 ? 'error' : '');
            });
            info.button('FEABITS / Feature Row', async () => {
                await cmd(CMD.ENABLE_OFFLINE, [0x08, 0]);
                try {
                    const fea = await cmd(CMD.READ_FEABITS, [0, 0, 0], 2), row = await cmd(CMD.READ_FEATURE_ROW, [0, 0, 0], 8), value = fea[0] << 8 | fea[1];
                    out.set(`FEABITS 0x${value.toString(16).toUpperCase().padStart(4, '0')}\n${FEABITS.filter((_, i) => (value >> i) & 1).join(', ') || '(keine gesetzt)'}\nFeature Row: ${hexBytes(row)}`);
                } finally { await cmd(CMD.DISABLE, [0, 0]); }
            });
            info.button('USERCODE / TraceID', async () => {
                await cmd(CMD.ENABLE_OFFLINE, [0x08, 0]);
                try { out.set(`USERCODE: ${hexBytes(await cmd(CMD.READ_USERCODE, [0, 0, 0], 4))}\nTraceID:  ${hexBytes(await cmd(CMD.READ_TRACEID, [0, 0, 0], 8))}`); }
                finally { await cmd(CMD.DISABLE, [0, 0]); }
            });
            info.button('Refresh (neu konfigurieren)', async () => { await cmd(CMD.REFRESH, [0, 0]); out.set('REFRESH gesendet.'); });

            const erase = api.ui.block('Löschen');
            const row = erase.row();
            const targets = Object.fromEntries(Object.keys(ERASE).map(key => [key, row.field(key.toUpperCase(), { type: 'checkbox', value: key === 'sram' })]));
            row.button('Löschen', async () => {
                const mask = Object.entries(targets).reduce((m, [key, field]) => m | (field.value ? ERASE[key] : 0), 0);
                if (!mask) throw new Error('Mindestens einen Speicherbereich wählen.');
                if (mask & ~ERASE.sram && !window.confirm('Config-Flash, Feature Row oder UFM löschen? Das Gerät startet danach ggf. nicht mehr ohne neue Programmierung.')) return;
                await cmd(CMD.ENABLE_OFFLINE, [0x08, 0]);
                try { await cmd(CMD.ERASE, [mask, 0, 0]); await waitBusy(); erase.setStatus('Gelöscht'); }
                finally { await cmd(CMD.DISABLE, [0, 0]); }
            });
            erase.text('Löscht nur das Gewählte. SRAM entspricht dem flüchtigen Konfigurationsspeicher.');

            if (!spi) {
                const load = api.ui.block('Bitstream in SRAM laden');
                const file = load.field('Bitstream (.bit / .bin)', { type: 'file' });
                const bar = load.progress();
                load.text('Experimentell: Der I²C-RPC sendet jeden Datenblock als eigene Transaktion mit START/STOP, die Referenz sendet den Burst ohne STOP dazwischen. Ob dein MachXO2 das akzeptiert, ist ungeprüft – das Ergebnis wird über das DONE-Bit im Status kontrolliert.', '');
                load.button('Laden', async () => {
                    const picked = file.input.files[0];
                    if (!picked) throw new Error('Zuerst eine Bitstream-Datei wählen.');
                    const { data, skipped, noPreamble } = stripHeader(new Uint8Array(await picked.arrayBuffer()));
                    if (noPreamble) api.log('Kein Preamble FF FF BD B3 gefunden; Datei wird unverändert gesendet.');
                    api.log(`Bitstream ${data.length} Bytes${skipped ? `, ${skipped} Header-Bytes entfernt` : ''}`);
                    await programn?.write(0);
                    try {
                        await cmd(CMD.REFRESH, [0, 0]);
                        await cmd(CMD.ENABLE_OFFLINE, [0, 0]);
                        await cmd(CMD.ERASE, [ERASE.sram, 0, 0]);
                        await api.sleep(100);
                        let sent = 0, first = true;
                        while (sent < data.length) {
                            const part = data.subarray(sent, sent + chunkSize);
                            // The burst opcode precedes the first block only.
                            const payload = first ? Uint8Array.of(CMD.BURST, 0, 0, 0, ...part.subarray(0, Math.max(0, chunkSize - 4))) : part;
                            const used = first ? Math.min(part.length, Math.max(0, chunkSize - 4)) : part.length;
                            await host.transfer(addr(), payload, 0, api.signal);
                            sent += used; first = false; bar.set(sent, data.length);
                            await api.sleep(1);
                        }
                        await cmd(CMD.DISABLE, [0, 0]);
                        await host.transfer(addr(), Uint8Array.of(CMD.BYPASS, 0xFF, 0xFF, 0xFF), 0, api.signal).catch(() => {});
                    } finally { await programn?.write(1); }
                    await api.sleep(50);
                    const { raw } = await readStatus(), ok = ((raw >>> 8) & 1) && !((raw >>> 13) & 1);
                    load.setStatus(ok ? 'DONE gesetzt' : 'DONE nicht gesetzt', ok ? '' : 'error');
                    out.set(`Nach dem Laden:\n${statusText(raw)}\n${levelText()}`.trim());
                });
            }

            // Config-flash programming (TN1204 / Linux machxo2-spi.c): ENABLE, ERASE flash, INIT_ADDRESS, 16-byte pages with PROG_INCR_NV, PROGRAMDONE, REFRESH.
            const PAGE = 16, flashBlock = api.ui.block('Config-Flash programmieren');
            const flashFile = flashBlock.field('Bitstream (.bit / .bin)', { type: 'file' }), flashBar = flashBlock.progress();
            flashBlock.text(spi
                ? 'Schreibt den Konfigurationsflash seitenweise (20 Byte pro CS-Zyklus). Der Slave-SPI-Port muss aktiv sein (unkonfiguriertes Gerät oder SSPI-Persist). Danach wird per REFRESH neu geladen.'
                : `Schreibt den Konfigurationsflash seitenweise (20 Byte pro I²C-Transaktion, FIFO: ${fifo} Byte). Der I²C-Port muss aktiv sein. Danach wird per REFRESH neu geladen.`, '');
            flashBlock.button('Flash programmieren', async () => {
                const picked = flashFile.input.files[0];
                if (!picked) throw new Error('Zuerst eine Bitstream-Datei wählen.');
                if (!spi && fifo < PAGE + 4) throw new Error(`I²C-FIFO (${fifo} Byte) zu klein für 20-Byte-Seiten.`);
                if (!window.confirm('Konfigurationsflash löschen und neu programmieren? Bei einem fehlerhaften Bitstream startet das Gerät nicht mehr selbstständig.')) return;
                const { data: raw, skipped } = stripHeader(new Uint8Array(await picked.arrayBuffer()));
                const data = new Uint8Array(Math.ceil(raw.length / PAGE) * PAGE).fill(0xFF);
                data.set(raw);
                api.log(`Flash: ${raw.length} Bytes (${data.length / PAGE} Seiten)${skipped ? `, ${skipped} Header-Bytes entfernt` : ''}`);
                const state = async () => (await readStatus()).raw;
                const waitStatusIdle = async () => {
                    for (let i = 0; i < 128; i++) { if (!((await state() >>> 12) & 1)) return; await api.sleep(5); }
                    throw new Error('Timeout: Busy-Bit bleibt gesetzt.');
                };
                await cmd(CMD.ENABLE_OFFLINE, [0x08, 0]);
                await api.sleep(1);
                await cmd(CMD.ERASE, [ERASE.flash, 0, 0]);
                await waitStatusIdle();
                if ((await state() >>> 13) & 1) throw new Error('Erase fehlgeschlagen (FAIL-Bit).');
                await cmd(CMD.INIT_ADDRESS, [0, 0, 0]);
                const page = new Uint8Array(4 + PAGE);
                page.set([CMD.PROG_INCR_NV, 0, 0, 1]);
                for (let offset = 0; offset < data.length; offset += PAGE) {
                    page.set(data.subarray(offset, offset + PAGE), 4);
                    if (spi) await host.transfer(page, api.signal); else await host.transfer(addr(), page, 0, api.signal);
                    flashBar.set(offset + PAGE, data.length);
                }
                await cmd(CMD.PROG_DONE, [0, 0, 0]);
                await waitStatusIdle();
                let status = await state();
                if (!((status >>> 8) & 1)) { flashBlock.setStatus('DONE nicht gesetzt', 'error'); out.set(`Nach PROGRAMDONE:\n${statusText(status)}`); return; }
                for (let attempt = 0; attempt < 16; attempt++) {
                    await cmd(CMD.REFRESH, [0, 0, 0]);
                    await api.sleep(5);
                    status = await state();
                    if (!((status >>> 12) & 1) && ((status >>> 8) & 1) && !((status >>> 23) & 7)) break;
                }
                const ok = ((status >>> 8) & 1) && !((status >>> 13) & 1) && !((status >>> 23) & 7);
                flashBlock.setStatus(ok ? 'Programmiert' : 'Fehler beim Refresh', ok ? '' : 'error');
                out.set(`Nach dem Programmieren:\n${statusText(status)}\n${levelText()}`.trim());
            });
        }
    };
})();
