const assert = require('node:assert/strict');
const { test } = require('node:test');

const deferred = () => {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
};

class Track {
    constructor(kind = 'audio') { this.kind = kind; this.readyState = 'live'; this.listeners = new Map(); }
    stop() { this.readyState = 'ended'; }
    applyConstraints() { return Promise.resolve(); }
    addEventListener(type, listener) { this.listeners.set(type, listener); }
    removeEventListener(type) { this.listeners.delete(type); }
}

class Stream {
    constructor(tracks = []) { this.tracks = tracks; }
    getTracks() { return this.tracks; }
    getAudioTracks() { return this.tracks.filter(track => track.kind === 'audio'); }
    getVideoTracks() { return this.tracks.filter(track => track.kind === 'video'); }
}

async function withMedia(run, options = {}) {
    const previous = new Map();
    const state = { contexts: [], recorders: [], files: [], closedFiles: [], worklets: [] };
    const node = () => ({
        connections: [],
        connect(target) { this.connections.push(target); return target; },
        disconnect() { this.disconnected = true; },
    });
    class Context {
        constructor({ sampleRate = 48000 } = {}) {
            this.sampleRate = sampleRate; this.state = 'running'; this.currentTime = 0;
            this.inputs = []; this.gains = []; this.buffers = []; this.bufferSources = [];
            this.destination = { physicalSpeakers: true };
            this.audioWorklet = { addModule: async () => { if (options.workletError) throw new Error(options.workletError); } };
            state.contexts.push(this);
        }
        createMediaStreamDestination() { return this.mediaDestination = { stream: new Stream([new Track()]) }; }
        createMediaStreamSource(stream) { this.inputs.push(stream); return node(); }
        createGain() { const gain = { ...node(), gain: { value: 1 } }; this.gains.push(gain); return gain; }
        createBuffer(channels, length, sampleRate) {
            const samples = new Float32Array(length);
            const buffer = { sampleRate, length, getChannelData: () => samples };
            this.buffers.push(buffer); return buffer;
        }
        createBufferSource() {
            const source = { ...node(), start(time) { this.startTime = time; }, stop() { this.stopped = true; } };
            this.bufferSources.push(source); return source;
        }
        async resume() { this.state = 'running'; }
        async close() { this.state = 'closed'; }
    }
    class Worklet {
        constructor() { Object.assign(this, node()); this.port = {}; state.worklets.push(this); }
    }
    class Recorder {
        static isTypeSupported() { return true; }
        constructor(stream) { this.stream = stream; this.state = 'inactive'; state.recorders.push(this); }
        start() { this.state = 'recording'; }
        stop() { this.state = 'inactive'; queueMicrotask(() => this.onstop?.()); }
    }
    const display = options.display || new Stream([new Track('video')]);
    const bridge = {
        screenPermission: async () => 'granted',
        selectSource: async () => {},
        start: async value => { state.files.push(value); return { id: 'recording', path: 'meeting/screen.webm' }; },
        writeChunk: async () => {},
        stop: async id => { state.closedFiles.push(id); return { path: 'meeting/screen.webm', bytes: 0 }; },
        ...options.recorderBridge,
    };
    const globals = {
        AudioContext: Context, AudioWorkletNode: Worklet, MediaStream: Stream, MediaRecorder: Recorder,
        navigator: { mediaDevices: { getDisplayMedia: async () => display, ...options.devices } },
        kesamiRecorder: bridge,
        kesamiSystemAudio: options.systemBridge,
    };
    for (const [name, value] of Object.entries(globals)) {
        previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
        Object.defineProperty(globalThis, name, { value, writable: true, configurable: true });
    }
    try { await run({ ...state, display }); }
    finally {
        for (const [name, descriptor] of previous) {
            if (descriptor) Object.defineProperty(globalThis, name, descriptor);
            else delete globalThis[name];
        }
    }
}

const audioStream = () => new Stream([new Track()]);
const recorderModule = () => import('../apps/ui/src/lib/screenRecorder.js');

