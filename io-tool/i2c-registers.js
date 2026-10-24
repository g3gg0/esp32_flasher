(function (root) {
    'use strict';
    const isI2CScanError = error => !!error.response && [4, 5].includes(error.response.status ?? error.status);
    function registerScanOptions({ bits = 8, endian = 'BE', start = '0', end = '255', readLength = 1 } = {}) {
        const number = value => {
            const text = String(value).trim();
            if (!/^(?:0x[\da-f]+|\d+)$/i.test(text)) throw new Error('Registeradresse als Dezimalzahl oder 0x-Hexzahl eingeben.');
            return BigInt(text);
        };
        if (!Number.isInteger(bits) || bits < 1 || bits > 64 || !['BE', 'LE'].includes(endian) || !Number.isInteger(readLength) || readLength < 1 || readLength > 32) throw new Error('Adressbits 1–64, BE/LE und 1–32 Lesebytes wählen.');
        const first = number(start), last = number(end), max = (1n << BigInt(bits)) - 1n;
        if (last < first || last > max || last - first >= 4096n) throw new Error('Registerbereich muss zur Bitbreite passen und höchstens 4096 Register enthalten.');
        return { bits, endian, first, last, readLength, bytes: Math.ceil(bits / 8) };
    }
    function encodeI2CRegister(value, bits, endian) {
        if (typeof value !== 'bigint') value = BigInt(value);
        if (!Number.isInteger(bits) || bits < 1 || bits > 64 || !['BE', 'LE'].includes(endian) || value < 0n || value >= (1n << BigInt(bits))) throw new Error('Ungültige Registeradresse.');
        const bytes = new Uint8Array(Math.ceil(bits / 8));
        for (let i = 0; i < bytes.length; ++i) bytes[endian === 'LE' ? i : bytes.length - i - 1] = Number(value >> BigInt(i * 8) & 255n);
        return bytes;
    }
    async function scanI2CRegisters(host, address, options, { signal, onRow = () => {} } = {}) {
        const o = registerScanOptions(options);
        if (host.info && o.readLength > host.info[5]) throw new Error(`RX-FIFO: maximal ${host.info[5]} Lesebytes.`);
        let count = 0;
        for (let register = o.first; register <= o.last; ++register) {
            if (signal?.aborted) throw new DOMException('Register-Scan abgebrochen.', 'AbortError');
            const row = { register, write: encodeI2CRegister(register, o.bits, o.endian), read: new Uint8Array(), error: '' };
            try { row.read = await host.transfer(address, row.write, o.readLength, signal); }
            catch (error) { row.error = error.message; if (!isI2CScanError(error)) { onRow(row); throw error; } }
            onRow(row); count++;
        }
        return count;
    }
    const api = { registerScanOptions, encodeI2CRegister, scanI2CRegisters, isI2CScanError };
    if (typeof module === 'object' && module.exports) module.exports = api; else Object.assign(root.ESPIO ||= {}, api);
})(globalThis);
