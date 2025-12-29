#!/usr/bin/env node
/**
 * ESP32 Firmware Validator - Node.js Example
 * 
 * Demonstrates using ESP32Parser.isValidImage() to validate firmware images
 * 
 * Usage:
 *   node example-validate-image.js <firmware.bin>
 *   node example-validate-image.js firmware.bin
 * 
 * Example output:
 *   ✓ Bootloader: Valid (found at 0x1000)
 *   ✓ Partition Table: Found at 0x8000
 *   ✓ OTA Data: Valid (boot partition: ota_0)
 *   ✓ Boot Partition: Valid (ota_0 has valid image + SHA256)
 *   ✓ NVS: Valid
 *   
 *   Overall Status: ✓ ALL VALID
 */

const fs = require('fs');
const path = require('path');

// Import ESP32Parser
const ESP32Parser = require('./esp32-parser.js');

/**
 * Format bytes to human readable format
 */
function formatBytes(bytes) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
}

/**
 * Print a status line with icon
 */
function printStatus(label, isValid, detail = '') {
    const icon = isValid ? '✓' : '✗';
    const color = isValid ? '\x1b[32m' : '\x1b[31m'; // Green or Red
    const reset = '\x1b[0m';
    const detailStr = detail ? ` (${detail})` : '';
    console.log(`${color}${icon}${reset} ${label}: ${isValid ? 'Valid' : 'Invalid'}${detailStr}`);
}

/**
 * Main validation function
 */
async function validateFirmware(filePath) {
    console.log(`\nValidating firmware: ${path.basename(filePath)}`);
    console.log('─'.repeat(60));
    
    try {
        // Read firmware file
        const fileBuffer = fs.readFileSync(filePath);
        console.log(`File size: ${formatBytes(fileBuffer.length)}\n`);
        
        // Run validation
        console.log('Running validation checks...\n');
        const result = await new ESP32Parser(fileBuffer).isValidImage();

        console.log('Validation Results:', result);
        
        // Print results
        let bootloaderDetail = '';
        if (result.bootloader && result.bootloaderOffset !== null) {
            bootloaderDetail = `found at 0x${result.bootloaderOffset.toString(16).toUpperCase()}`;
        }
        printStatus('Bootloader', result.bootloader, bootloaderDetail);
        
        const ptDetail = result.partitionTableOffset !== null 
            ? `found at 0x${result.partitionTableOffset.toString(16).toUpperCase()}`
            : '';
        printStatus('Partition Table', result.partitionTableOffset !== null, ptDetail);
        
        const otaDetail = result.bootPartition 
            ? `boot partition: ${result.bootPartition}`
            : '';
        printStatus('OTA Data', result.otadata, otaDetail);
        
        let bootPartDetail = result.bootPartition 
            ? `${result.bootPartition} has valid image` + (result.bootPartitionValid ? ' + SHA256' : '')
            : '';
        if (result.appProjectName || result.appVersion) {
            const appInfo = [];
            if (result.appProjectName) appInfo.push(result.appProjectName);
            if (result.appVersion) appInfo.push(`v${result.appVersion}`);
            bootPartDetail += ` (${appInfo.join(' ')})`;
        }
        printStatus('Boot Partition', result.bootPartitionValid, bootPartDetail);
        
        if (result.nvs !== undefined) {
            printStatus('NVS', result.nvs, result.nvs ? 'valid entries found' : 'no valid entries');
        }
        
        // Overall status
        console.log('\n' + '─'.repeat(60));
        const overallIcon = result.allValid ? '✓' : result.success ? '⚠' : '✗';
        const overallColor = result.allValid ? '\x1b[32m' : result.success ? '\x1b[33m' : '\x1b[31m';
        const overallText = result.allValid ? 'ALL VALID' : result.success ? 'PARTIAL' : 'INVALID';
        console.log(`${overallColor}${overallIcon} Overall Status: ${overallText}\x1b[0m`);
        
        if (result.success && !result.allValid) {
            console.log('\nNote: Basic structure is valid, but some validation checks failed.');
            console.log('      The firmware may work but could have integrity issues.');
        }
        
        
        console.log(''); // Empty line at end
        
        // Exit code: 0 for all valid, 1 for partial, 2 for invalid
        process.exit(result.allValid ? 0 : result.success ? 1 : 2);
        
    } catch (error) {
        console.error(`\n✗ Error: ${error.message}`);
        if (process.env.DEBUG) {
            console.error(error.stack);
        }
        process.exit(2);
    }
}

// Command line handling
if (require.main === module) {
    const args = process.argv.slice(2);
    
    if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
        console.log(`
ESP32 Firmware Validator

Usage:
  node example-validate-image.js <firmware.bin>
  
Options:
  --help, -h    Show this help message
  
Environment:
  DEBUG=1       Show detailed error stack traces
  
Exit codes:
  0   All validation checks passed
  1   Basic structure valid but some checks failed
  2   Invalid firmware or error
  
Examples:
  node example-validate-image.js firmware.bin
  node example-validate-image.js esp32_dump.bin
  DEBUG=1 node example-validate-image.js firmware.bin
        `);
        process.exit(0);
    }
    
    const filePath = args[0];
    
    if (!fs.existsSync(filePath)) {
        console.error(`Error: File not found: ${filePath}`);
        process.exit(2);
    }
    
    validateFirmware(filePath);
}

module.exports = { validateFirmware };