test('audio recording mixes microphone and speaker streams without retranscribing speaker PCM', async () => {
    const { startScreenRecording } = await recorderModule();
    await withMedia(async state => {
        const microphone = audioStream(), speakers = audioStream();
        const recording = await startScreenRecording({ meetingId: 'meeting', mode: 'audio', micStream: microphone, systemStream: speakers, onSystemPcm: () => assert.fail('provided speaker audio is already transcribed') });
        assert.deepEqual(state.contexts[0].inputs, [speakers, microphone]);
        assert.equal(state.recorders[0].stream.getAudioTracks().length, 1);
        assert.equal(state.worklets.length, 0);
        assert.equal(recording.hasSystemAudio, true);
        assert.equal(recording.systemAudioSource, 'provided');
        const descriptor = await recording.stop();
        assert.equal(descriptor.hasSystemAudio, true);
        assert.equal(microphone.getTracks()[0].readyState, 'live');
        assert.equal(speakers.getTracks()[0].readyState, 'live');
        assert.deepEqual(state.closedFiles, ['recording']);
    });
});

test('speaker-only recording still works when microphone access was denied', async () => {
    const { startScreenRecording } = await recorderModule();
    await withMedia(async state => {
        const speakers = audioStream();
        const recording = await startScreenRecording({ meetingId: 'meeting', mode: 'audio', systemStream: speakers });
        assert.deepEqual(state.contexts[0].inputs, [speakers]);
        assert.equal(recording.hasSystemAudio, true);
        await recording.stop();
    });
});

test('display audio takes precedence over the supplied stream and alone supplies transcription fallback', async () => {
    const { startScreenRecording } = await recorderModule();
    const display = new Stream([new Track('video'), new Track()]);
    await withMedia(async state => {
        const microphone = audioStream(), speakers = audioStream(), heard = [];
        const recording = await startScreenRecording({ meetingId: 'meeting', mode: 'screen', micStream: microphone, systemStream: speakers, onSystemPcm: pcm => heard.push(pcm) });
        assert.equal(recording.systemAudioSource, 'display');
        assert.equal(state.contexts[0].inputs[0].getTracks()[0], display.getAudioTracks()[0]);
        assert.equal(state.contexts[0].inputs[1], microphone);
        assert.equal(state.contexts[0].inputs.includes(speakers), false);
        assert.equal(state.worklets.length, 1);
        state.worklets[0].port.onmessage({ data: new Float32Array([0.5]) });
        assert.equal(heard[0][0], 16383);
        await recording.stop();
        assert.equal(display.getTracks().every(track => track.readyState === 'ended'), true);
        assert.equal(speakers.getTracks()[0].readyState, 'live');
    }, { display });
});

test('screen capture without display audio includes the dedicated speaker stream', async () => {
    const { startScreenRecording } = await recorderModule();
    await withMedia(async state => {
        const speakers = audioStream();
        const recording = await startScreenRecording({ meetingId: 'meeting', mode: 'screen', systemStream: speakers });
        assert.deepEqual(state.contexts[0].inputs, [speakers]);
        assert.equal(recording.systemAudioSource, 'provided');
        assert.equal(state.recorders[0].stream.getVideoTracks().length, 1);
        await recording.stop();
    });
});

test('late display permission after cancellation closes owned tracks without opening a file', async () => {
    const { startScreenRecording } = await recorderModule();
    const permission = deferred(), waiting = deferred();
    await withMedia(async state => {
        const controller = new AbortController(), microphone = audioStream();
        const starting = startScreenRecording({ meetingId: 'meeting', micStream: microphone, signal: controller.signal });
        await waiting.promise;
        controller.abort(); permission.resolve(state.display);
        await assert.rejects(starting, { name: 'AbortError' });
        assert.equal(state.files.length, 0);
        assert.equal(state.display.getTracks()[0].readyState, 'ended');
        assert.equal(microphone.getTracks()[0].readyState, 'live');
    }, { devices: { getDisplayMedia: () => { waiting.resolve(); return permission.promise; } } });
});

test('cancellation during file startup closes the late file and audio graph', async () => {
    const { startScreenRecording } = await recorderModule();
    const opened = deferred(), waiting = deferred();
    await withMedia(async state => {
        const controller = new AbortController(), speakers = audioStream();
        const starting = startScreenRecording({ meetingId: 'meeting', mode: 'audio', systemStream: speakers, signal: controller.signal });
        await waiting.promise;
        controller.abort(); opened.resolve({ id: 'late-file', path: 'meeting/screen.webm' });
        await assert.rejects(starting, { name: 'AbortError' });
        assert.deepEqual(state.closedFiles, ['late-file']);
        assert.equal(state.contexts.every(context => context.state === 'closed'), true);
        assert.equal(state.recorders.length, 0);
        assert.equal(speakers.getTracks()[0].readyState, 'live');
    }, { recorderBridge: { start: () => { waiting.resolve(); return opened.promise; } } });
});

