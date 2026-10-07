const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const updater = require('../apps/desktop/updater');

function fakes({ isPackaged = true, responses = [] } = {}) {
    const calls = { dialogs: [], opened: [], installs: [], checks: 0 };
    const autoUpdater = new EventEmitter();
    autoUpdater.checkForUpdates = async () => {
        calls.checks += 1;
        return null;
    };
    autoUpdater.quitAndInstall = (...args) => calls.installs.push(args);
    const electronModule = {
        app: { isPackaged, getVersion: () => '1.0.3' },
        dialog: {
            showMessageBox: async options => {
                calls.dialogs.push(options);
                return { response: responses.shift() ?? 1 };
            },
        },
        shell: { openExternal: async url => calls.opened.push(url) },
    };
    return { autoUpdater, electronModule, calls };
}

const settle = () => new Promise(resolve => setImmediate(resolve));

test.afterEach(() => updater.stop());

test('development builds never start the updater', () => {
    const { autoUpdater, electronModule } = fakes({ isPackaged: false });
    assert.equal(updater.start({ electronModule, autoUpdater, platform: 'darwin' }), false);
    assert.equal(autoUpdater.listenerCount('update-available'), 0);
});

test('macOS checks without downloading and sends the user to the new DMG', async () => {
    const { autoUpdater, electronModule, calls } = fakes({ responses: [0] });
    assert.equal(updater.start({ electronModule, autoUpdater, platform: 'darwin' }), true);
    assert.equal(autoUpdater.autoDownload, false);
    assert.equal(autoUpdater.autoInstallOnAppQuit, false);

    autoUpdater.emit('update-available', { version: '1.0.4', files: [{ url: 'Kesami-1.0.4-arm64-mac.zip' }, { url: 'Kesami-1.0.4-arm64.dmg' }] });
    await settle();

    assert.equal(calls.dialogs.length, 1);
    assert.match(calls.dialogs[0].message, /1\.0\.4/);
    assert.deepEqual(calls.opened, ['https://github.com/xenxorowdy/kesami-releases/releases/download/v1.0.4/Kesami-1.0.4-arm64.dmg']);
    assert.deepEqual(calls.installs, []);
});

test('macOS asks once per version on background checks', async () => {
    const { autoUpdater, electronModule, calls } = fakes();
    updater.start({ electronModule, autoUpdater, platform: 'darwin' });

    autoUpdater.emit('update-available', { version: '1.0.4', files: [] });
    await settle();
    autoUpdater.emit('update-available', { version: '1.0.4', files: [] });
    await settle();

    assert.equal(calls.dialogs.length, 1);
    assert.deepEqual(calls.opened, []);
});

test('Windows downloads in the background and installs on restart', async () => {
    const { autoUpdater, electronModule, calls } = fakes({ responses: [0] });
    updater.start({ electronModule, autoUpdater, platform: 'win32' });
    assert.equal(autoUpdater.autoDownload, true);
    assert.equal(autoUpdater.autoInstallOnAppQuit, true);

    autoUpdater.emit('update-available', { version: '1.0.4' });
    await settle();
    assert.equal(calls.dialogs.length, 0);

    autoUpdater.emit('update-downloaded', { version: '1.0.4' });
    await settle();
    assert.equal(calls.dialogs.length, 1);
    assert.deepEqual(calls.installs, [[true, true]]);
});

test('a manual check reports when Kesami is already current', async () => {
    const { autoUpdater, electronModule, calls } = fakes();
    updater.start({ electronModule, autoUpdater, platform: 'darwin' });

    await updater.checkNow();
    assert.equal(calls.checks, 1);
    autoUpdater.emit('update-not-available', { version: '1.0.3' });
    await settle();

    assert.equal(calls.dialogs.length, 1);
    assert.match(calls.dialogs[0].message, /up to date/);
});

test('background check failures stay silent but manual ones are reported', async () => {
    const { autoUpdater, electronModule, calls } = fakes();
    updater.start({ electronModule, autoUpdater, platform: 'win32' });
    const originalError = console.error;
    console.error = () => {};
    try {
        autoUpdater.emit('error', new Error('offline'));
        await settle();
        assert.equal(calls.dialogs.length, 0);

        await updater.checkNow();
        autoUpdater.emit('error', new Error('offline'));
        await settle();
        assert.equal(calls.dialogs.length, 1);
        assert.match(calls.dialogs[0].message, /Could not check/);
    } finally {
        console.error = originalError;
    }
});

test('the download link falls back to the release page without a DMG', () => {
    const { downloadUrl, RELEASES_URL } = updater._testing;
    assert.equal(downloadUrl({ version: '1.0.4', files: [{ url: 'Kesami-1.0.4-arm64-mac.zip' }] }), `${RELEASES_URL}/tag/v1.0.4`);
    assert.equal(downloadUrl(null), RELEASES_URL);
});
