module.exports = async function registerTests({ runTest, assert, SparseImage, log }) {
    await runTest('Erase then import file with 0xFF in overlap region', async () => {
        // Create a sparse image with initial data (simulating loaded file)
        const size = 0x500000; // 5MB
        const buffer = new Uint8Array(size);
        
        // Fill with some pattern
        for (let i = 0; i < size; i++) {
            buffer[i] = i % 256;
        }
        
        const sparse = SparseImage.fromBuffer(buffer);
        
        // Initial state: no write buffer
        assert(sparse.writeBuffer.length === 0, 'Initial write buffer is empty');
        
        // Step 1: Erase flash (fill with 0xFF)
        sparse.writeBuffer = []; // Clear write buffer (simulating erase button)
        sparse.fill(0xFF, 0, size);
        
        const afterEraseCount = sparse.writeBuffer.length;
        assert(afterEraseCount > 0, `After erase, write buffer has segments (${afterEraseCount})`);
        
        // Check that 0x3A0000 area is covered
        const hasEraseAt3A0000 = sparse.writeBuffer.some(seg => 
            seg.address <= 0x3A0000 && (seg.address + seg.data.length) > 0x3A0000
        );
        assert(hasEraseAt3A0000, 'Erase created write buffer covering 0x3A0000');
        
        // Step 2: Import a file that has 0xFF in some regions (like storage.bin)
        const storageData = new Uint8Array(0xE0000); // 896 KB like storage.bin
        // Fill first part with actual data
        for (let i = 0; i < 0x80000; i++) {
            storageData[i] = (i % 256);
        }
        // Fill rest with 0xFF (simulating sparse storage)
        for (let i = 0x80000; i < storageData.length; i++) {
            storageData[i] = 0xFF;
        }
        
        const beforeImportCount = sparse.writeBuffer.length;
        await sparse.write(0x320000, storageData);
        
        const afterImportCount = sparse.writeBuffer.length;
        assert(afterImportCount > 0, `After import, write buffer has segments (${afterImportCount})`);
        
        // Check that the 0x3A0000-0x400000 range still has write buffer segments
        // This is the critical test: the 0xFF in storage.bin should create write segments
        // even though it matches the erase data
        const hasWriteAt3A0000 = sparse.writeBuffer.some(seg => 
            seg.address <= 0x3A0000 && (seg.address + seg.data.length) > 0x3A0000
        );
        assert(hasWriteAt3A0000, 'After import, write buffer still covers 0x3A0000');
        
        // Verify the data at 0x3A0000 is 0xFF (from storage.bin, not from cached read buffer)
        const dataAt3A0000 = await sparse.subarray_async(0x3A0000, 0x3A0100);
        const allFF = dataAt3A0000.every(b => b === 0xFF);
        assert(allFF, 'Data at 0x3A0000 is 0xFF after import');
        
        // Most importantly: verify there's a write buffer segment covering this range
        const writeSegmentAt3A0000 = sparse.writeBuffer.find(seg => 
            seg.address <= 0x3A0000 && (seg.address + seg.data.length) > 0x3A0000
        );
        assert(writeSegmentAt3A0000 !== undefined, 'Write buffer segment exists at 0x3A0000');
        
        log(`  📊 Write buffer segments: before=${beforeImportCount}, after=${afterImportCount}`);
    });
};