function systemBridge({ fails = false } = {}) {
    return {
        data: new Set(), statuses: new Set(), stopped: 0,
        available: async () => ({ available: true }),
        start: async () => { if (fails) throw new Error('Permission denied'); },
        async stop() { this.stopped += 1; },
        onData(listener) { this.data.add(listener); return () => this.data.delete(listener); },
        onStatus(listener) { this.statuses.add(listener); return () => this.statuses.delete(listener); },
        emit(pcm) { for (const listener of this.data) listener(new Uint8Array(pcm.buffer)); },
    };
}

test('native speaker PCM supplies a recording stream without playing audio to physical speakers', async () => {
    const { startSystemCapture } = await import('../apps/ui/src/lib/systemCapture.js');
    const bridge = systemBridge();
    await withMedia(async state => {
        const heard = [];
        const capture = await startSystemCapture({ includeStream: true, onPcm: pcm => heard.push(pcm) });
        bridge.emit(new Int16Array([16384, -32768]));
        const context = state.contexts[0];
        assert.equal(capture.stream, context.mediaDestination.stream);
        assert.deepEqual(Array.from(context.buffers[0].getChannelData(0)), [0.5, -1]);
        assert.deepEqual(context.gains[0].connections, [context.mediaDestination]);
        assert.deepEqual(context.bufferSources[0].connections, [context.gains[0]]);
        capture.setMuted(true);
        bridge.emit(new Int16Array([16384]));
        assert.equal(context.gains[0].gain.value, 0);
        assert.deepEqual(Array.from(heard[1]), [0]);
        await capture.stop();
        assert.equal(context.state, 'closed');
        assert.equal(capture.stream.getTracks()[0].readyState, 'ended');
        assert.equal(bridge.data.size, 0);
        assert.equal(bridge.stopped, 1);
    }, { systemBridge: bridge });
});

test('native speaker startup failure releases its recording stream and listeners', async () => {
    const { startSystemCapture } = await import('../apps/ui/src/lib/systemCapture.js');
    const bridge = systemBridge({ fails: true });
    await withMedia(async state => {
        await assert.rejects(startSystemCapture({ includeStream: true }), /Permission denied/);
        assert.equal(state.contexts[0].state, 'closed');
        assert.equal(state.contexts[0].mediaDestination.stream.getTracks()[0].readyState, 'ended');
        assert.equal(bridge.data.size, 0);
        assert.equal(bridge.statuses.size, 0);
    }, { systemBridge: bridge });
});

test('native PCM scheduling bounds queued audio and stops scheduled sources', async () => {
    const { createPcmMediaStream } = await import('../apps/ui/src/lib/pcmMediaStream.js');
    await withMedia(async state => {
        const stream = await createPcmMediaStream();
        for (let i = 0; i < 100; i += 1) stream.write(new Int16Array(1600));
        assert.equal(state.contexts[0].bufferSources.length, 4);
        const sources = state.contexts[0].bufferSources;
        assert.ok(sources.every((source, index) => index === 0 || source.startTime > sources[index - 1].startTime));
        await stream.stop();
        assert.equal(sources.every(source => source.stopped && source.disconnected), true);
        stream.write(new Int16Array(1600));
        assert.equal(sources.length, 4);
    });
});

test('failed PCM worklet initialization closes its AudioContext while preserving the caller stream', async () => {
    const { startPcmCapture } = await import('../apps/ui/src/lib/pcmCapture.js');
    await withMedia(async state => {
        const input = audioStream();
        await assert.rejects(startPcmCapture({ stream: input }), /Worklet unavailable/);
        assert.equal(state.contexts[0].state, 'closed');
        assert.equal(input.getTracks()[0].readyState, 'live');
    }, { workletError: 'Worklet unavailable' });
});

test('loopback-device capture exposes its original stream for recording', async () => {
    const { startSystemCapture } = await import('../apps/ui/src/lib/systemCapture.js');
    const input = audioStream();
    await withMedia(async () => {
        const capture = await startSystemCapture({ deviceId: 'loopback', includeStream: true });
        assert.equal(capture.stream, input);
        assert.equal(capture.source, 'device');
        await capture.stop();
        assert.equal(input.getTracks()[0].readyState, 'ended');
    }, { devices: { enumerateDevices: async () => [], getUserMedia: async () => input } });
});
