module.exports = async function registerTests({ runTest, assert, SparseImage, log }) {
    await runTest('Write callback triggers on flush with aligned data', async () => {
        const size = 0x20000;
        const buffer = new Uint8Array(size);
        buffer.fill(0xFF);
        
        const writeLog = [];
        const writeCallback = async (addr, data) => {
            writeLog.push({ address: addr, length: data.length, data: data.slice() });
        };
        
        const sparse = SparseImage.fromBuffer(buffer, 0x1000);
        sparse.writeDataCallback = writeCallback;
        
        const payload = new Uint8Array(0x600);
        for (let i = 0; i < payload.length; i++) {
            payload[i] = (i & 0xFF) ^ 0xAA;
        }
        sparse.write(0x8000, payload);
        
        assert(sparse.writeBuffer.length > 0, 'Write buffer populated before flush');
        await sparse.flush();
        
        assert(writeLog.length === 1, `writeDataCallback called once, got ${writeLog.length}`);
        const call = writeLog[0];
        log(`Write callback addr=0x${call.address.toString(16)} len=0x${call.length.toString(16)}`);
        assert(call.address === 0x8000, `Callback address is 0x8000, got 0x${call.address.toString(16)}`);
        assert(call.length === 0x1000, `Callback length is sector-sized 0x1000, got 0x${call.length.toString(16)}`);
        for (let i = 0; i < payload.length; i++) {
            const expected = (i & 0xFF) ^ 0xAA;
            assert(call.data[i] === expected, `Callback data offset ${i} matches pattern 0x${expected.toString(16)}`);
        }
        
        assert(sparse.writeBuffer.length === 0, 'Write buffer cleared after flush');
        const verify = sparse.subarray(0x8000, 0x8000 + payload.length);
        for (let i = 0; i < verify.length; i++) {
            const expected = (i & 0xFF) ^ 0xAA;
            assert(verify[i] === expected, `Persisted data matches pattern at offset ${i}`);
        }
    });
};
