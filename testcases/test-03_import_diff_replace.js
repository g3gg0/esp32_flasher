module.exports = async function registerTests({ runTest, assert, SparseImage, log }) {
    await runTest('Import with different data replaces erase segments', async () => {
        const size = 0x100000; // 1MB
        const buffer = new Uint8Array(size);
        buffer.fill(0xAA); // Pattern
        
        const sparse = SparseImage.fromBuffer(buffer);
        
        // Erase
        sparse.writeBuffer = [];
        sparse.fill(0xFF, 0x50000, 0xA0000);
        
        // Import different data
        const importData = new Uint8Array(0x10000);
        importData.fill(0x42);
        await sparse.write(0x60000, importData);
        
        // Should have write segment with 0x42 data
        const data = await sparse.subarray_async(0x60000, 0x60100);
        assert(data.every(b => b === 0x42), 'Imported data (0x42) is present');
        
        // Should have write buffer segment
        const hasWriteSeg = sparse.writeBuffer.some(seg => 
            seg.address <= 0x60000 && (seg.address + seg.data.length) > 0x60000
        );
        assert(hasWriteSeg, 'Write buffer segment exists for imported data');
    });
};
