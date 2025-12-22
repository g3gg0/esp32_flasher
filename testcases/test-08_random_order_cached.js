module.exports = async function registerTests({ runTest, assert, SparseImage, log }) {
    await runTest('Writes in random order with partial cached data', async () => {
        const size = 0x100000; // 1MB
        const initialBuffer = new Uint8Array(size);
        initialBuffer.fill(0xFF); // Erased
        
        // Create sparse image WITH cached data (from initial buffer)
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
        
        // Write in shuffled order
        for (let idx = 0; idx < numWrites; idx++) {
            const offset = sequence[idx];
            const data = new Uint8Array([offset & 0xFF]);
            sparse.write(baseAddr + offset, data);
            
            if (idx < 5 || idx === numWrites - 1) {
                log(`  Write ${idx}: offset=${offset} (0x${offset.toString(16)}), segments=${sparse.writeBuffer.length}`);
            }
        }
        
        // After all writes in random address order with cached data, should still merge efficiently
        const writeBufSegments = sparse.writeBuffer;
        log(`  Final write buffer segments: ${writeBufSegments.length}`);
        for (let i = 0; i < writeBufSegments.length; i++) {
            const seg = writeBufSegments[i];
            log(`    [${i}] 0x${seg.address.toString(16)}-0x${(seg.address + seg.data.length).toString(16)} (${seg.data.length} bytes)`);
        }
        
        // With cached data, we might materialize full sectors, so accept any reasonable merging
        // The key is that we only wrote 128 bytes, not 4096, but sector materialization is expected
        // when writing to a cached region (to be able to write without reading the entire sector)
        assert(writeBufSegments.length >= 1, `Random address writes produced ${writeBufSegments.length} segment(s)`);
        
        let totalWritten = 0;
        for (const seg of writeBufSegments) {
            totalWritten += seg.data.length;
        }
        // With cached data covering full sectors, we may materialize entire sectors
        // This is expected behavior - the segment could be 4096 (full sector) or just 128 (minimal)
        log(`  Note: With cached data, write buffer is ${totalWritten} bytes (4096 if sector materialized, 128 if minimal)`);
        assert(writeBufSegments.length === 1, `Should merge into single segment, got ${writeBufSegments.length}`);
        
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
        
        log(`  📊 ${numWrites} writes in random order with cached data, ${verified}/${numWrites} bytes verified, ${totalWritten} bytes in write buffer`);
    });
};
