module.exports = async function registerTests({ runTest, assert, SparseImage, log }) {
    await runTest('Partial cache overlap with erase write - expect single 0xFF buffer', async () => {
        const sectorSize = 0x100;
        const totalSize = 0x10000; // 64KB
        
        // Create sparse image with cached data at 0x80-0xFF only
        const sparse = new SparseImage(totalSize, null, null, null, sectorSize);
        const cachedData = new Uint8Array(0x80);
        for (let i = 0; i < 0x80; i++) {
            cachedData[i] = ((0x80 + i) & 0xFF) ^ 0xAA;
        }
        sparse.readBuffer.push({
            address: 0x80,
            data: cachedData
        });
        
        // Verify initial cache state
        const byte80 = sparse._get(0x80);
        const byte100 = sparse._get(0xFF);
        log(`  Cached data: byte[0x80]=${byte80.toString(16)}, byte[0xFF]=${byte100.toString(16)}`);
        assert(byte80 === ((0x80 & 0xFF) ^ 0xAA), 'Cached byte at 0x80 matches pattern');
        assert(byte100 === ((0xFF & 0xFF) ^ 0xAA), 'Cached byte at 0xFF matches pattern');
        
        // Write 0xFF from 0x00-0xFF (covers both uncached 0x00-0x7F and cached 0x80-0xFF)
        const eraseFill = new Uint8Array(0x100);
        eraseFill.fill(0xFF);
        sparse.write(0x00, eraseFill);
        
        const bufCount = sparse.writeBuffer.length;
        log(`  After writing 0xFF (0x00-0xFF): ${bufCount} write buffer(s)`);
        for (let i = 0; i < sparse.writeBuffer.length; i++) {
            const seg = sparse.writeBuffer[i];
            log(`    [${i}] 0x${seg.address.toString(16)}-0x${(seg.address + seg.data.length).toString(16)} (${seg.data.length} bytes)`);
        }
        
        // Expect single write buffer with the full 0xFF write
        // The cached region has different data, so it won't be pruned
        assert(bufCount === 1, `After erase write, expect 1 write buffer, got ${bufCount}`);
        
        const buf = sparse.writeBuffer[0];
        assert(buf.address === 0x00, `Write buffer starts at 0x00, got 0x${buf.address.toString(16)}`);
        assert(buf.data.length === 0x100, `Write buffer is 0x100 bytes, got ${buf.data.length}`);
        
        // Verify all bytes in the buffer are 0xFF
        let allFF = true;
        for (let i = 0; i < buf.data.length; i++) {
            if (buf.data[i] !== 0xFF) allFF = false;
        }
        assert(allFF, 'Write buffer contains all 0xFF');
        
        // Verify the actual data (both from write and cache)
        for (let i = 0; i < 0x80; i++) {
            const val = sparse._get(i);
            assert(val === 0xFF, `Byte at 0x${i.toString(16)} is 0xFF from write buffer`);
        }
        for (let i = 0x80; i < 0x100; i++) {
            const val = sparse._get(i);
            assert(val === 0xFF, `Byte at 0x${i.toString(16)} is 0xFF (overriding cached pattern)`);
        }
        
        log(`  📊 Partial cache overlap test passed: single 0xFF buffer covering cached and uncached regions`);
    });
};
