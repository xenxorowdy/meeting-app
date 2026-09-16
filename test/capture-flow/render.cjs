// Run from the workspace root:
// node_modules/.bin/electron test/capture-flow/render.cjs
// All capture devices and backend calls are mocked; no microphone, network or
// existing Electron profile is used. Production React hooks run in Chromium.
const { app, BrowserWindow } = require('electron');
const { build } = require('esbuild');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');

async function run() {
    const output = await fs.mkdtemp(path.join(os.tmpdir(), 'alpha-capture-flow-'));
    app.setPath('userData', path.join(output, 'profile'));
    const mocks = path.join(__dirname, 'mocks.js');
    await build({
        entryPoints: [path.join(__dirname, 'fixture.jsx')],
        bundle: true,
        outfile: path.join(output, 'fixture.js'),
        format: 'iife',
        alias: {
            '@/lib/backend': mocks,
            '@/lib/connection': mocks,
            '@/lib/micCapture': mocks,
            '@/lib/systemCapture': mocks,
            '@/lib/screenRecorder': mocks,
            '@': path.resolve(__dirname, '../../apps/ui/src'),
        },
        define: { 'process.env.NODE_ENV': '"development"', 'import.meta.env': '{}' },
    });
    await fs.writeFile(path.join(output, 'index.html'), '<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'self\'; script-src \'self\'; connect-src \'none\'"></head><body><div id="root"></div><script src="fixture.js"></script></body></html>');
    await app.whenReady();
    const window = new BrowserWindow({
        show: false,
        webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
    });
    const errors = [];
    window.webContents.on('console-message', (_, level, message) => {
        if (level === 3) errors.push(message);
    });
    window.webContents.session.setPermissionRequestHandler((_, __, callback) => callback(false));
    window.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (_, done) => done({ cancel: true }));
    await window.loadFile(path.join(output, 'index.html'));
    const results = await window.webContents.executeJavaScript('window.runCaptureTests()');
    for (const result of results) {
        console.log(`${result.passed ? 'PASS' : 'FAIL'} ${result.name}`);
        if (!result.passed) console.error(result.error);
    }
    assert.deepEqual(errors, [], 'Renderer has no unexpected errors');
    assert(results.every(result => result.passed), 'All capture flow scenarios pass');
    console.log(`${results.length} capture flow scenarios passed.`);
    window.destroy();
}

const timeout = setTimeout(() => {
    console.error('Capture flow integration timed out.');
    app.exit(1);
}, 30_000);
run().then(() => { clearTimeout(timeout); app.exit(0); }).catch(cause => {
    console.error(cause);
    clearTimeout(timeout);
    app.exit(1);
});
