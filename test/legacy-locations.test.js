const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const legacy = require('../apps/desktop/legacy.js');

function fakeApp(root) {
    const dirs = {
        appData: path.join(root, 'Application Support'),
        userData: path.join(root, 'Application Support', 'Kesami'),
        documents: path.join(root, 'Documents'),
    };
    return { getPath: name => dirs[name], dirs };
}

function scratch() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'kesami-legacy-'));
}

test('env prefers KESAMI_ and falls back to ALPHA_', () => {
    assert.equal(legacy.env('PORT', { ALPHA_PORT: '1' }), '1');
    assert.equal(legacy.env('PORT', { ALPHA_PORT: '1', KESAMI_PORT: '2' }), '2');
    assert.equal(legacy.env('PORT', { KESAMI_PORT: '', ALPHA_PORT: '3' }), '3');
    assert.equal(legacy.env('PORT', {}), undefined);
});

test('app data, backend data and the meeting library move to their Kesami names', () => {
    const root = scratch();
    const app = fakeApp(root);
    const oldUserData = path.join(app.dirs.appData, '@alpha', 'meeting-desktop');
    fs.mkdirSync(path.join(oldUserData, '.alpha-meeting-assistant'), { recursive: true });
    fs.writeFileSync(path.join(oldUserData, '.alpha-meeting-assistant', 'settings.json'), '{}');
    fs.mkdirSync(path.join(app.dirs.documents, 'Alpha Meetings', 'Launch sync'), { recursive: true });

    const moved = legacy.adoptLegacyLocations(app, { log: () => {}, source: {} });

    assert.deepEqual(moved, ['app data', 'backend data', 'meeting library']);
    assert.ok(fs.existsSync(path.join(app.dirs.userData, '.kesami', 'settings.json')));
    assert.ok(!fs.existsSync(oldUserData));
    assert.ok(fs.existsSync(path.join(app.dirs.documents, 'Kesami Meetings', 'Launch sync')));
    assert.ok(!fs.existsSync(path.join(app.dirs.documents, 'Alpha Meetings')));
    assert.deepEqual(legacy.adoptLegacyLocations(app, { log: () => {}, source: {} }), []);
    fs.rmSync(root, { recursive: true, force: true });
});

test('nothing is moved over existing Kesami folders or an explicit library path', () => {
    const root = scratch();
    const app = fakeApp(root);
    fs.mkdirSync(path.join(app.dirs.appData, '@alpha', 'meeting-desktop'), { recursive: true });
    fs.mkdirSync(app.dirs.userData, { recursive: true });
    fs.mkdirSync(path.join(app.dirs.documents, 'Alpha Meetings'), { recursive: true });

    const moved = legacy.adoptLegacyLocations(app, { log: () => {}, source: { ALPHA_LIBRARY_DIR: '/elsewhere' } });

    assert.deepEqual(moved, []);
    assert.ok(fs.existsSync(path.join(app.dirs.appData, '@alpha', 'meeting-desktop')));
    assert.ok(fs.existsSync(path.join(app.dirs.documents, 'Alpha Meetings')));
    fs.rmSync(root, { recursive: true, force: true });
});
