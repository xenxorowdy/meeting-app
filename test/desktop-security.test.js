const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { secureWindow, permissionAllowed, trustedIpc } = require('../apps/desktop/rendererSecurity');

function windowFor(url, role = 'main', openExternal) {
    const contents = new EventEmitter();
    contents.mainFrame = { url };
    contents.isDestroyed = () => false;
    contents.setWindowOpenHandler = handler => { contents.openWindow = handler; };
    secureWindow({ webContents: contents }, { url, role, openExternal });
    return contents;
}

test('native privileges require the registered top frame and its exact application document', () => {
    const handlers = new Map();
    const ipc = trustedIpc({ handle: (channel, handler) => handlers.set(channel, handler), on: (channel, handler) => handlers.set(channel, handler) });
    ipc.handle('recorder:start', () => 'started');
    ipc.handle('widget:command', () => 'command');
    ipc.on('connection:get', event => { event.returnValue = 'secret'; });
    const main = windowFor('file:///Applications/Kesami.app/Contents/Resources/ui/index.html');
    const widget = windowFor('file:///Applications/Kesami.app/Contents/Resources/ui/widget.html', 'widget');
    const event = { sender: main, senderFrame: main.mainFrame };
    assert.equal(handlers.get('recorder:start')(event), 'started');
    handlers.get('connection:get')(event);
    assert.equal(event.returnValue, 'secret');
    assert.equal(handlers.get('widget:command')({ sender: widget, senderFrame: widget.mainFrame }), 'command');
    for (const impostor of [
        { sender: widget, senderFrame: widget.mainFrame },
        { sender: main, senderFrame: { url: main.mainFrame.url } },
        { sender: windowFor('https://evil.example'), senderFrame: main.mainFrame },
    ]) {
        assert.throws(() => handlers.get('recorder:start')(impostor), /Untrusted/);
        handlers.get('connection:get')(impostor);
        assert.equal(impostor.returnValue, null);
    }
    main.mainFrame.url = 'file:///tmp/downloaded.html';
    assert.throws(() => handlers.get('recorder:start')(event), /Untrusted/);
});

test('both windows deny remote navigation, new native windows, and embedded webviews', async () => {
    const opened = [];
    const main = windowFor('http://localhost:5173/', 'main', value => opened.push(value));
    for (const target of ['https://evil.example/', 'file:///tmp/app.html', 'http://localhost:5173.evil.example/', 'http://localhost:5173/other']) {
        for (const name of ['will-navigate', 'will-redirect']) {
            let denied = false;
            main.emit(name, { preventDefault() { denied = true; } }, target);
            assert.equal(denied, true);
        }
    }
    let denied = false;
    main.emit('will-navigate', { preventDefault() { denied = true; } }, 'http://localhost:5173/#library');
    assert.equal(denied, false);
    main.emit('will-attach-webview', { preventDefault() { denied = true; } });
    assert.equal(denied, true);
    for (const url of ['file:///tmp/executable', 'javascript:alert(1)', 'smb://server/share', 'https://user:password@example.com', 'https://example.com/meeting']) {
        assert.deepEqual(main.openWindow({ url }), { action: 'deny' });
    }
    const widget = windowFor('file:///ui/widget.html', 'widget', value => opened.push(value));
    widget.openWindow({ url: 'https://example.com/widget' });
    await Promise.resolve();
    assert.deepEqual(opened, ['https://example.com/meeting']);
});

test('capture and notifications are restricted to the trusted main document', () => {
    const main = windowFor('file:///ui/index.html');
    const widget = windowFor('file:///ui/widget.html', 'widget');
    assert.equal(permissionAllowed(main, 'media', { requestingUrl: 'file:///ui/index.html', isMainFrame: true }), true);
    assert.equal(permissionAllowed(main, 'audioCapture', { securityOrigin: 'file://' }), true);
    assert.equal(permissionAllowed(main, 'notifications'), true);
    assert.equal(permissionAllowed(main, 'geolocation'), false);
    assert.equal(permissionAllowed(main, 'media', { requestingUrl: 'https://evil.example' }), false);
    assert.equal(permissionAllowed(main, 'media', { requestingUrl: 'file:///ui/index.html', isMainFrame: false }), false);
    assert.equal(permissionAllowed(widget, 'media'), false);
    assert.equal(permissionAllowed(null, 'media'), false);
    main.mainFrame.url = 'https://evil.example';
    assert.equal(permissionAllowed(main, 'media'), false);
});
