import React, { act, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { useMeetingSession } from '../../apps/ui/src/hooks/useMeetingSession.js';
import { useUnscheduledCallPrompt } from '../../apps/ui/src/hooks/useUnscheduledCallPrompt.js';
import { resetMocks, state } from './mocks.js';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function equal(actual, expected, message) {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    }
}

const flush = async fn => act(async () => { await fn?.(); await new Promise(resolve => setTimeout(resolve, 0)); });
let session;
let promptApi;
let promptEnabled = true;

function Probe() {
    session = useMeetingSession();
    return <output>{session.sessionState}</output>;
}

function CallProbe() {
    session = useMeetingSession();
    promptApi = useUnscheduledCallPrompt({
        enabled: promptEnabled,
        canRecord: session.connection === 'online' && ['idle', 'completed', 'error'].includes(session.sessionState),
        onStart: () => session.startMeeting('Calendar sync', { mode: 'audio', event: { id: 'calendar-sync', provider: 'google', title: 'Calendar sync', start: new Date().toISOString(), end: new Date(Date.now() + 1800000).toISOString(), attendees: [] } }),
    });
    useEffect(() => { session.setOnUnscheduledCall(promptApi.notifyUnscheduledCall); }, [session.setOnUnscheduledCall, promptApi.notifyUnscheduledCall]);
    return <output>{promptApi.callPrompt?.id || session.sessionState}</output>;
}

async function scenario(options, test) {
    resetMocks(options);
    const root = createRoot(document.getElementById('root'));
    let mounted = true;
    const unmount = async () => {
        await flush(() => root.unmount());
        mounted = false;
    };
    try {
        await flush(() => root.render(options.withPrompt ? <CallProbe /> : <Probe />));
        equal(session.connection, 'online', 'Fixture connects to its mock backend');
        await test({ unmount });
    } finally {
        if (mounted) await unmount();
    }
}

