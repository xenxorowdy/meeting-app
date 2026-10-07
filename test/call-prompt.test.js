const test = require('node:test');
const assert = require('node:assert/strict');
const load = () => import('../apps/ui/src/lib/callPrompt.js');

async function fixture(onStart = async () => ({ id: 'meeting' })) {
    const { createCallPromptController } = await load();
    let time = 1000;
    let id = 0;
    let state = null;
    const timers = new Map();
    const controller = createCallPromptController({
        now: () => time, makeId: () => `prompt-${++id}`, onChange: next => { state = next; },
        schedule: (fn, ms) => { const key = ++id; timers.set(key, { at: time + ms, fn }); return key; },
        cancel: key => timers.delete(key),
    });
    const context = { enabled: true, canRecord: true, onStart };
    controller.setContext(context);
    return {
        controller, context, state: () => state, timerCount: () => timers.size,
        tick(ms) {
            time += ms;
            for (const [key, timer] of timers) if (timer.at <= time) { timers.delete(key); timer.fn(); }
        },
    };
}

test('browser and microphone signals produce a prompt without calendar or notification requirements', async () => {
    for (const call of [{ source: 'google-meet', url: 'https://meet.google.com/example' }, { source: 'zoom' }, { source: 'microphone' }]) {
        const f = await fixture();
        f.controller.detect(call);
        assert.equal(f.state().source, call.source);
        assert.equal(f.state().expiresAt - f.state().createdAt, 120000);
        f.controller.dispose();
    }
});

test('disabled, disconnected, or busy contexts cannot prompt or start', async () => {
    for (const patch of [{ enabled: false }, { canRecord: false }]) {
        let starts = 0;
        const f = await fixture(async () => { starts++; return {}; });
        f.controller.detect({ source: 'zoom' });
        const id = f.state().id;
        f.controller.setContext({ ...f.context, ...patch });
        assert.equal(f.state(), null);
        f.controller.detect({ source: 'microphone' });
        assert.equal(f.state(), null);
        assert.equal(await f.controller.start(id), false);
        assert.equal(starts, 0);
    }
});

test('duplicate browser/mic observations enrich one card without extending its two-minute expiry', async () => {
    const f = await fixture();
    f.controller.detect({ source: 'microphone' });
    const original = f.state();
    f.tick(60000);
    f.controller.detect({ source: 'google-meet', url: 'call-1' });
    f.controller.detect({ source: 'microphone' });
    assert.equal(f.state().id, original.id);
    assert.equal(f.state().source, 'google-meet');
    assert.equal(f.state().expiresAt, original.expiresAt);
    f.controller.microphoneInactive();
    assert(f.state(), 'a browser call is not retracted by microphone mute');
    f.tick(59999);
    assert(f.state());
    f.tick(1);
    assert.equal(f.state(), null);
    assert.equal(f.timerCount(), 0);
});

test('Not now and microphone inactivity dismiss, and same-call cooldown survives dismissal', async () => {
    const f = await fixture();
    f.controller.detect({ source: 'microphone' });
    const id = f.state().id;
    assert.equal(f.controller.dismiss('stale-id'), false);
    assert.equal(f.controller.dismiss(id), true);
    f.controller.detect({ source: 'microphone' });
    assert.equal(f.state(), null);
    f.tick(300000);
    f.controller.detect({ source: 'microphone' });
    assert(f.state());
    f.controller.microphoneInactive();
    assert.equal(f.state(), null);
});

test('a different browser meeting can prompt during the previous meeting cooldown', async () => {
    const f = await fixture();
    f.controller.detect({ source: 'zoom', url: 'call-1' });
    f.controller.dismiss(f.state().id);
    f.controller.detect({ source: 'zoom', url: 'call-2' });
    assert(f.state());
    f.controller.dispose();
});

test('Start is single-flight, pauses expiry, and clears on success', async () => {
    let resolve;
    let starts = 0;
    const f = await fixture(() => { starts++; return new Promise(done => { resolve = done; }); });
    f.controller.detect({ source: 'microphone' });
    const id = f.state().id;
    assert.equal(await f.controller.start('stale-id'), false);
    const starting = f.controller.start(id);
    assert.equal(f.state().status, 'starting');
    assert.equal(f.timerCount(), 0);
    assert.equal(await f.controller.start(id), false);
    assert.equal(f.controller.dismiss(id), false);
    f.controller.microphoneInactive();
    f.controller.setContext({ ...f.context, canRecord: false });
    f.tick(180000);
    assert.equal(f.state().status, 'starting');
    resolve({ id: 'meeting' });
    assert.equal(await starting, true);
    assert.equal(f.state(), null);
    assert.equal(starts, 1);
});

test('startup failure offers retry without extending the original expiry', async () => {
    let attempts = 0;
    const f = await fixture(async () => { if (++attempts === 1) throw new Error('Permission denied'); return { id: 'meeting' }; });
    f.controller.detect({ source: 'zoom' });
    const original = f.state();
    f.tick(40000);
    assert.equal(await f.controller.start(original.id), false);
    assert.equal(f.state().error, 'Permission denied');
    assert.equal(f.state().status, 'ready');
    assert.equal(f.state().expiresAt, original.expiresAt);
    assert.equal(await f.controller.start(original.id), true);
    assert.equal(f.state(), null);
});

test('a null startup result is failure and disposal cancels timers and late updates', async () => {
    const f = await fixture(async () => null);
    f.controller.detect({ source: 'zoom' });
    assert.equal(await f.controller.start(f.state().id), false);
    assert.match(f.state().error, /Could not start/);
    f.controller.dispose();
    assert.equal(f.timerCount(), 0);
    const previous = f.state();
    f.tick(200000);
    f.controller.detect({ source: 'microphone' });
    assert.equal(f.state(), previous);
});
