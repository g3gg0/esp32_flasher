module.exports = async function registerTests({ runTest, assert, SparseImage, log }) {
    await runTest('Callback system: read from device expands read buffer', async () => {
        const totalSize = 0x100000; // 1MB
        
        // Create EMPTY sparse image with NO initial data
        const sparse = new SparseImage(totalSize, null, null, null, 0x1000);
        
        // Track callback invocations
        const readLog = [];
        
        // Set up read callback that returns 0x1000 bytes when requested
        sparse.readDataCallback = async (address, length) => {
            readLog.push({ address, length });
            
            // Return 0x1000 bytes of data with pattern (addr + offset) & 0xFF
            const data = new Uint8Array(0x1000);
            for (let i = 0; i < 0x1000; i++) {
                data[i] = ((address + i) & 0xFF);
            }
            return data;
        };
        
        // Try to read 0x100 bytes from 0x8000
        // This should trigger the callback to fetch a full sector
        const readResult = await sparse.subarray_async(0x8000, 0x8100);
        
        log(`  Read callback invocations: ${readLog.length}`);
        for (let i = 0; i < readLog.length; i++) {
            const call = readLog[i];
            log(`    [${i}] address=0x${call.address.toString(16)}, length=0x${call.length.toString(16)}`);
        }
        
        // Callback should have been invoked once
        assert(readLog.length > 0, 'Read callback was invoked');
        
        const firstCall = readLog[0];
        log(`  First callback call: address=0x${firstCall.address.toString(16)}, length=0x${firstCall.length.toString(16)}`);
        
        // The callback should have been asked for the full sector or a reasonable chunk
        // Expect address to be sector-aligned (0x8000) or the exact read position
        assert(firstCall.address === 0x8000 || firstCall.address <= 0x8000, 
            `Read address should be 0x8000 or earlier, got 0x${firstCall.address.toString(16)}`);
        
        // Check that read buffer now contains the data
        log(`  Read buffer segments: ${sparse.readBuffer.length}`);
        for (let i = 0; i < sparse.readBuffer.length; i++) {
            const seg = sparse.readBuffer[i];
            log(`    [${i}] 0x${seg.address.toString(16)}-0x${(seg.address + seg.data.length).toString(16)} (${seg.data.length} bytes)`);
        }
        
        assert(sparse.readBuffer.length > 0, 'Read buffer has segments after callback');
        
        // Verify data in read buffer
        const buf = sparse.readBuffer[0];
        assert(buf.address === 0x8000, `Read buffer starts at 0x8000, got 0x${buf.address.toString(16)}`);
        assert(buf.data.length === 0x1000, `Read buffer has 0x1000 bytes, got ${buf.data.length}`);
        
        // Verify the data matches the pattern
        for (let i = 0; i < 0x100; i++) {
            const val = buf.data[i];
            const expected = (0x8000 + i) & 0xFF;
            assert(val === expected, `Read buffer byte at offset 0x${i.toString(16)} matches pattern`);
        }
        
        // Verify the result from subarray_async matches
        for (let i = 0; i < 0x100; i++) {
            const val = readResult[i];
            const expected = (0x8000 + i) & 0xFF;
            assert(val === expected, `Read result byte at 0x${i.toString(16)} matches pattern`);
        }
        
        log(`  📊 Callback test passed: read callback populated 0x1000-byte read buffer`);
    });
};
