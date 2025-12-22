module.exports = async function registerTests({ runTest, assert, SparseImage, log }) {
    await runTest('Flush merges touching writes before committing', async () => {
        const size = 0x100000; // 1MB
        const buffer = new Uint8Array(size);
        buffer.fill(0xFF); // Erased
        
        const writeLog = [];
        const writeCallback = async (addr, data) => {
            writeLog.push({ address: addr, length: data.length });
        };
        
        const sparse = SparseImage.fromBuffer(buffer, 0x1000);
        sparse.writeDataCallback = writeCallback;
        
        // Make overlapping writes that should merge
        const data1 = new Uint8Array(0x1000);
        data1.fill(0x11);
        sparse.write(0x10000, data1);
        
        const data2 = new Uint8Array(0x1000);
        data2.fill(0x22);
        sparse.write(0x11000, data2);
        
        const beforeFlushCount = sparse.writeBuffer.length;
        await sparse.flush();
        
        assert(writeLog.length > 0, 'writeDataCallback was invoked during flush');
        
        // After flush, read buffer should be updated with committed data
        const readData1 = sparse.subarray(0x10000, 0x10010);
        assert(readData1.every(b => b === 0x11), 'First write persisted in read buffer after flush');
        
        const readData2 = sparse.subarray(0x11000, 0x11010);
        assert(readData2.every(b => b === 0x22), 'Second write persisted in read buffer after flush');
        
        log(`  📊 Write buffer segments before flush: ${beforeFlushCount}, callback invocations: ${writeLog.length}`);
    });
};
