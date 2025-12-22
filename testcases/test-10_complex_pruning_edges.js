module.exports = async function registerTests({ runTest, assert, SparseImage, log }) {
    await runTest('Complex pruning: clear middle, clear all, restore middle - expect two edge buffers', async () => {
        const sectorSize = 0x100;
        const totalSize = 0x10000; // 64KB
        
        // Create initial cached data: 0x300 bytes with pattern (offset & 0xFF) ^ 0xAA
        const initialData = new Uint8Array(totalSize);
        initialData.fill(0xFF); // Start with erased
        for (let i = 0; i < 0x300; i++) {
            initialData[i] = (i & 0xFF) ^ 0xAA;
        }
        
        const sparse = SparseImage.fromBuffer(initialData, sectorSize);
        
        // Verify initial state
        const byte0 = sparse._get(0x000);
        const byte100 = sparse._get(0x100);
        const byte200 = sparse._get(0x200);
        log(`  Initial data: byte[0x000]=${byte0.toString(16)}, byte[0x100]=${byte100.toString(16)}, byte[0x200]=${byte200.toString(16)}`);
        assert(byte0 === ((0x000 & 0xFF) ^ 0xAA), 'Initial byte at 0x000 matches pattern');
        assert(byte100 === ((0x100 & 0xFF) ^ 0xAA), 'Initial byte at 0x100 matches pattern');
        assert(byte200 === ((0x200 & 0xFF) ^ 0xAA), 'Initial byte at 0x200 matches pattern');
        
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
        assert(bufCount === 1, `After clearing middle, expect 1 write buffer, got ${bufCount}`);
        
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
        
        // Critical assertions: should have pruned the middle sector (it now matches original cached data)
        // but kept the edges (0x000-0x0FF and 0x200-0x2FF are still 0xFF, which doesn't match original)
        assert(bufCount === 2, `After restoring middle, expect 2 write buffers (edges), got ${bufCount}`);
        
        // Verify the two buffers are at the edges
        const buffers = sparse.writeBuffer.sort((a, b) => a.address - b.address);
        assert(buffers[0].address === 0x000, `First buffer at 0x000, got 0x${buffers[0].address.toString(16)}`);
        assert(buffers[0].data.length === 0x100, `First buffer is 0x100 bytes, got ${buffers[0].data.length}`);
        assert(buffers[1].address === 0x200, `Second buffer at 0x200, got 0x${buffers[1].address.toString(16)}`);
        assert(buffers[1].data.length === 0x100, `Second buffer is 0x100 bytes, got ${buffers[1].data.length}`);
        
        // Verify that all edge buffers contain 0xFF
        let allFF0 = true, allFF1 = true;
        for (let i = 0; i < buffers[0].data.length; i++) {
            if (buffers[0].data[i] !== 0xFF) allFF0 = false;
        }
        for (let i = 0; i < buffers[1].data.length; i++) {
            if (buffers[1].data[i] !== 0xFF) allFF1 = false;
        }
        assert(allFF0, 'First buffer (0x000) contains all 0xFF');
        assert(allFF1, 'Second buffer (0x200) contains all 0xFF');
        
        // Verify middle sector was pruned (verify the restored data)
        for (let i = 0; i < 0x100; i++) {
            const val = sparse._get(0x100 + i);
            const expected = (i & 0xFF) ^ 0xAA;
            assert(val === expected, `Middle byte at 0x${(0x100 + i).toString(16)} matches original pattern`);
        }
        
        log(`  📊 Complex pruning test passed: edge buffers at 0x000 and 0x200, middle pruned`);
        
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
        assert(bufCount >= 1, `After writing 0x00, write buffer has segments (${bufCount})`);
        
        // Step 5: Restore original pattern (0x000-0x2FF) - should match cached data and prune everything
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
        
        // Critical assertion: write buffer should be completely empty (all data matches original cached data)
        assert(bufCount === 0, `After restoring original pattern, expect 0 write buffers, got ${bufCount}`);
        
        // Verify all data matches the original
        for (let i = 0; i < 0x300; i++) {
            const val = sparse._get(i);
            const expected = (i & 0xFF) ^ 0xAA;
            assert(val === expected, `Byte at 0x${i.toString(16)} matches original pattern after full restore`);
        }
        
        log(`  📊 Extended pruning test passed: write buffer fully pruned after restoring original data`);
    });
};
