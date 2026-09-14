const { ipcMain } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const HELPER_NAME = 'SystemAudioDump';
const SOURCE_SAMPLE_RATE = 24000;
const SOURCE_CHANNELS = 2;
const TARGET_SAMPLE_RATE = 16000;
const SOURCE_FRAME_BYTES = SOURCE_CHANNELS * 2;
const CHUNK_SAMPLES = TARGET_SAMPLE_RATE / 10;

const DATA_CHANNEL = 'system-audio:data';
const STATUS_CHANNEL = 'system-audio:status';

const PERMISSION_PATTERN = /permission|screen recording|not authorized|tcc/i;
const PERMISSION_MESSAGE =
    'Screen Recording permission is required to hear the other participants. Grant it in System Settings › Privacy & Security › Screen Recording, then restart Alpha.';

let child = null;
let target = null;

function helperPath() {
    if (process.env.ALPHA_SYSTEM_AUDIO_PATH) return process.env.ALPHA_SYSTEM_AUDIO_PATH;
    const packaged = process.resourcesPath ? path.join(process.resourcesPath, HELPER_NAME) : null;
    if (packaged && fs.existsSync(packaged)) return packaged;
    return path.join(__dirname, 'assets', HELPER_NAME);
}

function availability(platform = process.platform) {
    if (platform !== 'darwin') {
        return {
            available: false,
            platform,
            helper: null,
            reason: 'Capturing the other participants without sharing a screen needs the macOS helper. On this platform, pick a loopback input device under Settings › Audio › Meeting audio.',
        };
    }
    const helper = helperPath();
    if (!fs.existsSync(helper)) {
        return { available: false, platform, helper, reason: `The system audio helper is missing from this build (${helper}).` };
    }
    return { available: true, platform, helper, reason: null };
}

function stereoToMono(buffer) {
    const frames = Math.floor(buffer.length / SOURCE_FRAME_BYTES);
    const mono = new Int16Array(frames);
    for (let i = 0; i < frames; i += 1) {
        const left = buffer.readInt16LE(i * SOURCE_FRAME_BYTES);
        const right = buffer.readInt16LE(i * SOURCE_FRAME_BYTES + 2);
        mono[i] = (left + right) >> 1;
    }
    return mono;
}

function createResampler(from = SOURCE_SAMPLE_RATE, to = TARGET_SAMPLE_RATE) {
    const step = from / to;
    let tail = new Int16Array(0);
    let phase = 0;

    return function resample(samples) {
        if (!samples.length && !tail.length) return new Int16Array(0);

        const input = new Int16Array(tail.length + samples.length);
        input.set(tail, 0);
        input.set(samples, tail.length);

        const count = Math.max(0, Math.ceil((input.length - 1 - phase) / step));
        const output = new Int16Array(count);
        let position = phase;
        for (let i = 0; i < count; i += 1) {
            const index = Math.floor(position);
            const fraction = position - index;
            output[i] = Math.round(input[index] * (1 - fraction) + input[index + 1] * fraction);
            position += step;
        }

        const consumed = Math.min(Math.floor(position), input.length);
        tail = input.slice(consumed);
        phase = position - consumed;
        return output;
    };
}

function createConverter(onChunk) {
    const resample = createResampler();
    let partial = Buffer.alloc(0);
    let pending = new Int16Array(0);

    return function feed(data) {
        const buffer = partial.length ? Buffer.concat([partial, data]) : data;
        const usable = buffer.length - (buffer.length % SOURCE_FRAME_BYTES);
        partial = usable === buffer.length ? Buffer.alloc(0) : Buffer.from(buffer.subarray(usable));
        if (!usable) return;

        const resampled = resample(stereoToMono(buffer.subarray(0, usable)));
        if (!resampled.length) return;

        const merged = new Int16Array(pending.length + resampled.length);
        merged.set(pending, 0);
        merged.set(resampled, pending.length);

        let offset = 0;
        while (merged.length - offset >= CHUNK_SAMPLES) {
            onChunk(Buffer.copyBytesFrom(merged.subarray(offset, offset + CHUNK_SAMPLES)));
            offset += CHUNK_SAMPLES;
        }
        pending = merged.slice(offset);
    };
}

function killStrayHelpers(spawnFn) {
    if (process.platform !== 'darwin') return Promise.resolve();
    return new Promise(resolve => {
        let settled = false;
        const done = () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve();
        };
        const timer = setTimeout(done, 2000);
        try {
            const killer = spawnFn('pkill', ['-f', HELPER_NAME], { stdio: 'ignore' });
            killer.on('close', done);
            killer.on('error', done);
        } catch {
            done();
        }
    });
}

function post(sender, payload) {
    if (!sender || sender.isDestroyed?.()) return;
    sender.send(STATUS_CHANNEL, payload);
}

async function start(sender, { spawnFn = spawn } = {}) {
    const state = availability();
    if (!state.available) throw new Error(state.reason);

    stop();
    await killStrayHelpers(spawnFn);

    const helper = state.helper;
    const started = spawnFn(helper, [], { stdio: ['ignore', 'pipe', 'pipe'] });
    if (!started || (!started.pid && started.pid !== 0)) throw new Error(`The system audio helper did not start (${helper}).`);

    child = started;
    target = sender;

    const feed = createConverter(chunk => {
        if (child !== started) return;
        if (!sender || sender.isDestroyed?.()) return;
        sender.send(DATA_CHANNEL, chunk);
    });

    started.stdout.on('data', feed);

    started.stderr.on('data', data => {
        const text = String(data).trim();
        if (!text) return;
        if (PERMISSION_PATTERN.test(text)) post(sender, { state: 'error', message: PERMISSION_MESSAGE });
        else console.error(`[Alpha] ${HELPER_NAME}: ${text}`);
    });

    started.on('error', cause => {
        if (child === started) child = null;
        post(sender, { state: 'error', message: `The system audio helper failed: ${cause.message}` });
    });

    started.on('close', code => {
        const wasCurrent = child === started;
        if (wasCurrent) {
            child = null;
            target = null;
        }
        if (!wasCurrent || code === 0 || code === null) return;
        post(sender, {
            state: 'error',
            message: process.platform === 'darwin' ? PERMISSION_MESSAGE : `The system audio helper stopped with code ${code}.`,
        });
    });

    sender?.once?.('destroyed', () => {
        if (child === started) stop();
    });

    post(sender, { state: 'started', helper });
    return { started: true, helper, sampleRate: TARGET_SAMPLE_RATE };
}

function stop() {
    if (!child) return { stopped: false };
    const running = child;
    child = null;
    target = null;
    running.stdout?.removeAllListeners('data');
    running.removeAllListeners('close');
    try {
        running.kill('SIGTERM');
    } catch {
        return { stopped: false };
    }
    return { stopped: true };
}

function registerHandlers() {
    ipcMain.handle('system-audio:available', () => {
        const state = availability();
        return { available: state.available, platform: state.platform, reason: state.reason };
    });
    ipcMain.handle('system-audio:start', event => start(event.sender));
    ipcMain.handle('system-audio:stop', () => stop());
}

module.exports = {
    DATA_CHANNEL,
    STATUS_CHANNEL,
    TARGET_SAMPLE_RATE,
    availability,
    registerHandlers,
    start,
    stop,
    shutdown: stop,
    _testing: {
        helperPath,
        stereoToMono,
        createResampler,
        createConverter,
        CHUNK_SAMPLES,
        isRunning: () => Boolean(child),
        activeSender: () => target,
    },
};
