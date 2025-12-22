module.exports = async function registerTests({ runTest, assert, SparseImage, log }) {
    await runTest('Complex operations with no cached data - expect single write buffer', async () => {
        const sectorSize = 0x100;
        const totalSize = 0x10000; // 64KB
        
        // Create EMPTY sparse image with NO cached data
        const sparse = new SparseImage(totalSize, null, null, null, sectorSize);
        
        // Step 1: Clear middle 0x100 bytes (0x100-0x1FF) to 0xFF
        const middleFill = new Uint8Array(0x100);
        middleFill.fill(0xFF);
        sparse.write(0x100, middleFill);
        
        let bufCount = sparse.writeBuffer.length;
        log(`  After clearing middle: ${bufCount} write buffer(s)`);
        for (let i = 0; i < sparse.writeBuffer.length; i++) {
            const seg = sparse.writeBuffer[i];
            log(`    [${i}] 0x${seg.address.toString(16)}-0x${(seg.address + seg.data.length).toString(16)}`);
        }
        assert(bufCount >= 1, `After clearing middle, write buffer has segments (${bufCount})`);
        
        // Step 2: Clear everything to 0xFF (0x000-0x2FF)
        const allFill = new Uint8Array(0x300);
        allFill.fill(0xFF);
        sparse.write(0x000, allFill);
        
        bufCount = sparse.writeBuffer.length;
        log(`  After clearing everything: ${bufCount} write buffer(s)`);
        for (let i = 0; i < sparse.writeBuffer.length; i++) {
            const seg = sparse.writeBuffer[i];
            log(`    [${i}] 0x${seg.address.toString(16)}-0x${(seg.address + seg.data.length).toString(16)}`);
        }
        assert(bufCount === 1, `After clearing everything, expect 1 write buffer, got ${bufCount}`);
        
        // Step 3: Restore middle 0x100 bytes (0x100-0x1FF) to original pattern
        const middleRestore = new Uint8Array(0x100);
        for (let i = 0; i < 0x100; i++) {
            middleRestore[i] = (i & 0xFF) ^ 0xAA;
        }
        sparse.write(0x100, middleRestore);
        
        bufCount = sparse.writeBuffer.length;
        log(`  After restoring middle: ${bufCount} write buffer(s)`);
        for (let i = 0; i < sparse.writeBuffer.length; i++) {
            const seg = sparse.writeBuffer[i];
            log(`    [${i}] 0x${seg.address.toString(16)}-0x${(seg.address + seg.data.length).toString(16)} (${seg.data.length} bytes)`);
        }
        
        // Without cached data, no pruning happens - we should still have all segments merged
        // The middle restore just updates the 0xFF to pattern data in the same buffer
        assert(bufCount === 1, `After restoring middle, expect 1 write buffer, got ${bufCount}`);
        
        // Step 4: Write 0x00 everywhere (0x000-0x2FF)
        const zeroFill = new Uint8Array(0x300);
        zeroFill.fill(0x00);
        sparse.write(0x000, zeroFill);
        
        bufCount = sparse.writeBuffer.length;
        log(`  After writing 0x00 everywhere: ${bufCount} write buffer(s)`);
        for (let i = 0; i < sparse.writeBuffer.length; i++) {
            const seg = sparse.writeBuffer[i];
            log(`    [${i}] 0x${seg.address.toString(16)}-0x${(seg.address + seg.data.length).toString(16)} (${seg.data.length} bytes)`);
        }
        assert(bufCount === 1, `After writing 0x00, expect 1 write buffer, got ${bufCount}`);
        
        // Step 5: Restore original pattern (0x000-0x2FF) - still no cached data, so won't prune
        const fullRestore = new Uint8Array(0x300);
        for (let i = 0; i < 0x300; i++) {
            fullRestore[i] = (i & 0xFF) ^ 0xAA;
        }
        sparse.write(0x000, fullRestore);
        
        bufCount = sparse.writeBuffer.length;
        log(`  After restoring full original pattern: ${bufCount} write buffer(s)`);
        for (let i = 0; i < sparse.writeBuffer.length; i++) {
            const seg = sparse.writeBuffer[i];
            log(`    [${i}] 0x${seg.address.toString(16)}-0x${(seg.address + seg.data.length).toString(16)} (${seg.data.length} bytes)`);
        }
        
        // Critical assertion: WITHOUT cached data, there's nothing to prune against
        // So we should have exactly 1 write buffer with the original pattern
        assert(bufCount === 1, `After all operations with no cached data, expect 1 write buffer, got ${bufCount}`);
        
        // Verify the write buffer contains the original pattern
        const buf = sparse.writeBuffer[0];
        assert(buf.address === 0x000, `Write buffer starts at 0x000, got 0x${buf.address.toString(16)}`);
        assert(buf.data.length === 0x300, `Write buffer is 0x300 bytes, got ${buf.data.length}`);
        
        for (let i = 0; i < 0x300; i++) {
            const val = buf.data[i];
            const expected = (i & 0xFF) ^ 0xAA;
            assert(val === expected, `Write buffer byte at 0x${i.toString(16)} matches original pattern`);
        }
        
        // Also verify via _get()
        for (let i = 0; i < 0x300; i++) {
            const val = sparse._get(i);
            const expected = (i & 0xFF) ^ 0xAA;
            assert(val === expected, `Data at 0x${i.toString(16)} matches original pattern`);
        }
        
        log(`  📊 No-cache pruning test passed: single write buffer maintained with original pattern`);
    });
};
