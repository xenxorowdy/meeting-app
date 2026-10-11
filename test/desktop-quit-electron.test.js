const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');
const electron = require('electron');

const APP = path.join(__dirname, 'desktop-quit', 'app.cjs');
const EXIT_WITHIN_MS = 6000;

function launch(t, windowState) {
    const child = spawn(electron, [APP], { env: { ...process.env, WINDOW_STATE: windowState }, stdio: ['ignore', 'pipe', 'pipe'] });
    t.after(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    });
    let output = '';
    const exited = new Promise(resolve => child.once('exit', () => resolve(true)));
    const ready = new Promise((resolve, reject) => {
        child.stdout.on('data', chunk => {
            output += chunk;
            if (output.includes('ready\n')) resolve();
        });
        child.once('exit', code => reject(new Error(`Electron exited before the window was ready (${code})`)));
    });
    return { child, ready, exited, output: () => output };
}

function quitFromDock(pid) {
    return new Promise((resolve, reject) => {
        const script = `ObjC.import('AppKit'); $.NSRunningApplication.runningApplicationWithProcessIdentifier(${pid}).terminate`;
        execFile('osascript', ['-l', 'JavaScript', '-e', script], error => (error ? reject(error) : resolve()));
    });
}

function within(promise, ms) {
    return Promise.race([promise, new Promise(resolve => setTimeout(() => resolve(false), ms))]);
}

const cases = [
    ['quitting from the Dock while the window is minimized', 'minimized', app => quitFromDock(app.child.pid)],
    ['quitting from the Dock while the app is hidden', 'app-hidden', app => quitFromDock(app.child.pid)],
    ['quitting from the Dock before the window was ever shown', 'never-shown', app => quitFromDock(app.child.pid)],
    ['a termination signal with the window open', 'visible', app => app.child.kill('SIGTERM')],
];

for (const [name, windowState, quit] of cases) {
    test(`${name} cleans up and ends the process`, { skip: process.platform !== 'darwin' && 'macOS quit paths' }, async t => {
        const app = launch(t, windowState);
        await app.ready;
        await quit(app);
        assert.equal(await within(app.exited, EXIT_WITHIN_MS), true, `still running ${EXIT_WITHIN_MS} ms after quitting`);
        assert.match(app.output(), /cleaned up/);
    });
}
