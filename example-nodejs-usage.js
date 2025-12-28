#!/usr/bin/env node
/*
 * Example Node.js usage of ESPFlasher
 * 
 * Prerequisites:
 *   npm install serialport
 * 
 * Usage:
 *   node flasher-example-nodejs.js <port> [command]
 *   node flasher-example-nodejs.js /dev/ttyUSB0 info
 *   node flasher-example-nodejs.js COM3 read 0x0 0x1000
 *   node flasher-example-nodejs.js /dev/ttyUSB0 write firmware.bin 0x10000
 */

const fs = require('fs');
const path = require('path');

/*
 * Load dependencies in correct order
 */

/* First, set up the Web Serial polyfill and Node.js compatibility */
require('./flasher-nodejs.js');

/* Load chips.js (chip definitions) */
const ChipDescriptions = require('./chips.js');
global.ChipDescriptions = ChipDescriptions;

/* Load parser.js (ESP32 firmware parser) */
const ESP32Parser = require('./esp32-parser.js');

/* Load flasher.js (main ESP32 flashing library) */
const ESPFlasher = require('./flasher.js');

if (!ESPFlasher) {
    console.error('Failed to load ESPFlasher');
    process.exit(1);
}

const { createNodeESPFlasher } = require('./flasher-nodejs.js');

async function main() {
    const args = process.argv.slice(2);

    if (args.length < 1) {
        console.error('Usage: node flasher-example-nodejs.js <port> [command] [args...]');
        console.error('');
        console.error('Examples:');
        console.error('  node flasher-example-nodejs.js /dev/ttyUSB0 list-ports');
        console.error('  node flasher-example-nodejs.js /dev/ttyUSB0 info');
        console.error('  node flasher-example-nodejs.js /dev/ttyUSB0 read 0x0 0x1000 output.bin');
        console.error('  node flasher-example-nodejs.js /dev/ttyUSB0 write firmware.bin 0x10000');
        process.exit(1);
    }

    const portPath = args[0];
    const command = args[1] || 'info';

    try {
        if (command === 'list-ports') {
            console.log('Available serial ports:');
            const NodeESPFlasher = createNodeESPFlasher(ESPFlasher);
            const ports = await NodeESPFlasher.listPorts();
            if (ports.length === 0) {
                console.log('  No ports found');
            } else {
                ports.forEach(port => {
                    console.log(`  ${port.path}`);
                    if (port.manufacturer) console.log(`    Manufacturer: ${port.manufacturer}`);
                    if (port.serialNumber) console.log(`    Serial: ${port.serialNumber}`);
                });
            }
            return;
        }

        /* Create flasher instance */
        const NodeESPFlasher = createNodeESPFlasher(ESPFlasher);
        const flasher = new NodeESPFlasher();

        /* Set up logging */
        flasher.devMode = false;
        flasher.logDebug = () => {}; /* Suppress debug output */
        flasher.logError = (msg) => console.error('[ERROR]', msg);

        /* Open port */
        console.log(`Opening port ${portPath}...`);
        await flasher.openPortByPath(portPath);
        console.log('Port opened, syncing...');
        /* Attempt bootloader reset for reliability; no-op on raw FD */
        try {
            await flasher.hardReset(true);
        } catch (e) {
            /* Ignore reset errors */
        }
        await flasher.sync();

        /* Handle commands */
        switch (command) {
            case 'info':
                await handleInfo(flasher);
                break;

            case 'read':
                if (args.length < 4) {
                    throw new Error('Usage: read <address> <length> [outputFile]');
                }
                const readAddr = parseInt(args[2], 16);
                const readLen = parseInt(args[3], 16);
                const outputFile = args[4] || 'output.bin';
                await handleRead(flasher, readAddr, readLen, outputFile);
                break;

            case 'write':
                if (args.length < 3) {
                    throw new Error('Usage: write <inputFile> <address>');
                }
                const inputFile = args[2];
                const writeAddr = parseInt(args[3], 16);
                await handleWrite(flasher, inputFile, writeAddr);
                break;

            default:
                throw new Error(`Unknown command: ${command}`);
        }

        /* Disconnect */
        await flasher.disconnect();
        console.log('Disconnected');
        
        /* Explicitly exit to ensure process terminates */
        process.exit(0);

    } catch (error) {
        console.error('Error:', error.message);
        process.exit(1);
    }
}

async function handleInfo(flasher) {
    console.log('Reading device info...');
    console.log(`Chip: ${flasher.current_chip || 'Unknown'}`);
    
    try {
        const mac = await flasher.readMac();
        console.log(`MAC Address: ${mac || 'Unknown'}`);
    } catch (e) {
        console.log(`MAC Address: Unknown (${e.message})`);
    }
}

async function handleRead(flasher, address, length, outputFile) {
    console.log(`Reading ${length} bytes from 0x${address.toString(16).padStart(8, '0')}...`);

    /* Load stub loader for faster and more reliable flash reading */
    console.log('Loading stub loader...');
    await flasher.downloadStub();
    console.log('Stub loaded successfully');

    const data = await flasher.readFlash(address, length, (bytesRead, totalBytes) => {
        const percent = Math.round((bytesRead / totalBytes) * 100);
        process.stdout.write(`\rProgress: ${bytesRead}/${totalBytes} bytes (${percent}%) `);
    });

    console.log('\nWriting to', outputFile);
    fs.writeFileSync(outputFile, Buffer.from(data));
    console.log(`Saved ${data.length} bytes to ${outputFile}`);
}

async function handleWrite(flasher, inputFile, address) {
    if (!fs.existsSync(inputFile)) {
        throw new Error(`File not found: ${inputFile}`);
    }

    const fileData = fs.readFileSync(inputFile);
    const data = new Uint8Array(fileData);

    console.log(`Writing ${data.length} bytes to 0x${address.toString(16).padStart(8, '0')}...`);

    await flasher.writeFlash(address, data, (bytesWritten, totalBytes, stage) => {
        const percent = Math.round((bytesWritten / totalBytes) * 100);
        process.stdout.write(`\rProgress: ${bytesWritten}/${totalBytes} bytes (${percent}%) - ${stage} `);
    });

    console.log('\nWrite complete');
}

main().catch(error => {
    console.error('Fatal error:', error);
    process.exit(1);
});
