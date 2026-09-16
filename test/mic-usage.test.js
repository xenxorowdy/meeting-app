const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { EventEmitter } = require('node:events');

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
    if (request === 'electron') return { ipcMain: { handle() {} } };
    return originalLoad(request, parent, isMain);
};

const micUsage = require('../apps/desktop/micUsage');
Module._load = originalLoad;

const { createDebounce } = micUsage;
const { helperPath } = micUsage._testing;

/** Drives createDebounce with a controllable clock. */
function fakeClock() {
    const scheduled = [];
    let now = 0;
    const setTimeoutFn = (fn, delay) => {
        const entry = { fn, at: now + delay, cleared: false };
        scheduled.push(entry);
        return entry;
    };
    const clearTimeoutFn = entry => {
        if (entry) entry.cleared = true;
    };
    const advance = ms => {
        now += ms;
        for (const entry of [...scheduled]) {
            if (entry.cleared || entry.at > now) continue;
            scheduled.splice(scheduled.indexOf(entry), 1);
            entry.fn();
        }
    };
    return { setTimeoutFn, clearTimeoutFn, advance };
}

test('the watcher helper ships with the desktop shell', () => {
    const helper = helperPath();
    assert.equal(path.basename(helper), 'mic-watch');
    const stat = fs.statSync(helper);
    assert.ok(stat.size > 0);
    assert.ok(stat.mode & 0o111, 'the helper must be executable');
});

test('a platform without the watcher explains itself instead of failing', () => {
    const state = micUsage.availability('win32');
    assert.equal(state.available, false);
    assert.match(state.reason, /macOS/i);
});

test('macOS reports the watcher as available', { skip: process.platform !== 'darwin' }, () => {
    assert.equal(micUsage.availability('darwin').available, true);
});

test('a microphone that has been live a while becomes an event', () => {
    const clock = fakeClock();
    const emissions = [];
    const debounce = createDebounce({
        onEmit: active => emissions.push(active),
        activeAfterMs: 8000,
        inactiveAfterMs: 1500,
        setTimeoutFn: clock.setTimeoutFn,
        clearTimeoutFn: clock.clearTimeoutFn,
    });

    debounce.line('active');
    clock.advance(7999);
    assert.deepEqual(emissions, [], 'a blip shorter than the debounce is not a call');
    clock.advance(1);
    assert.deepEqual(emissions, [true]);
});

test('a momentary blip is cancelled by going quiet before the debounce elapses', () => {
    const clock = fakeClock();
    const emissions = [];
    const debounce = createDebounce({
        onEmit: active => emissions.push(active),
        activeAfterMs: 8000,
        inactiveAfterMs: 1500,
        setTimeoutFn: clock.setTimeoutFn,
        clearTimeoutFn: clock.clearTimeoutFn,
    });

    debounce.line('active');
    clock.advance(3000);
    debounce.line('inactive');
    clock.advance(10_000);
    assert.deepEqual(emissions, [], 'neither the blip nor its retraction may fire');
});

test('going quiet after a reported call retracts it, briefly delayed', () => {
    const clock = fakeClock();
    const emissions = [];
    const debounce = createDebounce({
        onEmit: active => emissions.push(active),
        activeAfterMs: 8000,
        inactiveAfterMs: 1500,
        setTimeoutFn: clock.setTimeoutFn,
        clearTimeoutFn: clock.clearTimeoutFn,
    });

    debounce.line('active');
    clock.advance(8000);
    debounce.line('inactive');
    clock.advance(1499);
    assert.deepEqual(emissions, [true], 'a brief dropout must not flap the state');
    clock.advance(1);
    assert.deepEqual(emissions, [true, false]);
});

test('silence that was never reported live is not retracted', () => {
    const clock = fakeClock();
    const emissions = [];
    const debounce = createDebounce({
        onEmit: active => emissions.push(active),
        activeAfterMs: 8000,
        inactiveAfterMs: 1500,
        setTimeoutFn: clock.setTimeoutFn,
        clearTimeoutFn: clock.clearTimeoutFn,
    });

    // The helper prints its initial state at startup, which is usually
    // 'inactive'; that must not produce an event.
    debounce.line('inactive');
    clock.advance(60_000);
    assert.deepEqual(emissions, []);
});

test('a call that resumes mid-retraction keeps the live state', () => {
    const clock = fakeClock();
    const emissions = [];
    const debounce = createDebounce({
        onEmit: active => emissions.push(active),
        activeAfterMs: 8000,
        inactiveAfterMs: 1500,
        setTimeoutFn: clock.setTimeoutFn,
        clearTimeoutFn: clock.clearTimeoutFn,
    });

    debounce.line('active');
    clock.advance(8000);
    debounce.line('inactive');
    clock.advance(1000);
    debounce.line('active');
    clock.advance(60_000);
    assert.deepEqual(emissions, [true], 'the retraction is cancelled and the call stays live');
});

test('reset clears everything, the way a helper restart must', () => {
    const clock = fakeClock();
    const emissions = [];
    const debounce = createDebounce({
        onEmit: active => emissions.push(active),
        activeAfterMs: 8000,
        inactiveAfterMs: 1500,
        setTimeoutFn: clock.setTimeoutFn,
        clearTimeoutFn: clock.clearTimeoutFn,
    });

    debounce.line('active');
    clock.advance(8000);
    debounce.reset();
    clock.advance(60_000);
    debounce.line('inactive');
    clock.advance(60_000);
    assert.deepEqual(emissions, [true]);
    assert.equal(debounce.isEmitted(), false);
});
