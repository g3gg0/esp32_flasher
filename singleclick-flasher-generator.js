#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

function usage() {
    const script = path.basename(process.argv[1] || 'singleclick-flasher-generator.js');
    console.error('Single Click Flasher Generator');
    console.error('==============================');
    console.error('');
    console.error(`Usage:`);
    console.error(`  node ${script} <flasher_args> <html> <title> [<subtitle>]`);
    console.error('');
    console.error('Arguments:');
    console.error('  <flasher_args> Path to ESP-IDF flasher_args.json');
    console.error('  <html>         Path to generated standalone HTML flasher');
    console.error('  <title>        Main product/device name shown in header and dialogs');
    console.error('  [<subtitle>]   Optional subtitle line shown under the header title');
    console.error('');
    console.error('Examples:');
    console.error(`  node ${script} ./build/flasher_args.json ./singleclick-flasher.html "My special firmware"`);
    console.error(`  node ${script} ./build/flasher_args.json ./dist/mes-flasher.html "My special firmware" "Version 1.2.3"`);
    console.error('');
    console.error('Notes:');
    console.error('  - Binary files referenced by flash_files are resolved relative to <infile>.');
    console.error('  - The output HTML inlines chips.js and flasher.js plus base64 payloads.');
    console.error('  - Chip verification uses extra_esptool_args.chip when provided.');
}

function fail(message) {
    console.error(`Error: ${message}`);
    process.exit(1);
}

function readText(filePath) {
    try {
        return fs.readFileSync(filePath, 'utf8');
    } catch (error) {
        fail(`Could not read ${filePath}: ${error.message}`);
    }
}

function readBinary(filePath) {
    try {
        return fs.readFileSync(filePath);
    } catch (error) {
        fail(`Could not read ${filePath}: ${error.message}`);
    }
}

function parseAddress(value) {
    if (typeof value === 'number') {
        return value;
    }
    if (typeof value !== 'string') {
        fail(`Invalid flash address: ${value}`);
    }
    const trimmed = value.trim();
    const parsed = trimmed.toLowerCase().startsWith('0x')
        ? parseInt(trimmed, 16)
        : parseInt(trimmed, 10);
    if (!Number.isFinite(parsed)) {
        fail(`Invalid flash address: ${value}`);
    }
    return parsed;
}

