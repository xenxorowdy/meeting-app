const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const { showDockIcon, _testing } = require('../apps/desktop/dock');

test('the macOS shell restores Dock presence before applying the app icon', async () => {
    const calls = [];
    const icon = { isEmpty: () => false };
    const app = {
        dock: {
            async show() {
                calls.push('show');
            },
            setIcon(value) {
                calls.push(['setIcon', value]);
            },
        },
    };
    const nativeImage = {
        createFromPath(iconPath) {
            calls.push(['createFromPath', iconPath]);
            return icon;
        },
    };

    assert.equal(await showDockIcon({ app, nativeImage, platform: 'darwin' }), true);
    assert.deepEqual(calls, ['show', ['createFromPath', _testing.DEFAULT_ICON_PATH], ['setIcon', icon]]);
});

test('the checked-in Dock icon is present and non-empty', () => {
    assert.ok(fs.statSync(_testing.DEFAULT_ICON_PATH).size > 0);
});

test('non-macOS platforms do not access the Dock API', async () => {
    assert.equal(await showDockIcon({ app: {}, nativeImage: {}, platform: 'linux' }), false);
});
