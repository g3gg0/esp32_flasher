module.exports = async function registerTests({ runTest, assert, SparseImage, log }) {
    await runTest('Flush invokes writeDataCallback for pending writes', async () => {
        const size = 0x100000; // 1MB
        const buffer = new Uint8Array(size);
        buffer.fill(0xCC); // Pattern
        
        const writeLog = [];
        const writeCallback = async (addr, data) => {
            writeLog.push({ address: addr, length: data.length });
        };
        
        const sparse = SparseImage.fromBuffer(buffer, 0x1000);
        sparse.writeDataCallback = writeCallback;
        
        // Make some writes
        const data1 = new Uint8Array(0x2000);
        data1.fill(0x11);
        sparse.write(0x10000, data1);
        
        const data2 = new Uint8Array(0x1000);
        data2.fill(0x22);
        sparse.write(0x50000, data2);
        
        assert(sparse.writeBuffer.length > 0, 'Write buffer has segments before flush');
        assert(writeLog.length === 0, 'No writeDataCallback invocations before flush');
        
        // Flush
        await sparse.flush();
        
        assert(sparse.writeBuffer.length === 0, 'Write buffer cleared after flush');
        assert(writeLog.length > 0, `writeDataCallback invoked ${writeLog.length} times`);
        
        let totalBytes = 0;
        for (const call of writeLog) {
            assert(call.address % 0x1000 === 0, `Write address 0x${call.address.toString(16)} is sector-aligned`);
            totalBytes += call.length;
        }
        assert(totalBytes > 0, `Total written bytes: ${totalBytes}`);
        
        log(`  📊 Write calls: ${writeLog.length}, total bytes: ${totalBytes}`);
    });
};
