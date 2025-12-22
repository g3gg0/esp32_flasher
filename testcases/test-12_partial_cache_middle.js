module.exports = async function registerTests({ runTest, assert, SparseImage, log }) {
    await runTest('Complex operations with only middle sector cached - expect two edge buffers', async () => {
        const sectorSize = 0x100;
        const totalSize = 0x10000; // 64KB
        
        // Create sparse image with ONLY the middle sector cached (0x100-0x1FF)
        const sparse = new SparseImage(totalSize, null, null, null, sectorSize);
        // Manually add only the middle cached data
        const cachedData = new Uint8Array(0x100);
        for (let i = 0; i < 0x100; i++) {
            cachedData[i] = (i & 0xFF) ^ 0xAA;
        }
        sparse.readBuffer.push({
            address: 0x100,
            data: cachedData
        });
        
        // Verify initial cache state
        const byte100 = sparse._get(0x100);
        log(`  Cached data: byte[0x100]=${byte100.toString(16)}`);
        assert(byte100 === ((0x100 & 0xFF) ^ 0xAA), 'Cached byte at 0x100 matches pattern');
        
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
        assert(bufCount >= 1, `After clearing everything, write buffer has segments (${bufCount})`);
        
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
        
        // After restore, middle should be pruned (matches cache), but edges remain as 0xFF
        assert(bufCount === 2, `After restoring middle, expect 2 write buffers (edges), got ${bufCount}`);
        
        // Verify the two buffers are at the edges
        const buffers = sparse.writeBuffer.sort((a, b) => a.address - b.address);
        assert(buffers[0].address === 0x000, `First buffer at 0x000, got 0x${buffers[0].address.toString(16)}`);
        assert(buffers[0].data.length === 0x100, `First buffer is 0x100 bytes, got ${buffers[0].data.length}`);
        assert(buffers[1].address === 0x200, `Second buffer at 0x200, got 0x${buffers[1].address.toString(16)}`);
        assert(buffers[1].data.length === 0x100, `Second buffer is 0x100 bytes, got ${buffers[1].data.length}`);
        
        // Step 4: Write 0x00 everywhere (0x000-0x2FF)
        const zeroFill = new Uint8Array(0x300);
        zeroFill.fill(0x00);
        sparse.write(0x000, zeroFill);
        
        bufCount = sparse.writeBuffer.length;
        log(`  After writing 0x00 everywhere: ${bufCount} write buffer(s)`);
        for (let i = 0; i < sparse.writeBuffer.length; i++) {
            const seg = sparse.writeBuffer[i];
            log(`    [${i}] 0x${seg.address.toString(16)}-0x${(seg.address + seg.data.length).toString(16)}`);
        }
        assert(bufCount >= 1, `After writing 0x00, write buffer has segments (${bufCount})`);
        
        // Step 5: Restore original pattern (0x000-0x2FF)
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
        
        // Critical assertion: with only middle cached, the middle gets pruned but edges remain
        // Expect 2 buffers at 0x000 and 0x200 (the uncached edges)
        assert(bufCount === 2, `After all operations with partial cache, expect 2 write buffers, got ${bufCount}`);
        
        // Verify the two buffers are at the edges
        const finalBuffers = sparse.writeBuffer.sort((a, b) => a.address - b.address);
        assert(finalBuffers[0].address === 0x000, `First buffer at 0x000, got 0x${finalBuffers[0].address.toString(16)}`);
        assert(finalBuffers[0].data.length === 0x100, `First buffer is 0x100 bytes, got ${finalBuffers[0].data.length}`);
        assert(finalBuffers[1].address === 0x200, `Second buffer at 0x200, got 0x${finalBuffers[1].address.toString(16)}`);
        assert(finalBuffers[1].data.length === 0x100, `Second buffer is 0x100 bytes, got ${finalBuffers[1].data.length}`);
        
        // Verify edge buffers contain the original pattern
        for (let i = 0; i < 0x100; i++) {
            const val0 = finalBuffers[0].data[i];
            const val2 = finalBuffers[1].data[i];
            const expected0 = (i & 0xFF) ^ 0xAA;
            const expected2 = ((0x200 + i) & 0xFF) ^ 0xAA;
            assert(val0 === expected0, `Edge0 buffer byte at 0x${i.toString(16)} matches pattern`);
            assert(val2 === expected2, `Edge2 buffer byte at 0x${i.toString(16)} matches pattern`);
        }
        
        // Verify via _get() that middle matches pattern (from cache since pruned)
        for (let i = 0; i < 0x100; i++) {
            const val = sparse._get(0x100 + i);
            const expected = (i & 0xFF) ^ 0xAA;
            assert(val === expected, `Middle byte at 0x${(0x100 + i).toString(16)} matches original pattern`);
        }
        
        log(`  📊 Partial cache pruning test passed: edge buffers at 0x000 and 0x200, middle pruned`);
    });
};
