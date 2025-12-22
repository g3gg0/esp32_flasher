module.exports = async function registerTests({ runTest, assert, SparseImage, log }) {
    await runTest('Multiple overlapping writes preserve all changes', async () => {
        const size = 0x100000;
        const buffer = new Uint8Array(size);
        buffer.fill(0x00);
        
        const sparse = SparseImage.fromBuffer(buffer);
        
        // Write 1: Fill region with 0xFF
        sparse.writeBuffer = [];
        sparse.fill(0xFF, 0x10000, 0x20000);
        
        // Write 2: Partially overlap with different data
        const data1 = new Uint8Array(0x8000);
        data1.fill(0xAA);
        await sparse.write(0x18000, data1);
        
        // Write 3: Another overlap with 0xFF
        const data2 = new Uint8Array(0x4000);
        data2.fill(0xFF);
        await sparse.write(0x1C000, data2);
        
        // Verify the layered data
        const result1 = await sparse.subarray_async(0x10000, 0x18000);
        assert(result1.every(b => b === 0xFF), 'Region 0x10000-0x18000 is 0xFF');
        
        const result2 = await sparse.subarray_async(0x18000, 0x1C000);
        assert(result2.every(b => b === 0xAA), 'Region 0x18000-0x1C000 is 0xAA');
        
        const result3 = await sparse.subarray_async(0x1C000, 0x20000);
        assert(result3.every(b => b === 0xFF), 'Region 0x1C000-0x20000 is 0xFF');
        
        assert(sparse.writeBuffer.length > 0, 'Write buffer has segments after multiple overlaps');
    });
};