function htmlEscape(value) {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function jsString(value) {
    return JSON.stringify(String(value));
}

function findPartitionName(args, address, fileName) {
    const normalizedFile = path.normalize(fileName);
    const ignored = new Set(['write_flash_args', 'flash_settings', 'flash_files', 'extra_esptool_args']);

    for (const [key, value] of Object.entries(args)) {
        if (ignored.has(key) || !value || typeof value !== 'object' || Array.isArray(value)) {
            continue;
        }

        const sameFile = typeof value.file === 'string' && path.normalize(value.file) === normalizedFile;
        const sameOffset = value.offset !== undefined && parseAddress(value.offset) === address;
        if (sameFile || sameOffset) {
            return key;
        }
    }

    const base = path.basename(fileName, path.extname(fileName));
    return base || `partition_0x${address.toString(16)}`;
}

function collectFlashFiles(args, argsDir) {
    if (!args.flash_files || typeof args.flash_files !== 'object' || Array.isArray(args.flash_files)) {
        fail('flasher args JSON does not contain a flash_files object.');
    }

    const partitions = Object.entries(args.flash_files)
        .map(([addressText, relativeFile]) => {
            if (typeof relativeFile !== 'string') {
                fail(`Invalid file path for flash address ${addressText}`);
            }

            const address = parseAddress(addressText);
            const absoluteFile = path.resolve(argsDir, relativeFile);
            const data = readBinary(absoluteFile);
            const name = findPartitionName(args, address, relativeFile);

            return {
                address,
                addressHex: `0x${address.toString(16).toUpperCase()}`,
                name,
                file: relativeFile,
                size: data.length,
                base64: data.toString('base64')
            };
        })
        .sort((a, b) => a.address - b.address);

    if (!partitions.length) {
        fail('No flash files found in flash_files.');
    }

    return partitions;
}

function buildHtml({ title, subtitle, expectedChip, partitions, chipsJs, flasherJs }) {
    const payload = {
        title,
        subtitle: subtitle || '',
        expectedChip: expectedChip || null,
        generatedAt: new Date().toISOString(),
        partitions
    };

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${htmlEscape(title)} Flasher</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
            color: #d7e2ea;
        }

        body {
            min-height: 100vh;
            padding: 18px;
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            background:
                radial-gradient(circle at top left, rgba(28, 160, 180, 0.18), transparent 34%),
                linear-gradient(135deg, #071017 0%, #0d141c 100%);
        }

        .container {
            max-width: 760px;
            margin: 0 auto;
            overflow: hidden;
            border-radius: 6px;
            border: 1px solid #263845;
            background: rgba(12, 19, 27, 0.96);
            box-shadow: 0 18px 50px rgba(0, 0, 0, 0.45);
        }

        .header {
            padding: 22px 24px;
            text-align: center;
            background: linear-gradient(180deg, #101c27 0%, #0b141d 100%);
            border-bottom: 1px solid #213341;
        }

        .header h1 {
            margin-bottom: 6px;
            font-size: 2.1em;
            letter-spacing: 0.03em;
            color: #e8f7ff;
        }

        .header p {
            color: #7da4b5;
            font-size: 0.95em;
            letter-spacing: 0.08em;
            text-transform: uppercase;
        }

        .content {
            padding: 24px;
            text-align: center;
        }

        #flashBtn {
            width: min(100%, 260px);
            padding: 13px 22px;
            border: 1px solid #2ed7a3;
            border-radius: 4px;
            color: #04110d;
            font-size: 16px;
            font-weight: 700;
            letter-spacing: 0.08em;
            text-transform: uppercase;
            cursor: pointer;
            background: linear-gradient(135deg, #4dffd1 0%, #1fb879 100%);
            box-shadow: 0 0 22px rgba(46, 215, 163, 0.22);
        }

        #flashBtn:disabled {
            cursor: not-allowed;
            opacity: 0.6;
            box-shadow: none;
        }

        .hint {
            margin-top: 12px;
            color: #7892a0;
            font-size: 12px;
        }

        .popup-overlay {
            display: none;
            position: fixed;
            inset: 0;
            z-index: 1000;
            align-items: center;
            justify-content: center;
            padding: 16px;
            background: rgba(0, 0, 0, 0.78);
        }

        .popup {
            width: min(100%, 680px);
            max-height: calc(100vh - 32px);
            overflow-y: auto;
            border-radius: 6px;
            border: 1px solid #263845;
            background: #0b121a;
            box-shadow: 0 18px 54px rgba(0, 0, 0, 0.7);
        }

        .popup-header {
            padding: 12px 14px;
            background: #101b25;
            border-bottom: 1px solid #253744;
            text-align: left;
        }

        .popup-header h2 {
            font-size: 1em;
            letter-spacing: 0.06em;
            text-transform: uppercase;
        }

        .popup-body {
            padding: 12px;
        }

        .progress-module {
            padding: 10px;
            border-radius: 4px;
            border: 1px solid #233541;
            background: #0f1821;
        }

        .partition-slot {
            height: 32px;
            margin-bottom: 8px;
            overflow: hidden;
            border-radius: 3px;
            border: 1px solid #243846;
            background: #071017;
        }

        .partition-track {
            transform: translateY(0);
            transition: transform 0.28s cubic-bezier(0.2, 0.8, 0.2, 1);
        }

        .partition-item {
            height: 32px;
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 10px;
            padding: 0 10px;
            font-size: 13px;
        }

        .partition-item.done {
            color: #58d8c4;
        }

        .partition-name {
            font-weight: 700;
            color: #58d8c4;
        }

        .partition-meta {
            color: #aeb7c7;
            font-family: 'Courier New', monospace;
            font-size: 12px;
        }

        .bar {
            height: 16px;
            overflow: hidden;
            border-radius: 3px;
            border: 1px solid #243846;
            background: #071017;
        }

        .bar-fill {
            width: 0%;
            height: 100%;
            display: flex;
            align-items: center;
            justify-content: center;
            color: #fff;
            font-size: 10px;
            font-weight: 700;
            background: linear-gradient(90deg, #0aa784 0%, #37d6f2 100%);
            transition: width 0.12s linear;
        }

        .log {
            display: none;
            margin-top: 12px;
            padding: 10px;
            max-height: 180px;
            overflow-y: auto;
            border-radius: 4px;
            border: 1px solid #3f3322;
            background: #120f0a;
            color: #c9d1d9;
            font-family: 'Courier New', monospace;
            font-size: 12px;
            text-align: left;
            white-space: pre-wrap;
        }

        .log.visible {
            display: block;
        }

        .wrong-device-overlay {
            display: none;
            position: fixed;
            inset: 0;
            z-index: 2000;
            align-items: center;
            justify-content: center;
            padding: 18px;
            background: rgba(0, 0, 0, 0.78);
        }

        .wrong-device-box {
            width: min(100%, 520px);
            padding: 24px;
            border-radius: 6px;
            border: 1px solid #ff5f5f;
            background: linear-gradient(180deg, #3a0d0d 0%, #190808 100%);
            box-shadow: 0 18px 58px rgba(255, 0, 0, 0.28);
            text-align: center;
        }

        .wrong-device-main {
            color: #fff2f2;
            font-size: 1.7em;
            font-weight: 800;
            letter-spacing: 0.02em;
            line-height: 1.2;
        }

        .wrong-device-sub {
            margin-top: 12px;
            color: #ffb8b8;
            font-size: 1em;
            font-family: 'Courier New', monospace;
        }

        @media (max-width: 768px) {
            body {
                padding: 6px;
            }

            .header {
                padding: 12px;
            }

            .header h1 {
                margin-bottom: 4px;
                font-size: 1.3em;
            }

            .header p {
                font-size: 0.8em;
            }

            .content {
                padding: 16px;
            }

            .partition-item {
                font-size: 12px;
            }
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>${htmlEscape(title)} Flasher</h1>
            <p>${htmlEscape(subtitle)}</p>
        </div>
        <div class="content">
            <button id="flashBtn" type="button" onclick="flashFirmware()">Flash</button>
        </div>
    </div>

    <div class="popup-overlay" id="progressPopup">
        <div class="popup">
            <div class="popup-header">
                <h2>Flashing ${htmlEscape(title)}</h2>
            </div>
            <div class="popup-body">
                <div id="partitionProgress"></div>
                <div class="log" id="log"></div>
            </div>
        </div>
    </div>

    <div class="wrong-device-overlay" id="wrongDevicePopup">
        <div class="wrong-device-box">
            <div class="wrong-device-main" id="wrongDeviceMain"></div>
            <div class="wrong-device-sub" id="wrongDeviceSub"></div>
        </div>
    </div>

    <script>
/* Inlined from chips.js */
${chipsJs}
    </script>
    <script>
/* Inlined from flasher.js */
${flasherJs}
    </script>
    <script>
        const FLASH_PAYLOAD = ${JSON.stringify(payload)};
        let flasher = null;

        function isAndroidMode() {
            return /Android/i.test(navigator.userAgent);
        }

        function base64ToBytes(base64) {
            const binary = atob(base64);
            const bytes = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i++) {
                bytes[i] = binary.charCodeAt(i);
            }
            return bytes;
        }

        function formatBytes(size) {
            if (size < 1024) {
                return size + ' B';
            }
            if (size < 1024 * 1024) {
                return (size / 1024).toFixed(1) + ' KiB';
            }
            return (size / 1024 / 1024).toFixed(2) + ' MiB';
        }

        function setStatus(message) {
            document.title = FLASH_PAYLOAD.title + ' Flasher - ' + message;
        }

        function showDiagnosticLog() {
            document.getElementById('log').classList.add('visible');
        }

        function showWrongDevicePopup(expected, actual) {
            document.getElementById('wrongDeviceMain').textContent = 'This is not an ' + expected + '.';
            document.getElementById('wrongDeviceSub').textContent = 'This was detected as ' + actual + '.';
            document.getElementById('wrongDevicePopup').style.display = 'flex';
        }

        function log(message, reveal = false) {
            const logEl = document.getElementById('log');
            const timestamp = new Date().toLocaleTimeString();
            logEl.textContent += '[' + timestamp + '] ' + message + '\\n';
            logEl.scrollTop = logEl.scrollHeight;
            if (reveal) {
                showDiagnosticLog();
            }
            setStatus(message);
        }

        function renderProgressRows() {
            const container = document.getElementById('partitionProgress');
            container.innerHTML =
                '<div class="progress-module">' +
                    '<div class="partition-slot">' +
                        '<div class="partition-track" id="partitionTrack">' +
                            FLASH_PAYLOAD.partitions.map((part, index) =>
                                '<div class="partition-item" id="partition-item-' + index + '">' +
                                    '<span><span class="partition-name">' + part.name + '</span> <span class="partition-meta">' + part.addressHex + '</span></span>' +
                                    '<span class="partition-meta">' + formatBytes(part.size) + '</span>' +
                                '</div>'
                            ).join('') +
                            '<div class="partition-item done" id="partition-item-done">' +
                                '<span><span class="partition-name">Flashing Done.</span></span>' +
                                '<span class="partition-meta">100%</span>' +
                            '</div>' +
                        '</div>' +
                    '</div>' +
                    '<div class="bar"><div class="bar-fill" id="flashBar">0%</div></div>' +
                '</div>';
        }

        function showFlashingDone() {
            const bar = document.getElementById('flashBar');
            const track = document.getElementById('partitionTrack');
            if (track) {
                track.style.transform = 'translateY(' + (-FLASH_PAYLOAD.partitions.length * 32) + 'px)';
            }
            FLASH_PAYLOAD.partitions.forEach((part, itemIndex) => {
                const item = document.getElementById('partition-item-' + itemIndex);
                if (item) {
                    item.classList.add('done');
                }
            });
            if (bar) {
                bar.style.width = '100%';
                bar.textContent = 'Flashing Done.';
            }
            setStatus('Flashing Done.');
        }

        function updatePartitionProgress(index, written, total, stage) {
            const bar = document.getElementById('flashBar');
            const track = document.getElementById('partitionTrack');
            if (!bar) {
                return;
            }
            if (track) {
                track.style.transform = 'translateY(' + (-index * 32) + 'px)';
            }
            FLASH_PAYLOAD.partitions.forEach((part, itemIndex) => {
                const item = document.getElementById('partition-item-' + itemIndex);
                if (item) {
                    item.classList.toggle('done', itemIndex < index || (itemIndex === index && written >= total));
                }
            });
            const percent = total > 0 ? Math.min(100, Math.round((written / total) * 100)) : 0;
            bar.style.width = percent + '%';
            bar.textContent = stage ? percent + '% ' + stage : percent + '%';
        }

        async function openFlasherPort() {
            flasher = new ESPFlasher({
                logMessage: (msg) => log(msg),
                logWarning: (msg) => log('WARNING: ' + msg, true),
                logError: (msg) => log('ERROR: ' + msg, true),
                logDebug: () => { },
            });

            if (isAndroidMode()) {
                log('Android detected: using WebUSB.');
                const port = await WebUSBSerial.requestPort();
                await flasher.openPortWithPort(port);
            } else {
                log('Using Web Serial.');
                await flasher.openPort();
            }
        }

        async function syncBootloader() {
            const baudCandidates = [flasher.initialBaudRate, 250000, 115200];
            let lastError = null;

            for (const baud of baudCandidates) {
                try {
                    if (baud && baud !== flasher.initialBaudRate) {
                        log('Retrying at ' + baud + ' baud...');
                        await flasher.reopenPort(baud);
                    }
                    log('Entering bootloader mode...');
                    await flasher.hardReset(true);
                    log('Syncing bootloader...');
                    await flasher.sync();
                    return;
                } catch (error) {
                    lastError = error;
                    log('Sync failed' + (baud ? ' at ' + baud + ' baud' : '') + ': ' + error.message, true);
                }
            }

            throw lastError || new Error('Failed to sync bootloader.');
        }

        async function verifyChipType() {
            const expectedChip = FLASH_PAYLOAD.expectedChip;
            if (!expectedChip) {
                log('No expected chip configured; skipping chip check.');
                return;
            }

            const actualChip = flasher.current_chip;
            log('Detected chip: ' + actualChip + ', expected: ' + expectedChip);
            if (String(actualChip).toLowerCase() !== String(expectedChip).toLowerCase()) {
                showWrongDevicePopup(expectedChip, actualChip || 'unknown');
                const mismatchError = new Error('Chip mismatch: detected ' + actualChip + ', expected ' + expectedChip);
                mismatchError.suppressLog = true;
                throw mismatchError;
            }
        }

        async function flashFirmware() {
            const button = document.getElementById('flashBtn');
            button.disabled = true;
            document.getElementById('progressPopup').style.display = 'flex';
            const logEl = document.getElementById('log');
            logEl.textContent = '';
            logEl.classList.remove('visible');
            renderProgressRows();
            let detectionTimer = null;

            try {
                detectionTimer = setTimeout(() => {
                    log('Device detection is taking longer than expected. Showing diagnostics...', true);
                }, 8000);
                await openFlasherPort();
                await syncBootloader();
                await verifyChipType();
                if (detectionTimer) {
                    clearTimeout(detectionTimer);
                    detectionTimer = null;
                }

                log('Loading stub loader...');
                const stubLoaded = await flasher.downloadStub();
                if (!stubLoaded) {
                    throw new Error('Failed to load stub loader.');
                }

                for (let index = 0; index < FLASH_PAYLOAD.partitions.length; index++) {
                    const part = FLASH_PAYLOAD.partitions[index];
                    const data = base64ToBytes(part.base64);
                    log('Flashing ' + part.name + ' at ' + part.addressHex + ' (' + formatBytes(data.length) + ')...');
                    await flasher.writeFlash(part.address, data, (written, total, stage) => {
                        updatePartitionProgress(index, written, total, '');
                    });
                    updatePartitionProgress(index, data.length, data.length, '');
                    log('Finished ' + part.name + '.');
                }

                showFlashingDone();
                log('Flashing Done. Resetting into application...');
                await flasher.hardReset(false);
                setStatus('Flash complete.');
            } catch (error) {
                if (detectionTimer) {
                    clearTimeout(detectionTimer);
                }
                if (!error.suppressLog) {
                    log('FAILED: ' + error.message, true);
                }
                setStatus('Failed: ' + error.message);
            } finally {
                if (flasher) {
                    try {
                        log('Disconnecting device...');
                        await flasher.disconnect();
                    } catch (error) {
                    }
                }
                button.disabled = false;
            }
        }
    </script>
</body>
</html>
`;
}

function main() {
    if (process.argv.includes('-h') || process.argv.includes('--help')) {
        usage();
        process.exit(0);
    }

    const [, , argsPathArg, outputPathArg, titleArg, subtitleArg = ''] = process.argv;
    if (!argsPathArg || !outputPathArg || !titleArg) {
        usage();
        process.exit(1);
    }

    const argsPath = path.resolve(argsPathArg);
    const argsDir = path.dirname(argsPath);
    const outputPath = path.resolve(outputPathArg);
    const args = JSON.parse(readText(argsPath));
    const partitions = collectFlashFiles(args, argsDir);
    const expectedChip = args.extra_esptool_args && args.extra_esptool_args.chip
        ? String(args.extra_esptool_args.chip)
        : null;

    const projectDir = __dirname;
    const chipsJs = readText(path.join(projectDir, 'chips.js'));
    const flasherJs = readText(path.join(projectDir, 'flasher.js'));
    const html = buildHtml({
        title: titleArg,
        subtitle: subtitleArg,
        expectedChip,
        partitions,
        chipsJs,
        flasherJs
    });

    fs.writeFileSync(outputPath, html, 'utf8');
    console.log(`Created ${outputPath}`);
    console.log(`Embedded ${partitions.length} flash file(s):`);
    for (const part of partitions) {
        console.log(`  ${part.addressHex} ${part.name} ${part.file} (${part.size} bytes)`);
    }
    if (expectedChip) {
        console.log(`Expected chip: ${expectedChip}`);
    }
}

main();
