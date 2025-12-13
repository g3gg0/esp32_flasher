#!/usr/bin/env node
/**
 * Build script to combine separate .js files into a single HTML file
 * Usage: node build.js
 */

const fs = require('fs');
const path = require('path');

// Configuration
const builds = [
    {
        template: 'esp32-viewer.html',
        output: 'dist/esp32-viewer-standalone.html',
        scripts: ['chips.js', 'flasher.js', 'esp32-parser.js']
    },
    {
        template: 'flasher.html',
        output: 'dist/flasher-standalone.html',
        scripts: ['chips.js', 'flasher.js']
    }
];

/**
 * Read a file and return its contents
 */
function readFile(filePath) {
    try {
        return fs.readFileSync(filePath, 'utf8');
    } catch (error) {
        console.error(`Error reading file ${filePath}:`, error.message);
        process.exit(1);
    }
}

/**
 * Write content to a file, creating directories if needed
 */
function writeFile(filePath, content) {
    try {
        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        fs.writeFileSync(filePath, content, 'utf8');
        console.log(`✓ Created: ${filePath}`);
    } catch (error) {
        console.error(`Error writing file ${filePath}:`, error.message);
        process.exit(1);
    }
}

/**
 * Inline JavaScript files into HTML template
 */
function inlineScripts(htmlContent, scripts) {
    let result = htmlContent;
    
    // Read all script files
    const scriptContents = scripts.map(scriptFile => {
        console.log(`  Reading: ${scriptFile}`);
        const content = readFile(scriptFile);
        return {
            file: scriptFile,
            content: content
        };
    });
    
    // Replace each script tag with inline version
    for (const script of scriptContents) {
        const srcPattern = new RegExp(
            `<script\\s+src=["']${script.file.replace(/\\/g, '/')}["'](?:\\s+[^>]*)?>\\s*<\\/script>`,
            'gi'
        );
        
        const inlineScript = `<script>\n/* Inlined from ${script.file} */\n${script.content}\n    </script>`;
        result = result.replace(srcPattern, inlineScript);
    }
    
    // Check if any script tags were not replaced (warning)
    const remainingScripts = result.match(/<script\s+src=["'][^"']+["']/gi);
    if (remainingScripts) {
        console.warn('  Warning: Some script tags were not inlined:');
        remainingScripts.forEach(tag => console.warn(`    ${tag}`));
    }
    
    return result;
}

/**
 * Build a single HTML file with inlined scripts
 */
function buildHtml(config) {
    console.log(`\nBuilding: ${config.output}`);
    console.log(`  Template: ${config.template}`);
    
    // Read template
    const templateContent = readFile(config.template);
    
    // Inline scripts
    const result = inlineScripts(templateContent, config.scripts);
    
    // Add build timestamp comment
    const timestamp = new Date().toISOString();
    const withTimestamp = result.replace(
        '</head>',
        `    <!-- Built: ${timestamp} -->\n</head>`
    );
    
    // Write output
    writeFile(config.output, withTimestamp);
    
    const originalSize = Buffer.byteLength(templateContent, 'utf8');
    const finalSize = Buffer.byteLength(withTimestamp, 'utf8');
    console.log(`  Size: ${(finalSize / 1024).toFixed(1)} KB (original: ${(originalSize / 1024).toFixed(1)} KB)`);
}

/**
 * Main build function
 */
function build() {
    console.log('ESP32 Flasher Build Tool');
    console.log('========================\n');
    
    const startTime = Date.now();
    
    // Build each configuration
    for (const config of builds) {
        buildHtml(config);
    }
    
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(`\n✓ Build completed in ${elapsed}s`);
}

// Run build
build();
