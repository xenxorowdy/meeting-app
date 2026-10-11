const test = require('node:test');
const assert = require('node:assert/strict');
const { holdQuitUntil } = require('../apps/desktop/shutdown');

function fakeApp() {
    const listeners = new Map();
    const app = {
        exits: [],
        quits: 0,
        on: (name, listener) => listeners.set(name, listener),
        exit: code => app.exits.push(code),
        quit: () => {
            app.quits += 1;
        },
        requestQuit() {
            const event = {
                prevented: false,
                preventDefault() {
                    event.prevented = true;
                },
            };
            listeners.get('before-quit')(event);
            return event;
        },
    };
    return app;
}

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((yes, no) => {
        resolve = yes;
        reject = no;
    });
    return { promise, resolve, reject };
}

async function settle() {
    for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
}

const nextTurn = () => new Promise(resolve => setImmediate(resolve));

test('the first quit is held until cleanup finishes, then the backend stops and the app exits', async () => {
    const app = fakeApp();
    const order = [];
    const cleanup = deferred();
    holdQuitUntil(
        app,
        () => {
            order.push('cleanup');
            return cleanup.promise;
        },
        { beforeExit: () => order.push('backend stopped') }
    );

    assert.equal(app.requestQuit().prevented, true);
    await settle();
    await nextTurn();
    assert.deepEqual(app.exits, []);

    cleanup.resolve();
    await settle();
    await nextTurn();
    assert.deepEqual(order, ['cleanup', 'backend stopped']);
    assert.deepEqual(app.exits, [0]);
    assert.equal(app.quits, 0);
});

test('a cleanup that finishes at once still exits after the quit event, never inside it', async () => {
    const app = fakeApp();
    holdQuitUntil(app, () => {});

    const event = app.requestQuit();
    await settle();
    assert.equal(event.prevented, true);
    assert.deepEqual(app.exits, []);
    assert.equal(app.quits, 0);

    await nextTurn();
    assert.deepEqual(app.exits, [0]);
    assert.equal(app.quits, 0);
});

test('more quit requests during cleanup are held without cleaning up twice', async () => {
    const app = fakeApp();
    const cleanup = deferred();
    let runs = 0;
    holdQuitUntil(app, () => {
        runs += 1;
        return cleanup.promise;
    });

    assert.equal(app.requestQuit().prevented, true);
    await settle();
    assert.equal(app.requestQuit().prevented, true);
    cleanup.resolve();
    await settle();
    await nextTurn();

    assert.equal(runs, 1);
    assert.deepEqual(app.exits, [0]);
});

test('a failing cleanup is reported and the backend still stops before the app exits', async () => {
    const app = fakeApp();
    const errors = [];
    let stopped = 0;
    holdQuitUntil(
        app,
        async () => {
            throw new Error('disk full');
        },
        { onError: cause => errors.push(cause.message), beforeExit: () => (stopped += 1) }
    );

    app.requestQuit();
    await settle();
    await nextTurn();

    assert.deepEqual(errors, ['disk full']);
    assert.equal(stopped, 1);
    assert.deepEqual(app.exits, [0]);
});

test('a cleanup that never finishes is abandoned at the deadline', async () => {
    const app = fakeApp();
    const timers = [];
    let stopped = 0;
    holdQuitUntil(app, () => new Promise(() => {}), {
        timeoutMs: 1234,
        startTimer: (callback, ms) => {
            timers.push({ callback, ms });
            return timers.length;
        },
        stopTimer: () => assert.fail('a hung cleanup cannot cancel its deadline'),
        beforeExit: () => (stopped += 1),
    });

    app.requestQuit();
    await settle();
    assert.deepEqual(
        timers.map(timer => timer.ms),
        [1234]
    );
    assert.deepEqual(app.exits, []);

    timers[0].callback();
    await nextTurn();
    assert.equal(stopped, 1);
    assert.deepEqual(app.exits, [0]);
});

test('a failing backend stop is reported and the app still exits', async () => {
    const app = fakeApp();
    const errors = [];
    holdQuitUntil(app, () => {}, {
        beforeExit: () => {
            throw new Error('kill failed');
        },
        onError: cause => errors.push(cause.message),
    });

    app.requestQuit();
    await settle();
    await nextTurn();

    assert.deepEqual(errors, ['kill failed']);
    assert.deepEqual(app.exits, [0]);
});

test('once the app is exiting, quit requests are no longer held', async () => {
    const app = fakeApp();
    holdQuitUntil(app, () => {});

    app.requestQuit();
    await settle();
    assert.equal(app.requestQuit().prevented, false);

    await nextTurn();
    assert.deepEqual(app.exits, [0]);
});
