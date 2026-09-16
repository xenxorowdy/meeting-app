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

const systemAudio = require('../apps/desktop/systemAudio');
Module._load = originalLoad;

const { helperPath, stereoToMono, createResampler, createConverter, CHUNK_SAMPLES } = systemAudio._testing;

const stereoBuffer = frames => {
    const buffer = Buffer.alloc(frames * 4);
    for (let i = 0; i < frames; i += 1) {
        const value = Math.round(16000 * Math.sin((2 * Math.PI * 440 * i) / 24000));
        buffer.writeInt16LE(value, i * 4);
        buffer.writeInt16LE(value, i * 4 + 2);
    }
    return buffer;
};

class FakeChild extends EventEmitter {
    constructor(command) {
        super();
        this.command = command;
        this.pid = 4242;
        this.stdout = new EventEmitter();
        this.stderr = new EventEmitter();
        this.signals = [];
    }

    kill(signal) {
        this.signals.push(signal);
    }
}

function fakeSpawner() {
    const spawned = [];
    const spawnFn = command => {
        const child = new FakeChild(command);
        spawned.push(child);
        if (command === 'pkill') setImmediate(() => child.emit('close', 0));
        return child;
    };
    return { spawnFn, spawned, helper: () => spawned.find(child => child.command !== 'pkill') };
}

function fakeSender() {
    const messages = [];
    return {
        messages,
        isDestroyed: () => false,
        send(channel, payload) {
            messages.push({ channel, payload });
        },
    };
}

test('the capture helper ships with the desktop shell', () => {
    const helper = helperPath();
    assert.equal(path.basename(helper), 'SystemAudioDump');
    const stat = fs.statSync(helper);
    assert.ok(stat.size > 0);
    assert.ok(stat.mode & 0o111, 'the helper must be executable');
});

test('a platform without the helper explains what to do instead', () => {
    const state = systemAudio.availability('win32');
    assert.equal(state.available, false);
    assert.match(state.reason, /loopback input device/i);
});

test('macOS reports the helper as available', { skip: process.platform !== 'darwin' }, () => {
    assert.equal(systemAudio.availability('darwin').available, true);
});

test('stereo frames collapse to the average of both channels', () => {
    const buffer = Buffer.alloc(8);
    buffer.writeInt16LE(1000, 0);
    buffer.writeInt16LE(2000, 2);
    buffer.writeInt16LE(-4000, 4);
    buffer.writeInt16LE(-2000, 6);

    assert.deepEqual(Array.from(stereoToMono(buffer)), [1500, -3000]);
});

test('a partial stereo frame is ignored until its remaining bytes arrive', () => {
    assert.equal(stereoToMono(Buffer.alloc(3)).length, 0);
    assert.equal(stereoToMono(Buffer.alloc(9)).length, 2);
});

test('24 kHz input becomes 16 kHz at two output samples for every three input', () => {
    const resample = createResampler();
    const output = resample(new Int16Array(2400));
    assert.ok(Math.abs(output.length - 1600) <= 1, `expected about 1600 samples, got ${output.length}`);
});

test('resampling stays continuous when the helper splits a block', () => {
    const whole = createResampler()(new Int16Array(2400).fill(700));

    const split = createResampler();
    const first = split(new Int16Array(1000).fill(700));
    const second = split(new Int16Array(1400).fill(700));

    assert.equal(first.length + second.length, whole.length);
    assert.ok(second.every(sample => sample === 700));
});

test('the converter emits fixed short chunks of 16 kHz mono PCM', () => {
    const chunks = [];
    const feed = createConverter(chunk => chunks.push(chunk));

    feed(stereoBuffer(24000));

    assert.ok(CHUNK_SAMPLES * 2 <= 16000 / 25, 'meeting audio must not be buffered long enough to outrun the echo gate');
    assert.equal(chunks.length, 16000 / CHUNK_SAMPLES);
    for (const chunk of chunks) assert.equal(chunk.length, CHUNK_SAMPLES * 2);
});

test('bytes split mid-frame are carried into the next chunk rather than dropped', () => {
    const whole = [];
    createConverter(chunk => whole.push(chunk))(stereoBuffer(24000));

    const split = [];
    const feed = createConverter(chunk => split.push(chunk));
    const source = stereoBuffer(24000);
    feed(source.subarray(0, 4001));
    feed(source.subarray(4001, 9999));
    feed(source.subarray(9999));

    assert.equal(split.length, whole.length);
    assert.deepEqual(Buffer.concat(split), Buffer.concat(whole));
});

test('capture forwards converted audio to the window that asked for it', { skip: process.platform !== 'darwin' }, async () => {
    const sender = fakeSender();
    const { spawnFn, helper } = fakeSpawner();

    const result = await systemAudio.start(sender, { spawnFn });
    assert.equal(result.started, true);
    assert.equal(result.sampleRate, 16000);
    assert.deepEqual(sender.messages.at(-1).channel, 'system-audio:status');

    helper().stdout.emit('data', stereoBuffer(24000));

    const audio = sender.messages.filter(message => message.channel === 'system-audio:data');
    assert.equal(audio.length, 16000 / CHUNK_SAMPLES);
    assert.equal(audio[0].payload.length, CHUNK_SAMPLES * 2);

    assert.deepEqual(systemAudio.stop(), { stopped: true });
    assert.deepEqual(helper().signals, ['SIGTERM']);
});

test('a denied Screen Recording permission is reported, not swallowed', { skip: process.platform !== 'darwin' }, async () => {
    const sender = fakeSender();
    const { spawnFn, helper } = fakeSpawner();

    await systemAudio.start(sender, { spawnFn });
    helper().stderr.emit('data', Buffer.from('error: screen recording permission denied'));

    const failure = sender.messages.findLast(message => message.channel === 'system-audio:status' && message.payload.state === 'error');
    assert.ok(failure, 'the renderer must hear about a permission failure');
    assert.match(failure.payload.message, /Screen Recording/);

    systemAudio.stop();
});

test('a helper that exits on its own reports the failure once', { skip: process.platform !== 'darwin' }, async () => {
    const sender = fakeSender();
    const { spawnFn, helper } = fakeSpawner();

    await systemAudio.start(sender, { spawnFn });
    helper().emit('close', 1);

    const failures = sender.messages.filter(message => message.channel === 'system-audio:status' && message.payload.state === 'error');
    assert.equal(failures.length, 1);
    assert.deepEqual(systemAudio.stop(), { stopped: false });
});

test('an unexpected clean exit also releases speaker capture', { skip: process.platform !== 'darwin' }, async () => {
    const sender = fakeSender();
    const { spawnFn, helper } = fakeSpawner();
    await systemAudio.start(sender, { spawnFn });
    helper().emit('close', 0);
    const failures = sender.messages.filter(message => message.channel === 'system-audio:status' && message.payload.state === 'error');
    assert.equal(failures.length, 1);
    assert.match(failures[0].payload.message, /stopped unexpectedly/);
    assert.deepEqual(systemAudio.stop(), { stopped: false });
});
