// Lattice MachXO2 sysCONFIG over I²C: identify, status, feature readout, erase and SRAM bitstream load.
// Command set and device IDs follow g3gg0/sat_snooper main/fpga.c and fpga.h.
(function () {
    const CMD = {
        READ_ID: 0xE0, ENABLE_TRANSPARENT: 0x74, ENABLE_OFFLINE: 0xC6, READ_BUSY: 0xF0, READ_STATUS: 0x3C, ERASE: 0x0E,
        READ_USERCODE: 0xC0, READ_TRACEID: 0x19, READ_FEATURE_ROW: 0xE7, READ_FEABITS: 0xFB, DISABLE: 0x26, BYPASS: 0xFF, REFRESH: 0x79, BURST: 0x7A
    };
    const ERASE = { sram: 0x01, flash: 0x02, feature: 0x04, ufm: 0x08 };
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
        version: '1.0',
        description: 'MachXO2 über den I²C-Konfigurationsport (0x40): ID, Status, FEABITS, Feature Row, Erase und SRAM-Bitstream laden.',
        interfaces: [{ id: 'bus', kinds: ['i2c'], label: 'I²C-Bus' }],
        gpios: [
            { id: 'programn', label: 'PROGRAMN', mode: 'output', level: 1, optional: true, hint: 'Wird nur während des Ladens LOW gezogen (wie fpga_prog() in sat_snooper).' },
            { id: 'done', label: 'DONE', mode: 'input', optional: true, hint: 'Optional: DONE-Pin zur Kontrolle nach dem Laden.' }
        ],
        async load(api) {
            const host = api.interfaces.bus.host, programn = api.gpios.programn, done = api.gpios.done;
            const chunkSize = Math.max(1, (host.info?.[5] ?? 16) - 2);
            const block = api.ui.block('MachXO2 sysCONFIG');
            const addressRow = block.row();
            const address = addressRow.field('Config-Adresse 0x', { value: '40', width: '60px' });
            const addr = () => parseInt(address.value, 16);
            const cmd = (opcode, operand = [0, 0, 0], read = 0) => host.transfer(addr(), Uint8Array.of(opcode, ...operand), read, api.signal);
            const out = block.output('Noch keine Abfrage.');
            const be32 = b => ((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) >>> 0;

            async function readId() {
                try { await host.transfer(0x43, Uint8Array.of(0), 0, api.signal); } catch { /* the reset address is optional */ }
                await cmd(CMD.ENABLE_TRANSPARENT, [0, 0]);
                const id = await cmd(CMD.READ_ID, [0, 0, 0], 4), value = be32(id), name = DEVICES[value & 0x0FFFFFFF];
                return { id, value, name };
            }
            async function readStatus() {
                const b = await cmd(CMD.READ_STATUS, [0, 0, 0], 4);
                // Byte order as used by the reference implementation (little-endian).
                return { bytes: b, raw: (b[0] | b[1] << 8 | b[2] << 16 | b[3] << 24) >>> 0 };
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
    };
})();
