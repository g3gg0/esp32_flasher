module.exports = async function registerTests({ runTest, assert, SparseImage, log }) {
    await runTest('Import identical data over erase preserves write buffer', async () => {
        const size = 0x100000; // 1MB
        const buffer = new Uint8Array(size);
        
        // Fill with pattern
        for (let i = 0; i < size; i++) {
            buffer[i] = (i & 0xFF);
        }
        
        const sparse = SparseImage.fromBuffer(buffer);
        
        // Erase a region
        sparse.writeBuffer = [];
        sparse.fill(0xFF, 0x50000, 0xA0000);
        
        const eraseSegments = sparse.writeBuffer.filter(seg => 
            seg.address >= 0x50000 && seg.address < 0xA0000
        );
        assert(eraseSegments.length > 0, 'Erase created write buffer segments');
        
        // Import data that's all 0xFF (identical to erase)
        const importData = new Uint8Array(0x30000);
        importData.fill(0xFF);
        await sparse.write(0x60000, importData);
        
        // Should still have write segments in the 0x60000-0x90000 range
        const postImportSegments = sparse.writeBuffer.filter(seg => 
            seg.address < 0x90000 && (seg.address + seg.data.length) > 0x60000
        );
        assert(postImportSegments.length > 0, 'Import of identical 0xFF data preserves write segments');
        
        // Verify the data is 0xFF
        const data = await sparse.subarray_async(0x60000, 0x60100);
        assert(data.every(b => b === 0xFF), 'Data is 0xFF after import');
    });
};
