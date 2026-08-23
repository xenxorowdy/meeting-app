/**
 * The media scheme turns a URL from the page into a filesystem read, so its path
 * resolver is the boundary that keeps it from becoming an arbitrary-file reader.
 * These tests exercise that resolver and the meeting-directory sanitiser without
 * starting Electron.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');

// `recorder.js` requires `electron` for app.getPath at load time, so stub it.
const FAKE_USER_DATA = path.join('/tmp', 'alpha-recorder-test-userdata');
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
    if (request === 'electron') {
        return {
            app: { getPath: () => FAKE_USER_DATA },
            desktopCapturer: {},
            ipcMain: { handle() {} },
            net: {},
            protocol: { registerSchemesAsPrivileged() {}, handle() {} },
            session: { defaultSession: {} },
            systemPreferences: { getMediaAccessStatus: () => 'granted' },
        };
    }
    return originalLoad(request, parent, isMain);
};

const recorder = require('../apps/desktop/recorder');
Module._load = originalLoad;

const { resolveMedia, meetingDir } = recorder._testing;
const ROOT = path.join(FAKE_USER_DATA, 'recordings');

test('serves paths inside the recordings root', () => {
    assert.equal(resolveMedia('abc/screen.webm'), path.join(ROOT, 'abc', 'screen.webm'));
    assert.equal(resolveMedia('abc/nested/clip.webm'), path.join(ROOT, 'abc', 'nested', 'clip.webm'));
});

test('refuses traversal out of the recordings root', () => {
    for (const attempt of ['../../../../etc/passwd', 'abc/../../../.ssh/id_rsa', '..', '../', 'abc/../../secrets.json']) {
        assert.equal(resolveMedia(attempt), null, `${attempt} must be refused`);
    }
});

test('refuses an absolute path', () => {
    // path.resolve would otherwise discard the root entirely.
    assert.equal(resolveMedia('/etc/passwd'), null);
    assert.equal(resolveMedia('/'), null);
});

test('refuses a sibling directory that merely shares the prefix', () => {
    // The separator has to be part of the comparison, or "recordings-stolen"
    // passes a naive startsWith check against "recordings".
    const sibling = path.join(FAKE_USER_DATA, 'recordings-stolen', 'x.webm');
    const relative = path.relative(ROOT, sibling);
    assert.equal(resolveMedia(relative), null);
});

test('a meeting directory is always a single safe segment', () => {
    assert.equal(meetingDir('2d3ce081-4f71-422a-8278-108dcdbdc436'), path.join(ROOT, '2d3ce081-4f71-422a-8278-108dcdbdc436'));
    // Separators and dots are stripped rather than escaped, so no id can climb.
    assert.equal(meetingDir('../../etc/passwd'), path.join(ROOT, 'etcpasswd'));
    assert.equal(meetingDir('a/b'), path.join(ROOT, 'ab'));
    assert.throws(() => meetingDir('///'), /needs a meeting id/);
    assert.throws(() => meetingDir(''), /needs a meeting id/);
    assert.throws(() => meetingDir(null), /needs a meeting id/);
});
