// Only the external boundaries are mocked. The fixture mounts the production
// useMeetingSession hook and its production capture controllers.
export { mapBackendState, mergeInterim, normalizeMeeting, normalizeTurn, STREAM_MIC, STREAM_SYSTEM } from '../../apps/ui/src/lib/backend.js';

export let state;

export function resetMocks({ recordingSupported = false, deferredRecorder = false } = {}) {
    state = {
        recordingSupported,
        deferredRecorder,
        mic: [],
        system: [],
        recorders: [],
        audio: [],
        requests: [],
        events: null,
        meeting: null,
        meetingNumber: 0,
        backendState: 'IDLE',
        settings: {},
    };
    return state;
}

export const getBackendUrl = () => 'http://fixture.invalid';
export const isRemoteBackend = () => false;

export function createBackendSocket({ onEvent, onConnectionChange }) {
    const current = state;
    current.events = onEvent;
    onConnectionChange('online');
    return {
        sendAudio: (stream, pcm) => current.audio.push({ stream, pcm: Array.from(pcm) }),
        close: () => { current.events = null; },
    };
}

export async function apiRequest(path, { method = 'GET', body } = {}) {
    state.requests.push({ path, method, body });
    switch (path) {
        case '/api/status': return { state: state.backendState, meetingId: state.meeting?.id };
        case '/api/settings':
            if (method === 'POST') Object.assign(state.settings, body.settings);
            return { success: true, settings: state.settings };
        case '/api/license/status': return { valid: true };
        case '/api/meetings/start':
            state.backendState = 'RECORDING';
            state.meeting = { id: `fixture-meeting-${++state.meetingNumber}`, title: body.title, transcript: [] };
            return { meeting: state.meeting };
        case '/api/meetings/pause': state.backendState = 'PAUSED'; return {};
        case '/api/meetings/resume': state.backendState = 'RECORDING'; return {};
        case '/api/meetings/stop': state.backendState = 'COMPLETED'; return { meeting: state.meeting };
        default:
            if (path === `/api/meetings/${state.meeting?.id}`) return { meeting: state.meeting };
            throw new Error(`Unexpected fixture request: ${method} ${path}`);
    }
}

function startCapture(kind, options) {
    let resolve;
    let reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    const attempt = {
        options,
        stopped: 0,
        muted: options.muted,
        processing: [],
        handle: null,
        resolve() { resolve(attempt.handle); },
        reject(message) { reject(new Error(message)); },
        // Emit raw simulates an already queued device callback after teardown.
        emitRaw(value) { options.onPcm(new Int16Array([value])); },
        emit(value) { if (!attempt.muted && !attempt.stopped) attempt.emitRaw(value); },
        fail(message) { options.onError(message); },
    };
    const track = { kind: 'audio', readyState: 'live' };
    attempt.handle = {
        stream: { id: `${kind}-${state[kind].length}`, getAudioTracks: () => [track] },
        source: kind === 'system' ? 'native' : undefined,
        setMuted(value) { attempt.muted = value; },
        async setProcessing(value) { attempt.processing.push(value); },
        async stop() { attempt.stopped += 1; },
    };
    state[kind].push(attempt);
    return promise;
}

export const startMicCapture = options => startCapture('mic', options);
export const startSystemCapture = options => startCapture('system', options);
export const DEFAULT_BITS_PER_SECOND = 1_000_000;
export const isRecordingSupported = () => state.recordingSupported;

export async function startScreenRecording(options) {
    const recorder = {
        options,
        mode: options.mode,
        hasSystemAudio: true,
        micMuted: false,
        systemMuted: false,
        stopped: 0,
        setMicMuted(value) { recorder.micMuted = value; },
        setSystemMuted(value) { recorder.systemMuted = value; },
        onSourceEnded(callback) { recorder.sourceEnded = callback; },
        emit(value) {
            if (!recorder.systemMuted && !recorder.stopped) options.onSystemPcm(new Int16Array([value]));
        },
        async stop() {
            recorder.stopped += 1;
            return { path: 'fixture-recording.webm', durationSeconds: 1 };
        },
    };
    state.recorders.push(recorder);
    if (!state.deferredRecorder) return recorder;
    // Deliberately resolve even if the signal was aborted: the hook must dispose
    // a handle returned by a device/library that completes after cancellation.
    return new Promise(resolve => { recorder.resolve = () => resolve(recorder); });
}
