module.exports = async function registerTests({ runTest, assert, SparseImage, log }) {
    await runTest('Writes in random address order merge into single segment', async () => {
        const size = 0x100000; // 1MB
        
        // Use empty uncached sparse image (no initial read buffer)
        // This ensures writes only create necessary segments, not full sectors
        const sparse = new SparseImage(size, null, null, null, 0x1000);
        
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
        
        // Write in shuffled order
        for (let idx = 0; idx < numWrites; idx++) {
            const offset = sequence[idx];
            const data = new Uint8Array([offset & 0xFF]);
            sparse.write(baseAddr + offset, data);
            
            if (idx < 5 || idx === numWrites - 1) {
                log(`  Write ${idx}: offset=${offset} (0x${offset.toString(16)}), segments=${sparse.writeBuffer.length}`);
            }
        }
        
        // After all writes in random address order, should merge into single segment
        const writeBufSegments = sparse.writeBuffer;
        log(`  Final write buffer segments: ${writeBufSegments.length}`);
        for (let i = 0; i < writeBufSegments.length; i++) {
            const seg = writeBufSegments[i];
            log(`    [${i}] 0x${seg.address.toString(16)}-0x${(seg.address + seg.data.length).toString(16)} (${seg.data.length} bytes)`);
        }
        
        assert(writeBufSegments.length === 1, `Random address writes merged into ${writeBufSegments.length} segment (expected 1)`);
        
        // Verify the segment covers the entire range
        const merged = writeBufSegments[0];
        assert(merged.address === baseAddr, `Merged segment starts at 0x${merged.address.toString(16)} (expected 0x${baseAddr.toString(16)})`);
        assert(merged.data.length === numWrites, `Merged segment has ${merged.data.length} bytes (expected ${numWrites})`);
        
        // Verify all written bytes are correct
        let verified = 0;
        const mismatches = [];
        for (let i = 0; i < numWrites; i++) {
            const written = sparse._get(baseAddr + i);
            const expected = i & 0xFF;
            if (written === expected) {
                verified++;
            } else {
                if (mismatches.length < 5) {
                    mismatches.push(`offset ${i}: got 0x${written.toString(16)}, expected 0x${expected.toString(16)}`);
                }
            }
        }
        
        if (mismatches.length > 0) {
            log(`  Mismatches (first 5): ${mismatches.join(', ')}`);
        }
        
        assert(verified === numWrites, `Verified ${verified}/${numWrites} bytes`);
        
        log(`  📊 ${numWrites} writes in random address order merged into ${writeBufSegments.length} segment, ${verified}/${numWrites} bytes verified`);
    });
};
