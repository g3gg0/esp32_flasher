module.exports = async function registerTests({ runTest, assert, SparseImage, log }) {
    await runTest('Random writes over 0xFF cache, then erase to match - write buffer should prune', async () => {
        const size = 0x100000; // 1MB
        const initialBuffer = new Uint8Array(size);
        initialBuffer.fill(0xFF); // Erased (all 0xFF)
        
        // Create sparse image with all-0xFF cached data
        const sparse = SparseImage.fromBuffer(initialBuffer, 0x1000);
        
        // Create 128 sequential addresses (0-127)
        const baseAddr = 0x10000;
        const numWrites = 128;
        
        const sequence = [];
        for (let i = 0; i < numWrites; i++) {
            sequence.push(i);
        }
        
        // Shuffle the sequence randomly (Fisher-Yates)
        for (let i = sequence.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [sequence[i], sequence[j]] = [sequence[j], sequence[i]];
        }
        
        log(`  Write order (first 20): ${sequence.slice(0, 20).join(', ')}`);
        
        // Write in shuffled order (non-0xFF values)
        for (let idx = 0; idx < numWrites; idx++) {
            const offset = sequence[idx];
            const data = new Uint8Array([offset & 0xFF]);
            sparse.write(baseAddr + offset, data);
            
            if (idx < 5 || idx === numWrites - 1) {
                log(`  Write ${idx}: offset=${offset} (0x${offset.toString(16)}), segments=${sparse.writeBuffer.length}`);
            }
        }
        
        const afterRandomWrites = sparse.writeBuffer.length;
        log(`  After random writes: ${afterRandomWrites} segments`);
        
        // Now write 0xFF everywhere to match the cached data
        const fillData = new Uint8Array(0x80); // Fill the affected range with 0xFF
        fillData.fill(0xFF);
        sparse.write(baseAddr, fillData);
        
        const afterEraseWrites = sparse.writeBuffer.length;
        log(`  After erase (0xFF write): ${afterEraseWrites} segments`);
        
        for (let i = 0; i < sparse.writeBuffer.length; i++) {
            const seg = sparse.writeBuffer[i];
            log(`    [${i}] 0x${seg.address.toString(16)}-0x${(seg.address + seg.data.length).toString(16)} (${seg.data.length} bytes)`);
        }
        
        // The critical assertion: after writing 0xFF over cached 0xFF, 
        // the write buffer should be pruned to nothing (they match the cache)
        assert(sparse.writeBuffer.length === 0, `Write buffer should be empty after 0xFF erase matches cache, but has ${afterEraseWrites} segments`);
        
        // Verify the data is still correct (all 0xFF in the range)
        let verified = 0;
        for (let i = 0; i < numWrites; i++) {
            const written = sparse._get(baseAddr + i);
            if (written === 0xFF) {
                verified++;
            }
        }
        
        assert(verified === numWrites, `All ${numWrites} bytes should be 0xFF after erase, verified ${verified}`);
        
        log(`  📊 Random writes over 0xFF cache, then erase → write buffer pruned empty, ${verified}/${numWrites} bytes verified as 0xFF`);
    });
};
