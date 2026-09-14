const test = require('node:test');
const assert = require('node:assert/strict');
const load = () => import('../apps/ui/src/lib/captureController.js');
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const tick = () => new Promise(resolve => setImmediate(resolve));

test('stopping during permission startup releases the late handle without publishing it', async () => {
    const { createCaptureController } = await load();
    const ready = deferred(); let callback, published = 0, stopped = 0, audio = 0;
    const capture = createCaptureController(options => { callback = options; return ready.promise; });
    capture.start({ onReady: () => published++, onPcm: () => audio++ });
    await tick();
    const stopping = capture.stop();
    callback.onPcm(new Int16Array([1]));
    ready.resolve({ stop: async () => { stopped++; } });
    await stopping;
    assert.equal(published, 0); assert.equal(audio, 0); assert.equal(stopped, 1);
});

test('a device replacement waits for old startup and stop before acquiring the new source', async () => {
    const { createCaptureController } = await load();
    const first = deferred(), stopping = deferred(); const calls = [], callbacks = [], heard = [];
    const capture = createCaptureController(options => {
        calls.push(options.deviceId); callbacks.push(options);
        return options.deviceId === 'first' ? first.promise : Promise.resolve({ stop: async () => calls.push('stop second') });
    });
    capture.start({ deviceId: 'first', onPcm: () => heard.push('first') });
    await tick();
    const second = capture.start({ deviceId: 'second', onPcm: () => heard.push('second') });
    first.resolve({ stop: async () => { calls.push('stop first'); await stopping.promise; } });
    await tick();
    assert.deepEqual(calls, ['first', 'stop first']);
    stopping.resolve(); await second;
    callbacks[0].onPcm(new Int16Array([1])); callbacks[1].onPcm(new Int16Array([1]));
    assert.deepEqual(heard, ['second']);
    await capture.stop();
    assert.deepEqual(calls, ['first', 'stop first', 'second', 'stop second']);
});

test('runtime source failures stop forwarding and release the source for fallback', async () => {
    const { createCaptureController } = await load();
    let callback, stopped = 0, audio = 0; const errors = [];
    const capture = createCaptureController(async options => { callback = options; return { stop: async () => stopped++ }; });
    await capture.start({ onPcm: () => audio++, onError: error => errors.push(error) });
    callback.onPcm(new Int16Array([1])); callback.onError('Permission revoked'); callback.onPcm(new Int16Array([1]));
    await tick();
    assert.equal(stopped, 1); assert.equal(audio, 1); assert.deepEqual(errors, ['Permission revoked']);
});

test('muting a ready capture does not reopen the device, and stopped callbacks remain silent', async () => {
    const { createCaptureController } = await load();
    let starts = 0, handle, callbacks; const mutes = [];
    const capture = createCaptureController(async options => { starts++; callbacks = options; return { setMuted: value => mutes.push(value), stop: async () => {} }; });
    await capture.start({ onReady: value => { handle = value; }, onError: () => assert.fail('stale error') });
    handle.setMuted(true); handle.setMuted(false);
    await capture.stop(); callbacks.onError('late error');
    assert.equal(starts, 1); assert.deepEqual(mutes, [true, false]);
});
