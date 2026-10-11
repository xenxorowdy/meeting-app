const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { isAppReturn, registerAppReturn } = require('../apps/desktop/appReturn');

test('app return links only focus Kesami and never accept OAuth payloads or arbitrary routes', async () => {
    for (const value of ['kesami://open', 'kesami://open/']) assert.equal(isAppReturn(value), true);
    for (const value of ['https://example.com', 'kesami://open?code=secret', 'kesami://open#token', 'kesami://delete', 'kesami://user@open', null]) assert.equal(isAppReturn(value), false);
    const app = new EventEmitter();
    let release, focused = 0, prevented = 0, registration;
    const ready = new Promise(resolve => { release = resolve; });
    app.whenReady = () => ready;
    app.isPackaged = true;
    app.setAsDefaultProtocolClient = scheme => { registration = scheme; };
    registerAppReturn(app, () => { focused++; });
    assert.equal(registration, 'kesami');
    app.emit('open-url', { preventDefault: () => { prevented++; } }, 'kesami://open');
    assert.equal(focused, 0, 'wait for Electron readiness');
    release(); await ready; await Promise.resolve();
    assert.equal(focused, 1);
    assert.equal(prevented, 1);
    app.emit('open-url', { preventDefault: () => { prevented++; } }, 'kesami://open?code=forged');
    app.emit('second-instance', {}, ['app.exe', 'kesami://open']);
    await Promise.resolve();
    assert.equal(focused, 2);
    assert.equal(prevented, 1);
});