const cases = [
    ['detected browser calls start one audio recording with calendar metadata', () => scenario({ withPrompt: true, recordingSupported: true }, async () => {
        await flush(() => state.events({ type: 'unscheduled_call', data: { source: 'google-meet', url: 'https://meet.google.com/test-call', participants: ['Maya'] } }));
        const id = promptApi.callPrompt.id;
        let first;
        let duplicate;
        await flush(() => { first = promptApi.startCallPrompt(id); duplicate = promptApi.startCallPrompt(id); });
        equal(await first, true, 'Start succeeds');
        equal(await duplicate, false, 'Repeated Start is rejected');
        equal(state.requests.filter(request => request.path === '/api/meetings/start').length, 1, 'Exactly one meeting starts');
        const request = state.requests.find(request => request.path === '/api/meetings/start');
        equal(request.body.metadata.calendarEvent.id, 'calendar-sync', 'Calendar-covered calls can retain event metadata');
        equal(session.sessionState, 'recording', 'Start enters the existing recording flow');
        equal(promptApi.callPrompt, null, 'The prompt clears on startup');
        await flush(() => { state.mic[0].resolve(); state.system[0].resolve(); });
        equal(state.recorders[0].options.mode, 'audio', 'The prompt starts audio recording');
        await flush(() => session.stopMeeting());
    })],
    ['microphone-only detection prompts, retracts, and cleans up its subscription', async () => {
        let listener;
        let unsubscribed = 0;
        globalThis.kesamiShell = {};
        globalThis.kesamiMicUsage = { onEvent: fn => { listener = fn; return () => { listener = null; unsubscribed++; }; }, start: async () => {} };
        try {
            await scenario({ withPrompt: true }, async ({ unmount }) => {
                await flush(() => listener({ active: true }));
                equal(promptApi.callPrompt.source, 'microphone', 'Generic microphone activity is accepted');
                await flush(() => listener({ active: false }));
                equal(promptApi.callPrompt, null, 'Mic inactivity retracts the idle card');
                equal(state.requests.some(request => request.path === '/api/meetings/start'), false, 'Detection never starts recording itself');
                await unmount();
                equal(listener, null, 'Unmount removes the native listener');
                equal(unsubscribed, 1, 'The watcher subscription is removed once');
            });
        } finally { delete globalThis.kesamiMicUsage; delete globalThis.kesamiShell; }
    }],
    ['pause and resume keep pending microphone and system devices', () => scenario({}, async () => {
        await flush(() => session.startMeeting('Pause during startup'));
        equal([state.mic.length, state.system.length], [1, 1], 'Both devices start once');
        const mic = state.mic[0];
        const system = state.system[0];
        await flush(() => session.pauseMeeting());
        await flush(() => session.resumeMeeting());
        await flush(() => session.pauseMeeting());
        equal([state.mic.length, state.system.length], [1, 1], 'Pause/resume does not reacquire pending devices');
        await flush(() => { mic.resolve(); system.resolve(); });
        equal([mic.stopped, system.stopped], [0, 0], 'Pending devices remain owned when they become ready');
        equal([mic.muted, system.muted], [true, true], 'Ready handles adopt the current paused state');
        mic.emit(10);
        system.emit(20);
        equal(state.audio, [], 'Paused handles produce no transcription audio');
        await flush(() => session.resumeMeeting());
        mic.emit(11);
        system.emit(21);
        equal(state.audio, [{ stream: 0, pcm: [11] }, { stream: 1, pcm: [21] }], 'Resuming transcribes both original handles');
        await flush(() => session.stopMeeting());
        equal([mic.stopped, system.stopped], [1, 1], 'Stop closes each original device once');
    })],
    ['stopping pending capture discards late handles, audio and errors', () => scenario({ recordingSupported: true }, async () => {
        await flush(() => session.startMeeting('Stop during startup'));
        const mic = state.mic[0];
        const system = state.system[0];
        await flush(() => session.stopMeeting());
        mic.emitRaw(1);
        system.emitRaw(2);
        await flush(() => { mic.resolve(); system.resolve(); });
        await flush(() => { mic.fail('stale microphone failure'); system.fail('stale system failure'); });
        equal(session.sessionState, 'completed', 'Late capture completion cannot revive a stopped meeting');
        equal([mic.stopped, system.stopped], [1, 1], 'Both late handles are disposed');
        equal(state.audio, [], 'Late capture audio is not published');
        equal(state.recorders.length, 0, 'Late microphone readiness cannot start a recorder');
        equal([session.micError, session.systemAudioError], [null, null], 'Stale device errors are ignored');

        await flush(() => session.startMeeting('Next meeting'));
        await flush(() => { state.mic[1].resolve(); state.system[1].resolve(); });
        mic.emitRaw(3);
        system.emitRaw(4);
        state.mic[1].emit(5);
        state.system[1].emit(6);
        equal(state.audio, [{ stream: 0, pcm: [5] }, { stream: 1, pcm: [6] }], 'Only the next meeting owns transcription audio');
        equal(state.recorders.length, 1, 'The next meeting creates exactly one recorder');
        equal(state.recorders[0].options.meetingId, session.activeMeeting.id, 'The recorder belongs to the next meeting');
        await flush(() => session.stopMeeting());
    })],
    ['recorder audio takes over while native capture is silent or fails', () => scenario({ recordingSupported: true }, async () => {
        await flush(() => session.startMeeting('Native fallback', { mode: 'screen' }));
        const mic = state.mic[0];
        const system = state.system[0];
        await flush(() => { mic.resolve(); system.resolve(); });
        equal(state.recorders.length, 1, 'Recorder starts after both audio sources are ready');
        const recorder = state.recorders[0];
        recorder.emit(1);
        equal(state.audio, [{ stream: 1, pcm: [1] }], 'Recorder supplies system audio before native capture produces PCM');
        recorder.emit(2);
        system.emit(3);
        recorder.emit(4);
        equal(state.audio.map(packet => packet.pcm[0]), [1, 2, 3], 'Native capture suppresses duplicate recorder audio only after its first PCM');
        await flush(() => system.fail('Native system audio stopped'));
        equal(system.stopped, 1, 'Failed native source is closed');
        equal(session.systemAudioError, 'Native system audio stopped', 'The source failure is surfaced');
        system.emitRaw(40);
        recorder.emit(5);
        equal(state.audio.map(packet => packet.pcm[0]), [1, 2, 3, 5], 'Recorder fallback resumes and stale native callbacks are dropped');
        await flush(() => session.pauseMeeting());
        recorder.emit(6);
        equal(state.audio.length, 4, 'Pause mutes recorder fallback');
        await flush(() => session.resumeMeeting());
        recorder.emit(7);
        equal(state.audio.map(packet => packet.pcm[0]), [1, 2, 3, 5, 7], 'Resume restores fallback audio');
        await flush(() => session.stopMeeting());
        equal(recorder.stopped, 1, 'Stop finalizes the recorder exactly once');
    })],
    ['audio recording includes both microphone and speaker streams', () => scenario({ recordingSupported: true }, async () => {
        await flush(() => session.startMeeting('Both sides', { mode: 'audio' }));
        equal(state.system[0].options.includeStream, true, 'System capture exposes a stream for recording');
        await flush(() => state.mic[0].resolve());
        equal(state.recorders.length, 0, 'Audio recording waits for the speaker stream');
        await flush(() => state.system[0].resolve());
        equal(state.recorders.length, 1, 'Audio recording starts once both streams are ready');
        const recorder = state.recorders[0];
        equal(recorder.options.micStream.id, state.mic[0].handle.stream.id, 'Microphone reaches the audio recorder');
        equal(recorder.options.systemStream.id, state.system[0].handle.stream.id, 'Speaker output reaches the audio recorder');
        state.mic[0].emit(1);
        state.system[0].emit(2);
        equal(state.audio, [{ stream: 0, pcm: [1] }, { stream: 1, pcm: [2] }], 'Both channels reach live transcription');
        await flush(() => session.stopMeeting());
    })],
    ['microphone and speaker mute controls preserve the other channel', () => scenario({ recordingSupported: true }, async () => {
        await flush(() => session.startMeeting('Independent audio controls'));
        await flush(() => { state.mic[0].resolve(); state.system[0].resolve(); });
        const mic = state.mic[0];
        const system = state.system[0];
        const recorder = state.recorders[0];
        await flush(() => session.toggleMicMute());
        mic.emitRaw(1);
        system.emit(2);
        equal(state.audio, [{ stream: 1, pcm: [2] }], 'App microphone mute keeps speaker output transcribing');
        equal(recorder.micMuted, true, 'App microphone mute also applies to the recording');
        await flush(() => state.events({ type: 'mic_muted', data: { muted: true } }));
        await flush(() => session.toggleMicMute());
        mic.emitRaw(3);
        equal(recorder.micMuted, true, 'Meeting-client mute remains active when app mute is cleared');
        await flush(() => state.events({ type: 'mic_muted', data: { muted: false } }));
        await flush(() => session.toggleSystemAudioMute());
        mic.emit(4);
        system.emit(5);
        recorder.emit(6);
        equal(state.audio, [{ stream: 1, pcm: [2] }, { stream: 0, pcm: [4] }], 'Speaker mute keeps microphone transcription and silences recorder fallback');
        equal([recorder.micMuted, recorder.systemMuted], [false, true], 'Recorder follows both independent mute controls');
        await flush(() => session.stopMeeting());
    })],
    ['ending screen sharing saves its recording once when the meeting stops', () => scenario({ recordingSupported: true }, async () => {
        await flush(() => session.startMeeting('Share ended', { mode: 'screen' }));
        await flush(() => { state.mic[0].resolve(); state.system[0].resolve(); });
        const recorder = state.recorders[0];
        await flush(() => recorder.sourceEnded());
        equal(recorder.stopped, 1, 'Ending screen sharing finalizes the recording');
        equal(session.recordingState.active, false, 'Recording indicator clears after source end');
        equal(session.sessionState, 'recording', 'Live transcription can continue after screen sharing ends');
        await flush(() => session.stopMeeting());
        const stop = state.requests.find(request => request.path === '/api/meetings/stop');
        equal(stop.body.recording, { path: 'fixture-recording.webm', durationSeconds: 1 }, 'Finalized recording descriptor reaches the meeting stop API');
        equal(recorder.stopped, 1, 'Meeting stop does not finalize an already ended recording twice');
    })],
    ['stopping pending recording cancels and disposes a late recorder', () => scenario({ recordingSupported: true, deferredRecorder: true }, async () => {
        await flush(() => session.startMeeting('Stop pending recorder'));
        await flush(() => { state.mic[0].resolve(); state.system[0].resolve(); });
        equal(state.recorders.length, 1, 'Recorder startup is pending');
        const recorder = state.recorders[0];
        let stopping;
        await flush(() => { stopping = session.stopMeeting(); });
        equal(recorder.options.signal?.aborted, true, 'Stop aborts pending recorder startup');
        await flush(() => recorder.resolve());
        await flush(() => stopping);
        equal(recorder.stopped, 1, 'Late recorder is closed exactly once');
        equal(session.recordingState.active, false, 'Late recorder cannot revive the recording indicator');
        equal(session.sessionState, 'completed', 'Stopping completes after cancellation');
    })],
    ['unmounting pending recording cancels and disposes a late recorder', () => scenario({ recordingSupported: true, deferredRecorder: true }, async ({ unmount }) => {
        await flush(() => session.startMeeting('Unmount pending recorder'));
        await flush(() => { state.mic[0].resolve(); state.system[0].resolve(); });
        const recorder = state.recorders[0];
        await unmount();
        equal(recorder.options.signal?.aborted, true, 'Unmount aborts pending recorder startup');
        await flush(() => recorder.resolve());
        equal(recorder.stopped, 1, 'Recorder returned after unmount is closed');
        equal([state.mic[0].stopped, state.system[0].stopped], [1, 1], 'Unmount releases both audio devices');
    })],
    ['rejected native startup keeps recorder transcription available', () => scenario({ recordingSupported: true }, async () => {
        await flush(() => session.startMeeting('Permission denied'));
        await flush(() => { state.mic[0].resolve(); state.system[0].reject('System audio permission denied'); });
        equal(session.systemAudioError, 'System audio permission denied', 'Startup failure is surfaced');
        state.recorders[0].emit(9);
        equal(state.audio, [{ stream: 1, pcm: [9] }], 'Recorder transcribes after native startup rejection');
        await flush(() => session.stopMeeting());
    })],
    ['transcript events from another meeting cannot replace the current transcript', () => scenario({}, async () => {
        const live = [];
        const replaced = [];
        session.setOnLiveTurn(turn => live.push(turn));
        session.setOnTranscriptReplaced(turns => replaced.push(turns));
        await flush(() => session.startMeeting('Transcript ownership'));
        const meetingId = session.activeMeeting.id;
        await flush(() => { state.mic[0].resolve(); state.system[0].resolve(); });
        await flush(() => state.events({ type: 'transcript_interim', data: { meetingId, channel: 'mic', text: 'current draft' } }));
        await flush(() => {
            state.events({ type: 'transcript_turn', data: { meetingId: 'old-meeting', channel: 'mic', text: 'old final' } });
            state.events({ type: 'transcript_replaced', data: { meetingId: 'old-meeting', turns: [{ text: 'old transcript' }] } });
        });
        equal([live.length, replaced.length], [0, 0], 'Stale final and replacement callbacks are ignored');
        equal(session.interimTurns.map(turn => turn.text), ['current draft'], 'Stale events preserve the current interim');
        await flush(() => state.events({ type: 'transcript_turn', data: { meetingId, channel: 'mic', text: 'current final' } }));
        equal(live.map(turn => turn.text), ['current final'], 'Current final transcript reaches the UI');
        equal(session.interimTurns, [], 'Current final clears the matching interim');
        await flush(() => state.events({ type: 'transcript_replaced', data: { meetingId, turns: [{ text: 'current transcript' }] } }));
        equal(replaced.map(turns => turns.map(turn => turn.text)), [['current transcript']], 'Current replacement reaches the UI');
        await flush(() => session.stopMeeting());
    })],
];

window.runCaptureTests = async () => {
    const results = [];
    for (const [name, test] of cases) {
        try {
            await test();
            results.push({ name, passed: true });
        } catch (cause) {
            results.push({ name, passed: false, error: cause.stack || cause.message });
        }
    }
    return results;
};
