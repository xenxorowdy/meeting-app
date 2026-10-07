const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'kesami-recorder-lifecycle-'));
const handlers = new Map();
let mediaHandler;
let failWrites = false;
let writeGate = null;
let closed = 0;
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
    if (request === 'electron') return {
        app: { getPath: () => temporary },
        ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
        protocol: { handle: (_scheme, handler) => { mediaHandler = handler; } },
        net: { fetch: url => url },
        session: { defaultSession: {} },
        desktopCapturer: { getSources: async () => [{ id: 'screen:1' }] },
    };
    if (request === './legacy' && parent.filename.endsWith('/recorder.js')) return { env: () => null, LIBRARY: 'Kesami Meetings' };
    if (request === 'node:fs/promises' && parent.filename.endsWith('/recorder.js')) return {
        ...fsp,
        async open(...args) {
            const descriptor = await fsp.open(...args);
            return {
                async write(buffer, offset, length) {
                    if (writeGate) await writeGate;
                    if (failWrites) throw new Error('ENOSPC: no space left on device');
                    // Exercise partial writes, which must not truncate a chunk.
                    return descriptor.write(buffer, offset, Math.min(length, 2));
                },
                async close() { closed += 1; await descriptor.close(); },
            };
        },
    };
    return originalLoad(request, parent, isMain);
};
const recorder = require('../apps/desktop/recorder');
Module._load = originalLoad;
recorder.registerHandlers();
recorder.serveMediaScheme();
test.after(async () => {
    await recorder.shutdown();
    await fsp.rm(temporary, { recursive: true, force: true });
});
const invoke = (channel, ...args) => handlers.get(`recorder:${channel}`)({}, ...args);
const start = meetingId => invoke('start', { meetingId, mimeType: 'audio/webm', startedAtMs: Date.now() });

test('concurrent chunks finish in order before stop closes the recording', async () => {
    const recording = await start('ordered');
    const first = invoke('write-chunk', recording.id, new Uint8Array([1, 2, 3]));
    const second = invoke('write-chunk', recording.id, new Uint8Array([4, 5, 6]));
    const stop = invoke('stop', recording.id);
    await assert.rejects(invoke('write-chunk', recording.id, new Uint8Array([7])), /not open/);
    assert.deepEqual(await Promise.all([first, second]), [{ bytes: 3 }, { bytes: 6 }]);
    assert.deepEqual(await stop, { path: recording.path, bytes: 6 });
    assert.deepEqual([...await fsp.readFile(path.join(recorder.LIBRARY_ROOT, recording.path))], [1, 2, 3, 4, 5, 6]);
});

test('duplicate starts and removal preserve open and recoverable recordings', async () => {
    const recording = await start('preserved');
    await invoke('write-chunk', recording.id, Buffer.from('original'));
    await assert.rejects(start('preserved'), /EEXIST/);
    await assert.rejects(invoke('remove', 'preserved'), /open recording/);
    await invoke('stop', recording.id);
    await assert.rejects(start('preserved'), /EEXIST/);
    assert.equal(await fsp.readFile(path.join(recorder.LIBRARY_ROOT, recording.path), 'utf8'), 'original');
});

test('disk errors reject writes and stop without uncaught events or hanging shutdown', async () => {
    const recording = await start('disk-error');
    const previousClosed = closed;
    failWrites = true;
    try {
        await assert.rejects(invoke('write-chunk', recording.id, Buffer.from('chunk')), /ENOSPC/);
        await assert.rejects(invoke('write-chunk', recording.id, Buffer.from('next')), /ENOSPC/);
        await assert.rejects(invoke('stop', recording.id), /ENOSPC/);
        assert.equal(closed, previousClosed + 1);
        assert.equal(await invoke('stop', recording.id), null);
    } finally {
        failWrites = false;
    }
});

test('shutdown waits for the last queued write to close the file', async () => {
    const recording = await start('shutdown');
    let release;
    writeGate = new Promise(resolve => { release = resolve; });
    const write = invoke('write-chunk', recording.id, Buffer.from('last chunk'));
    let finished = false;
    const shutdown = recorder.shutdown().then(() => { finished = true; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(finished, false);
    release();
    writeGate = null;
    await Promise.all([write, shutdown]);
    assert.equal(await fsp.readFile(path.join(recorder.LIBRARY_ROOT, recording.path), 'utf8'), 'last chunk');
});

test('media playback refuses symlinks outside the library and malformed paths', async () => {
    const secret = path.join(temporary, 'private.txt');
    await fsp.writeFile(secret, 'private');
    await fsp.symlink(secret, path.join(recorder.LIBRARY_ROOT, 'escape.webm'));
    assert.equal((await mediaHandler({ url: 'kesami-media://recordings/escape.webm' })).status, 404);
    assert.equal((await mediaHandler({ url: 'kesami-media://recordings/%zz' })).status, 400);
    const response = await mediaHandler({ url: 'kesami-media://recordings/.in-progress/ordered/screen.webm', headers: {} });
    assert.match(response, /^file:.*screen.webm$/);
});

test('display capture rejects untrusted frames before enumerating a source', async () => {
    let handler;
    recorder.installDisplayMediaHandler({ setDisplayMediaRequestHandler: callback => { handler = callback; } }, request => request.trusted === true);
    let response;
    await handler({}, value => { response = value; });
    assert.deepEqual(response, {});
    await handler({ trusted: true }, value => { response = value; });
    assert.equal(response.video.id, 'screen:1');
});
