#!/usr/bin/env node

/**
 * Test cases for SparseImage write buffer handling
 * 
 * Run with: node testcases.js
 */

const fs = require('fs');
const path = require('path');
const util = require('util');
const { SparseImage } = require('./esp32-parser');

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const RESET = '\x1b[0m';
let VERBOSE = process.env.VERBOSE === '1' || process.env.VERBOSE === 'true';

function printHelp() {
    console.log('Usage: node testcases.js [options]');
    console.log('');
    console.log('Options:');
    console.log('  -v, --verbose   Enable verbose per-test logging');
    console.log('  -h, --help      Show this help message');
}

function parseArgs(argv) {
    for (let i = 2; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '-v' || arg === '--verbose') {
            VERBOSE = true;
        } else if (arg === '-h' || arg === '--help') {
            printHelp();
            process.exit(0);
        } else {
            console.warn(`Unknown option: ${arg}`);
        }
    }
}

function flush() {
    return new Promise(resolve => process.stdout.write('', resolve));
}

function log(...args) {
    if (!VERBOSE) return;
    if (!global.currentTestLogs) global.currentTestLogs = [];
    global.currentTestLogs.push(util.format(...args));
}

let testsPassed = 0;
let testsFailed = 0;
let testIndex = 0;

function assert(condition, message) {
    if (!condition) {
        console.error('  ❌ FAIL:', message);
        testsFailed++;
        return false;
    }
    log('  ✅ PASS:', message);
    testsPassed++;
    return true;
}

async function runTest(name, testFn) {
    testIndex++;
    global.currentTestLogs = [];
    log(`\n[TEST] ${name}`);
    try {
        const prefix = `Testcase #${testIndex} - ${name}: `;
        process.stdout.write(prefix);
        await flush();
        await testFn();
        console.log(`[${GREEN}PASS${RESET}]`);
        await flush();
        if (VERBOSE && global.currentTestLogs.length) {
            for (const line of global.currentTestLogs) {
                console.log(`    ${line}`);
            }
        }
    } catch (error) {
        console.log(`[${RED}FAIL${RESET}]`);
        await flush();
        if (VERBOSE && global.currentTestLogs.length) {
            for (const line of global.currentTestLogs) {
                console.log(`    ${line}`);
            }
        }
        console.error('  ❌ ERROR:', error.message);
        console.error(error.stack);
        testsFailed++;
    }
}

async function runAllTests() {
    parseArgs(process.argv);

    const testsDir = path.join(__dirname, 'testcases');
    const files = fs.readdirSync(testsDir)
        .filter(name => name.endsWith('.js'))
        .sort();

    for (const file of files) {
        const register = require(path.join(testsDir, file));
        if (typeof register === 'function') {
            await register({ runTest, assert, SparseImage, log });
        } else if (register && typeof register.registerTests === 'function') {
            await register.registerTests({ runTest, assert, SparseImage, log });
        } else {
            console.warn(`Skipping ${file}: no registerTests export`);
        }
    }

    console.log('\n' + '='.repeat(50));
    console.log(`Tests passed: ${testsPassed}`);
    console.log(`Tests failed: ${testsFailed}`);
    console.log('='.repeat(50));

    process.exit(testsFailed > 0 ? 1 : 0);
}

runAllTests().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
