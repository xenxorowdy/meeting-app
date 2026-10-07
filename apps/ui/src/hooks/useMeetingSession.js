import { useCallback, useEffect, useRef, useState } from 'react';
import {
    apiRequest,
    createBackendSocket,
    mapBackendState,
    mergeInterim,
    normalizeMeeting,
    normalizeTurn,
    STREAM_MIC,
    STREAM_SYSTEM,
} from '@/lib/backend';
import { calendarEventMetadata } from '@/lib/calendarEvents';
import { getBackendUrl, isRemoteBackend } from '@/lib/connection';
import { createLevelChannel } from '@/lib/levels';
import { createCaptureController } from '@/lib/captureController';
import { startMicCapture } from '@/lib/micCapture';
import { startSystemCapture } from '@/lib/systemCapture';
import { DEFAULT_BITS_PER_SECOND, isRecordingSupported, startScreenRecording } from '@/lib/screenRecorder';

export const SESSION_STATES = {
    IDLE: 'idle',
    RECORDING: 'recording',
    PAUSED: 'paused',
    PROCESSING: 'processing',
    COMPLETED: 'completed',
    ERROR: 'error',
};

const DEFAULT_SETTINGS = {
    micDeviceId: 'default',
    systemDeviceId: 'default',
    aiModel: 'gemini-2.5-flash',
    transcriptionProvider: 'sarvam-realtime',
    sarvamLanguage: 'unknown',
    sarvamMode: 'transcribe',
    sarvamNumSpeakers: null,
    sarvamDiarizeAfterMeeting: true,
    autoSummarize: true,
    echoSuppression: true,
    noiseSuppression: true,
    // Read-only: the backend reports whether a key is stored, never the key.
    geminiApiKeySet: false,
    openaiApiKeySet: false,
    sarvamApiKeySet: false,
    recordScreen: false,
    // 'ask' opens the picker on every start; a source id records that one
    // silently next time.
    recordingSource: 'ask',
    recordingBitsPerSecond: DEFAULT_BITS_PER_SECOND,
    meetingReminders: true,
    autoRecordMeetings: true,
    floatingWidget: true,
    autoStopOnMeetingEnd: true,
    promptForUnscheduledCalls: true,
};

const clampLevel = value => Math.max(0, Math.min(100, Math.round(Number(value) || 0)));

/**
 * Session state for the live meeting, driven entirely by the core backend over
 * its WebSocket and REST API. Nothing here fabricates a session: if the backend
 * is unreachable the hook reports that instead of playing a canned meeting.
 */
export function useMeetingSession() {
    const [connection, setConnection] = useState('connecting');
    const [sessionState, setSessionState] = useState(SESSION_STATES.IDLE);
    const [activeMeeting, setActiveMeeting] = useState(null);
    const [isGeneratingSummary, setIsGeneratingSummary] = useState(false);
    const [durationSeconds, setDurationSeconds] = useState(0);
    const [systemAudioSeen, setSystemAudioSeen] = useState(false);
    const [interimTurns, setInterimTurns] = useState([]);
    const [micMuted, setMicMuted] = useState(false);
    // The meeting client's own mute state, reported by the browser extension.
    // While it is true the microphone is not recorded and not transcribed.
    const [clientMicMuted, setClientMicMuted] = useState(false);
    const [systemAudioMuted, setSystemAudioMuted] = useState(false);
    const [error, setError] = useState(null);
    const [stopFailed, setStopFailed] = useState(false);
    const [micError, setMicError] = useState(null);
    const [systemAudioError, setSystemAudioError] = useState(null);
    const [settings, setSettings] = useState(DEFAULT_SETTINGS);
    const [license, setLicense] = useState(null);
    const [engine, setEngine] = useState(null);
    const [liveRoster, setLiveRoster] = useState([]);
    const [meetingClient, setMeetingClient] = useState(null);

    const [recordingState, setRecordingState] = useState({ active: false, mode: null, hasSystemAudio: false, error: null });
    // The mic stream has to be state, not just a ref: the screen recording mixes it
    // in, and it only exists once the capture effect below has run.
    const [micStream, setMicStream] = useState(null);
    const [systemStream, setSystemStream] = useState(null);

    const levelsRef = useRef(null);
    if (!levelsRef.current) levelsRef.current = createLevelChannel();
    const levels = levelsRef.current;
    const systemAudioSeenRef = useRef(false);

    const socketRef = useRef(null);
    const captureRef = useRef(null);
    const systemCaptureRef = useRef(null);
    const systemSourceRef = useRef(null);
    const micControllerRef = useRef(null);
    const systemControllerRef = useRef(null);
    if (!micControllerRef.current) micControllerRef.current = createCaptureController(startMicCapture);
    if (!systemControllerRef.current) systemControllerRef.current = createCaptureController(startSystemCapture);
    const capturing = sessionState === SESSION_STATES.RECORDING || sessionState === SESSION_STATES.PAUSED;
    const recorderRef = useRef(null);
    const recorderStartRef = useRef(null);
    const recorderGenerationRef = useRef(0);
    const recorderAbortRef = useRef(null);
    const summaryRequestRef = useRef(null);
    const finishedRecordingRef = useRef(null);
    const startingRef = useRef(false);
    const stopPromiseRef = useRef(null);
    const pendingStopRef = useRef(null);
    const updateQueueRef = useRef(Promise.resolve());
    const captureMuteRef = useRef({ mic: false, system: false });
    // Effective mic mute folds in the meeting client's mute: muting in Zoom or
    // Meet has to keep the microphone out of the recording and the transcript.
    captureMuteRef.current = {
        mic: micMuted || clientMicMuted || sessionState === SESSION_STATES.PAUSED,
        system: systemAudioMuted || sessionState === SESSION_STATES.PAUSED,
    };
    // Set when a meeting starts with recording enabled, consumed by the effect that
    // waits for the microphone before opening the file.
    const pendingRecordingRef = useRef(null);
    const activeMeetingIdRef = useRef(null);
    const callbacksRef = useRef({ onLiveTurn: null, onMeetingCompleted: null, onTranscriptReplaced: null, onMeetingEnded: null, onUnscheduledCall: null });
    // startMeeting reads settings at the moment it runs; a ref keeps it from being
    // rebuilt (and its callers re-rendered) every time a setting changes.
    const settingsRef = useRef(settings);
    settingsRef.current = settings;

    const onCalendarConnectionRef = useRef(null);
    const onConnectorConnectionRef = useRef(null);

    const setOnLiveTurn = useCallback(fn => {
        callbacksRef.current.onLiveTurn = fn;
    }, []);

    const setOnTranscriptReplaced = useCallback(fn => {
        callbacksRef.current.onTranscriptReplaced = fn;
    }, []);

    const setOnCalendarConnection = useCallback(fn => {
        onCalendarConnectionRef.current = fn;
    }, []);

    const setOnConnectorConnection = useCallback(fn => {
        onConnectorConnectionRef.current = fn;
    }, []);

    const setOnMeetingCompleted = useCallback(fn => {
        callbacksRef.current.onMeetingCompleted = fn;
    }, []);

    const setOnMeetingEnded = useCallback(fn => {
        callbacksRef.current.onMeetingEnded = fn;
    }, []);

    const setOnUnscheduledCall = useCallback(fn => {
        callbacksRef.current.onUnscheduledCall = fn;
    }, []);

    const adoptMeeting = useCallback(raw => {
        const meeting = normalizeMeeting(raw);
        activeMeetingIdRef.current = meeting?.id || null;
        setActiveMeeting(meeting);
        return meeting;
    }, []);

    const applyStatus = useCallback(
        async status => {
            if (!status) return;

            setSessionState(pendingStopRef.current ? SESSION_STATES.PROCESSING : mapBackendState(status.state));
            if (typeof status.durationSeconds === 'number') setDurationSeconds(status.durationSeconds);
            if (status.audioLevels) {
                levels.publish({ mic: clampLevel(status.audioLevels.mic), system: clampLevel(status.audioLevels.system) });
            }
            setLiveRoster(Array.isArray(status.participants?.names) ? status.participants.names : []);
            setMeetingClient(status.meetingClient || null);

            const meetingId = status.meetingId || status.currentMeeting?.id || null;
            if (meetingId && meetingId !== activeMeetingIdRef.current) {
                try {
                    const detail = await apiRequest(`/api/meetings/${meetingId}`);
                    adoptMeeting(detail.meeting);
                } catch {
                    // The list endpoint still works; a failed detail fetch is not fatal.
                }
            }
        },
        [adoptMeeting, levels]
    );

    const applyInterim = useCallback(data => {
        setInterimTurns(previous => mergeInterim(previous, data));
    }, []);

    const mergeNote = useCallback((meetingId, note) => {
        if (!note?.id) return;
        setActiveMeeting(prev => {
            if (!prev || prev.id !== meetingId) return prev;
            const notes = prev.notes || [];
            if (notes.some(existing => existing.id === note.id)) return prev;
            return { ...prev, notes: [...notes, note] };
        });
    }, []);

    const mergeDelivery = useCallback((meetingId, delivery) => {
        if (!delivery?.provider) return;
        setActiveMeeting(prev => {
            if (!prev || prev.id !== meetingId) return prev;
            const metadata = prev.metadata || {};
            return {
                ...prev,
                metadata: { ...metadata, connectorDeliveries: { ...(metadata.connectorDeliveries || {}), [delivery.provider]: delivery } },
            };
        });
    }, []);

    const handleEvent = useCallback(
        message => {
            const { type, data } = message;

            if (type === 'note_added') {
                mergeNote(data?.meetingId, data?.note);
                return;
            }

            if (type === 'calendar_connection') {
                onCalendarConnectionRef.current?.(data);
                return;
            }

            if (type === 'connector_connection') {
                onConnectorConnectionRef.current?.(data);
                return;
            }

            if (type === 'connector_delivery') {
                mergeDelivery(data?.meetingId, data?.delivery);
                if (data?.automatic && data.delivery && !data.delivery.ok) {
                    setError(`Automatic send failed. ${data.delivery.error || 'The connector did not accept the meeting.'}`);
                }
                return;
            }

            switch (type) {
                case 'connection_established':
                case 'status_update':
                    // The handshake carries `status`; get_status replies carry `data`.
                    applyStatus(message.status || data);
                    break;

                case 'state_change':
                    setSessionState(pendingStopRef.current ? SESSION_STATES.PROCESSING : mapBackendState(data?.newState || data?.to));
                    break;

                case 'meeting_started':
                    systemAudioSeenRef.current = false;
                    setSystemAudioSeen(false);
                    adoptMeeting(data);
                    setDurationSeconds(0);
                    setInterimTurns([]);
                    setError(null);
                    break;

                case 'meeting_completed': {
                    const meeting = adoptMeeting(data);
                    setInterimTurns([]);
                    if (meeting && callbacksRef.current.onMeetingCompleted) {
                        callbacksRef.current.onMeetingCompleted(meeting);
                    }
                    break;
                }

                case 'transcript_interim':
                    if (!data?.meetingId || data.meetingId === activeMeetingIdRef.current) applyInterim(data);
                    break;

                case 'transcript_turn': {
                    if (data?.meetingId && data.meetingId !== activeMeetingIdRef.current) break;
                    const turn = normalizeTurn(data);
                    setInterimTurns(previous => previous.filter(entry => entry.stream !== turn.stream));
                    if (callbacksRef.current.onLiveTurn) {
                        callbacksRef.current.onLiveTurn(turn);
                    }
                    break;
                }

                case 'transcript_replaced':
                    if (data?.meetingId && data.meetingId !== activeMeetingIdRef.current) break;
                    setInterimTurns([]);
                    if (callbacksRef.current.onTranscriptReplaced) {
                        callbacksRef.current.onTranscriptReplaced((Array.isArray(data?.turns) ? data.turns : []).map(normalizeTurn));
                    }
                    break;

                case 'audio_level': {
                    const mic = clampLevel(data?.mic);
                    const system = clampLevel(data?.system);
                    levels.publish({ mic, system });
                    if (system > 0 && !systemAudioSeenRef.current) {
                        systemAudioSeenRef.current = true;
                        setSystemAudioSeen(true);
                    }
                    break;
                }

                case 'mic_muted':
                    setClientMicMuted(Boolean(data?.muted));
                    break;

                case 'meeting_ended':
                    callbacksRef.current.onMeetingEnded?.(data?.source || '', data?.reason || 'ended');
                    break;

                case 'unscheduled_call':
                    callbacksRef.current.onUnscheduledCall?.({
                        source: data?.source || '',
                        url: data?.url || '',
                        participants: Array.isArray(data?.participants) ? data.participants : [],
                    });
                    break;

                case 'error':
                case 'warning':
                    setError(data?.message || data?.error || message.message || 'The backend reported a problem.');
                    break;

                default:
                    break;
            }
        },
        [adoptMeeting, applyInterim, applyStatus, levels, mergeNote, mergeDelivery]
    );

    // Backend socket: one connection for the lifetime of the window.
    useEffect(() => {
        const socket = createBackendSocket({ onEvent: handleEvent, onConnectionChange: setConnection });
        socketRef.current = socket;
        return () => {
            socket.close();
            socketRef.current = null;
        };
    }, [handleEvent]);

    // Everything the UI needs that isn't pushed over the socket.
    const refresh = useCallback(async () => {
        try {
            const [status, storedSettings, licenseStatus] = await Promise.all([
                apiRequest('/api/status'),
                apiRequest('/api/settings').catch(() => ({ settings: {} })),
                apiRequest('/api/license/status').catch(() => undefined),
            ]);

            await applyStatus(status);
            setSettings(prev => ({ ...prev, ...(storedSettings?.settings || {}) }));
            if (licenseStatus) setLicense(licenseStatus);
            setEngine(status);
            if (!pendingStopRef.current) setError(null);
        } catch (cause) {
            setError(cause.message);
        }
    }, [applyStatus]);

    useEffect(() => {
        if (connection === 'online') refresh();
    }, [connection, refresh]);

    useEffect(() => {
        if (connection !== 'online') return;
        const controller = new AbortController();
        const updatePlan = async () => {
            try {
                const status = await apiRequest('/api/license/status', { signal: controller.signal });
                if (!controller.signal.aborted) setLicense(status);
            } catch { /* Keep the last confirmed plan during a connection outage. */ }
        };
        window.addEventListener('focus', updatePlan);
        const timer = setInterval(updatePlan, 60000);
        return () => { controller.abort(); clearInterval(timer); window.removeEventListener('focus', updatePlan); };
    }, [connection]);

    useEffect(() => {
        if (sessionState !== SESSION_STATES.RECORDING) setInterimTurns([]);
    }, [sessionState]);

    useEffect(() => {
        if (sessionState !== SESSION_STATES.RECORDING && sessionState !== SESSION_STATES.PAUSED) return undefined;
        const timer = setInterval(() => socketRef.current?.send('get_status'), 5000);
        return () => clearInterval(timer);
    }, [sessionState]);

    // Pausing and muting keep the same devices open. Device changes and stop
    // invalidate pending permission prompts before replacing their handles.
    useEffect(() => {
        if (!capturing) { levels.reset(); return; }
        micControllerRef.current.start({
            deviceId: settings.micDeviceId,
            muted: captureMuteRef.current.mic,
            noiseSuppression: settingsRef.current.noiseSuppression !== false,
            echoCancellation: settingsRef.current.echoSuppression !== false,
            onPcm: pcm => {
                // A muted microphone — in the app or in the meeting client —
                // sends nothing to the backend, so nothing can be transcribed.
                if (captureMuteRef.current.mic) return;
                socketRef.current?.sendAudio(STREAM_MIC, pcm);
            },
            onReady: capture => {
                captureRef.current = capture;
                capture.setMuted(captureMuteRef.current.mic);
                setMicStream(capture.stream);
                setMicError(null);
            },
            onError: message => { captureRef.current = null; setMicStream(null); setMicError(message); },
        });
        return () => {
            captureRef.current = null;
            setMicStream(null);
            micControllerRef.current.stop().catch(() => {});
        };
    }, [capturing, settings.micDeviceId, levels]);

    useEffect(() => {
        if (!capturing) return;
        // Until the dedicated source is ready, recording PCM may still supply
        // meeting audio. Only an active source suppresses that fallback.
        systemControllerRef.current.start({
            deviceId: settings.systemDeviceId,
            includeStream: true,
            muted: captureMuteRef.current.system,
            onPcm: pcm => {
                if (captureMuteRef.current.system) return;
                systemSourceRef.current = systemCaptureRef.current?.source || 'system';
                socketRef.current?.sendAudio(STREAM_SYSTEM, pcm);
            },
            onReady: capture => {
                systemCaptureRef.current = capture;
                setSystemStream(capture.stream || null);
                capture.setMuted(captureMuteRef.current.system);
                setSystemAudioError(null);
            },
            onError: message => {
                systemCaptureRef.current = null;
                systemSourceRef.current = null;
                setSystemStream(null);
                setSystemAudioError(message);
            },
        });
        return () => {
            systemCaptureRef.current = null;
            systemSourceRef.current = null;
            setSystemStream(null);
            systemControllerRef.current.stop().catch(() => {});
        };
    }, [capturing, settings.systemDeviceId]);

    useEffect(() => {
        const capture = captureRef.current;
        if (!capture) return;
        let cancelled = false;
        capture.setProcessing({
            noiseSuppression: settings.noiseSuppression !== false,
            echoCancellation: settings.echoSuppression !== false,
        }).catch(cause => { if (!cancelled) setError(cause.message || 'Could not update microphone filtering.'); });
        return () => { cancelled = true; };
    }, [micStream, settings.noiseSuppression, settings.echoSuppression]);

    useEffect(() => {
        if (captureRef.current) {
            captureRef.current.setMuted(captureMuteRef.current.mic);
        }
        recorderRef.current?.setMicMuted(captureMuteRef.current.mic);
    }, [micMuted, clientMicMuted, sessionState]);

    // Resolve both inputs before opening the mix. Audio-only files need the
    // dedicated speaker stream too, including when microphone access was denied.
    useEffect(() => {
        const pending = pendingRecordingRef.current;
        if (!pending || sessionState !== SESSION_STATES.RECORDING) return;
        if (!micStream && !micError) return;
        if (!systemStream && !systemAudioError) return;

        pendingRecordingRef.current = null;
        const generation = ++recorderGenerationRef.current;
        const controller = new AbortController();
        recorderAbortRef.current = controller;
        const current = () => generation === recorderGenerationRef.current && !controller.signal.aborted;

        recorderStartRef.current = startScreenRecording({
            meetingId: pending.meetingId,
            sourceId: pending.sourceId,
            mode: pending.mode,
            micStream,
            systemStream,
            signal: controller.signal,
            bitsPerSecond: settingsRef.current.recordingBitsPerSecond,
            onSystemPcm: pcm => {
                if (!current() || systemSourceRef.current || captureMuteRef.current.system) return;
                if (socketRef.current) socketRef.current.sendAudio(STREAM_SYSTEM, pcm);
            },
            onError: message => { if (current()) setRecordingState(prev => ({ ...prev, error: message })); },
        })
            .then(async handle => {
                if (!current()) { await handle.stop(); return; }
                recorderRef.current = handle;
                handle.setMicMuted(captureMuteRef.current.mic);
                handle.setSystemMuted(captureMuteRef.current.system);
                setRecordingState({ active: true, mode: handle.mode, hasSystemAudio: handle.hasSystemAudio, error: null });
                // Stopping the share from the OS overlay ends capture without
                // going through our own stop path.
                handle.onSourceEnded(() => {
                    if (!current() || recorderRef.current !== handle) return;
                    recorderRef.current = null;
                    finishedRecordingRef.current = handle.stop().catch(cause => {
                        if (current()) setError(`Could not finish the recording: ${cause.message}`);
                        return null;
                    });
                    setRecordingState(prev => ({ ...prev, active: false, hasSystemAudio: false }));
                });
            })
            .catch(cause => {
                if (!current()) return;
                // A denied permission or a missing encoder must not stop the
                // meeting from being transcribed, so this only reports.
                setRecordingState({ active: false, hasSystemAudio: false, error: cause.message });
                setError(`Recording did not start: ${cause.message}`);
            });
    }, [sessionState, micStream, micError, systemStream, systemAudioError]);

    // Muting meeting audio has to stop it reaching the transcriber too, not just
    // the level meter, or a muted meeting still gets transcribed.
    useEffect(() => {
        const muted = systemAudioMuted || sessionState === SESSION_STATES.PAUSED;
        systemCaptureRef.current?.setMuted(muted);
        if (recorderRef.current) {
            recorderRef.current.setSystemMuted(muted);
        }
    }, [systemAudioMuted, sessionState]);

    useEffect(
        () => () => {
            recorderGenerationRef.current += 1;
            recorderAbortRef.current?.abort();
            pendingRecordingRef.current = null;
            if (recorderRef.current) {
                recorderRef.current.stop().catch(() => {});
                recorderRef.current = null;
            }
        },
        []
    );

    const startMeeting = useCallback(
        async (title, { sourceId = null, event = null, mode = 'audio' } = {}) => {
        if (startingRef.current || pendingStopRef.current || stopPromiseRef.current) return null;
        setError(null);
        setMicError(null);
        setSystemAudioError(null);
        setClientMicMuted(false);
        systemAudioSeenRef.current = false;
            setSystemAudioSeen(false);
            setRecordingState({ active: false, mode, hasSystemAudio: false, error: null });
            if (settingsRef.current.transcriptionProvider === 'sarvam' && (isRemoteBackend() || settingsRef.current.supportsLocalRecording === false)) {
                setError('Choose live transcription in Settings to record with a hosted workspace.');
                return null;
            }
            if (settingsRef.current.transcriptionProvider === 'sarvam' && !isRecordingSupported(mode)) {
                setError('Sarvam batch transcription needs the Kesami desktop app so it can capture the complete meeting audio.');
                return null;
            }
            startingRef.current = true;
            try {
                finishedRecordingRef.current = null;
                const calendarEvent = calendarEventMetadata(event);
                const response = await apiRequest('/api/meetings/start', {
                    method: 'POST',
                    body: {
                        title: title || event?.title || `Meeting ${new Date().toLocaleString()}`,
                        ...(calendarEvent ? { metadata: { calendarEvent } } : {}),
                    },
                });
                const meeting = adoptMeeting(response.meeting);
                setSessionState(SESSION_STATES.RECORDING);
                setDurationSeconds(0);

                // Queue the recording rather than starting it here: the mixed
                // recording needs the microphone track, and the capture effect
                // that opens it has not run yet at this point. Starting now would
                // silently produce a recording with the meeting audio but none of
                // the user's own voice.
                if (isRecordingSupported(mode) && meeting) {
                    pendingRecordingRef.current = { meetingId: meeting.id, sourceId, mode };
                }

                return meeting;
            } catch (cause) {
                setError(cause.message);
                return null;
            } finally {
                startingRef.current = false;
            }
        },
        [adoptMeeting]
    );

    const pauseMeeting = useCallback(async () => {
        try {
            await apiRequest('/api/meetings/pause', { method: 'POST', body: {} });
            setSessionState(SESSION_STATES.PAUSED);
        } catch (cause) {
            setError(cause.message);
        }
    }, []);

    const resumeMeeting = useCallback(async () => {
        try {
            await apiRequest('/api/meetings/resume', { method: 'POST', body: {} });
            setSessionState(SESSION_STATES.RECORDING);
        } catch (cause) {
            setError(cause.message);
        }
    }, []);

    const stopMeeting = useCallback(
        (turns = []) => {
            if (stopPromiseRef.current) return stopPromiseRef.current;
            if (!pendingStopRef.current && !activeMeetingIdRef.current) return Promise.resolve(null);
            if (!pendingStopRef.current) {
                pendingStopRef.current = {
                    meetingId: activeMeetingIdRef.current,
                    recording: null,
                    transcript: turns.map(turn => ({
                        id: turn.id,
                        channel: turn.stream || turn.channel || 'system',
                        speaker: turn.speaker,
                        startMs: turn.startMs,
                        endMs: turn.endMs,
                        text: turn.text,
                        confidence: turn.confidence ?? 1,
                    })),
                };
            }
            const pending = pendingStopRef.current;
            setStopFailed(false);
            setError(null);
            setSessionState(SESSION_STATES.PROCESSING);
            setInterimTurns([]);
            // A meeting stopped before the recorder ever opened must not leave a
            // request behind for the next one to pick up.
            pendingRecordingRef.current = null;
            recorderGenerationRef.current += 1;
            recorderAbortRef.current?.abort();
            recorderStartRef.current = null;

            // Finish the recording before telling the backend the meeting is over,
            // so its path and duration can be stored on the same record.
            const finish = async () => {
            if (finishedRecordingRef.current) {
                pending.recording = await finishedRecordingRef.current;
                finishedRecordingRef.current = null;
            }
            if (recorderRef.current) {
                const handle = recorderRef.current;
                recorderRef.current = null;
                pending.recording = await handle.stop().catch(cause => {
                    setRecordingState(prev => ({ ...prev, error: cause.message }));
                    return null;
                });
            }
            setRecordingState(prev => ({ ...prev, active: false, hasSystemAudio: false }));

            try {
                const response = await apiRequest('/api/meetings/stop', {
                    method: 'POST',
                    body: {
                        ...pending,
                        recording: isRemoteBackend() || settingsRef.current.supportsLocalRecording === false ? null : pending.recording,
                    },
                });

                if (!response.meeting || response.meeting.id !== pending.meetingId) {
                    throw new Error('The workspace did not confirm saving this meeting.');
                }
                const meeting = adoptMeeting(response.meeting);
                pendingStopRef.current = null;
                setSessionState(SESSION_STATES.COMPLETED);
                if (meeting && callbacksRef.current.onMeetingCompleted) {
                    callbacksRef.current.onMeetingCompleted(meeting);
                }
                return meeting;
            } catch (cause) {
                setError(`Recording stopped, but the meeting could not be saved. ${cause.message}`);
                setStopFailed(true);
                setSessionState(SESSION_STATES.PROCESSING);
                return null;
            }
            };
            stopPromiseRef.current = finish().finally(() => { stopPromiseRef.current = null; });
            return stopPromiseRef.current;
        },
        [adoptMeeting]
    );

    const loadMeeting = useCallback(
        async meetingOrId => {
            const id = typeof meetingOrId === 'string' ? meetingOrId : meetingOrId?.id;
            if (!id || [SESSION_STATES.RECORDING, SESSION_STATES.PAUSED, SESSION_STATES.PROCESSING].includes(sessionState)) return null;

            setInterimTurns([]);
            try {
                const detail = await apiRequest(`/api/meetings/${id}`);
                const meeting = adoptMeeting(detail.meeting);
                setSessionState(SESSION_STATES.IDLE);
                setDurationSeconds(meeting?.durationSeconds || 0);
                return meeting;
            } catch (cause) {
                setError(cause.message);
                return null;
            }
        },
        [adoptMeeting, sessionState]
    );

    const regenerateSummary = useCallback(async meetingId => {
        if (!meetingId) return { ok: false, message: 'Open a meeting before regenerating its summary.' };
        if (summaryRequestRef.current) {
            if (summaryRequestRef.current.meetingId !== meetingId) {
                return { ok: false, message: 'Another meeting summary is already being generated.' };
            }
            try {
                await apiRequest(`/api/meetings/${meetingId}/summarize/cancel`, { method: 'POST' });
                return { ok: false, cancelled: true };
            } catch (cause) {
                setError(cause.message);
                return { ok: false, message: cause.message };
            }
        }

        const request = { meetingId };
        summaryRequestRef.current = request;
        setError(null);
        setIsGeneratingSummary(true);
        try {
            const response = await apiRequest(`/api/meetings/${meetingId}/summarize`, {
                method: 'POST',
                body: { regenerate: true },
            });
            const summary = response?.summary;
            if (!response?.success || !summary) throw new Error('The backend did not return a meeting summary.');
            setActiveMeeting(current =>
                current?.id === meetingId
                    ? {
                          ...current,
                          summaryMarkdown: summary.rawMarkdown || '',
                          summarySections: summary.sections || [],
                          actionItems: summary.actionItems || [],
                          keyDecisions: summary.keyDecisions || [],
                          topics: summary.topics || [],
                          emailDraft: summary.emailDraft || '',
                      }
                    : current
            );
            if (summary.warning) setError(`A basic summary was used because AI generation failed: ${summary.warning}`);
            return { ok: true, warning: summary.warning || null };
        } catch (cause) {
            if (cause.status === 409 && cause.message.includes('stopped')) return { ok: false, cancelled: true };
            setError(cause.message);
            return { ok: false, message: cause.message };
        } finally {
            if (summaryRequestRef.current === request) {
                summaryRequestRef.current = null;
                setIsGeneratingSummary(false);
            }
        }
    }, []);

    const addNote = useCallback(
        async text => {
            const meetingId = activeMeetingIdRef.current;
            if (!meetingId) return { ok: false, message: 'Start a recording before taking notes.' };
            try {
                const response = await apiRequest(`/api/meetings/${meetingId}/notes`, { method: 'POST', body: { text } });
                mergeNote(meetingId, response?.note);
                return { ok: true, note: response?.note };
            } catch (cause) {
                return { ok: false, message: cause.message };
            }
        },
        [mergeNote]
    );

    const deleteNote = useCallback(async noteId => {
        const meetingId = activeMeetingIdRef.current;
        if (!meetingId) return { ok: false };
        try {
            await apiRequest(`/api/meetings/${meetingId}/notes/${noteId}`, { method: 'DELETE' });
            setActiveMeeting(prev => (prev && prev.id === meetingId ? { ...prev, notes: (prev.notes || []).filter(note => note.id !== noteId) } : prev));
            return { ok: true };
        } catch (cause) {
            return { ok: false, message: cause.message };
        }
    }, []);

    const updateActiveMeeting = useCallback(updates => {
        const meetingId = activeMeetingIdRef.current;
        if (!meetingId) return Promise.resolve({ ok: false, message: 'Select a meeting to edit.' });
        const save = async () => {
            try {
                const response = await apiRequest(`/api/meetings/${meetingId}`, { method: 'PATCH', body: updates });
                if (!response.meeting) throw new Error('The workspace did not confirm saving your changes.');
                const meeting = normalizeMeeting(response.meeting);
                setActiveMeeting(current => current?.id === meetingId ? meeting : current);
                return { ok: true, meeting };
            } catch (cause) {
                setError(`Could not save your changes. ${cause.message}`);
                return { ok: false, message: cause.message };
            }
        };
        updateQueueRef.current = updateQueueRef.current.then(save, save);
        return updateQueueRef.current;
    }, []);

    const updateCommitments = useCallback((commitmentId = null, review = {}) => {
        const meetingId = activeMeetingIdRef.current;
        if (!meetingId) return Promise.resolve({ ok: false, message: 'Select a meeting first.' });
        const save = async () => {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 15000);
            try {
                const path = `/api/meetings/${encodeURIComponent(meetingId)}/commitments${commitmentId ? `/${encodeURIComponent(commitmentId)}` : ''}`;
                const response = await apiRequest(path, { method: commitmentId ? 'PATCH' : 'POST', body: review, signal: controller.signal });
                if (!response.meeting) throw new Error('Kesami did not confirm saving your review.');
                const meeting = normalizeMeeting(response.meeting);
                setActiveMeeting(current => current?.id === meetingId ? meeting : current);
                return { ok: true, meeting };
            } catch (cause) { return { ok: false, message: controller.signal.aborted ? 'Saving took too long. Reload commitments to check the saved state, then retry.' : cause.message }; }
            finally { clearTimeout(timer); }
        };
        updateQueueRef.current = updateQueueRef.current.then(save, save);
        return updateQueueRef.current;
    }, []);

    const updatePostMeetingAction = useCallback((actionId, review) => {
        const meetingId = activeMeetingIdRef.current;
        if (!meetingId) return Promise.resolve({ ok: false, message: 'Select a meeting first.' });
        const save = async () => {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 45000);
            try {
                const response = await apiRequest(`/api/meetings/${encodeURIComponent(meetingId)}/actions/${encodeURIComponent(actionId)}`, { method: 'POST', body: review, signal: controller.signal });
                if (!response.meeting) throw new Error('No action receipt was returned. Reload actions before retrying.');
                const meeting = normalizeMeeting(response.meeting);
                setActiveMeeting(current => current?.id === meetingId ? meeting : current);
                return { ok: true, meeting };
            } catch (cause) { return { ok: false, message: controller.signal.aborted ? 'The request timed out. Reload actions to check the saved result before retrying.' : cause.message }; }
            finally { clearTimeout(timer); }
        };
        updateQueueRef.current = updateQueueRef.current.then(save, save);
        return updateQueueRef.current;
    }, []);

    const renameSpeaker = useCallback(
        async (currentName, nextName) => {
            const meetingId = activeMeetingIdRef.current;
            const cleaned = String(nextName || '').trim();
            if (!meetingId || !currentName || !cleaned) {
                return { ok: false, message: 'Enter a speaker name.' };
            }
            try {
                const response = await apiRequest(`/api/meetings/${meetingId}`, {
                    method: 'PATCH',
                    body: { speakerRenames: { [currentName]: cleaned } },
                });
                const meeting = adoptMeeting(response.meeting);
                return { ok: true, meeting };
            } catch (cause) {
                setError(cause.message);
                return { ok: false, message: cause.message };
            }
        },
        [adoptMeeting]
    );

    const changeTurnSpeaker = useCallback(
        async (turnId, nextName) => {
            const meetingId = activeMeetingIdRef.current;
            const cleaned = String(nextName || '').trim();
            if (!meetingId || !turnId || !cleaned) {
                return { ok: false, message: 'Enter a speaker name.' };
            }
            try {
                const response = await apiRequest(`/api/meetings/${meetingId}`, {
                    method: 'PATCH',
                    body: { turnSpeakers: { [turnId]: cleaned } },
                });
                const meeting = adoptMeeting(response.meeting);
                return { ok: true, meeting };
            } catch (cause) {
                return { ok: false, message: cause.message };
            }
        },
        [adoptMeeting]
    );

    const toggleMicMute = useCallback(() => setMicMuted(prev => !prev), []);
    const toggleSystemAudioMute = useCallback(() => setSystemAudioMuted(prev => !prev), []);

    const updateSettings = useCallback(
        async next => {
            const previous = settingsRef.current;
            const processingChanged = 'noiseSuppression' in next || 'echoSuppression' in next;
            const capture = captureRef.current;
            try {
                if (processingChanged && capture) {
                    await capture.setProcessing({
                        noiseSuppression: (next.noiseSuppression ?? previous.noiseSuppression) !== false,
                        echoCancellation: (next.echoSuppression ?? previous.echoSuppression) !== false,
                    });
                }
                const response = await apiRequest('/api/settings', { method: 'POST', body: { settings: next } });
                if (response?.success === false) {
                    throw new Error(response.warnings?.join('; ') || 'The backend rejected these settings.');
                }
                const credentialKeys = [
                    'geminiApiKey', 'openaiApiKey', 'sarvamApiKey',
                    'googleCalendarClientId', 'googleCalendarClientSecret',
                    'microsoftCalendarClientId', 'microsoftCalendarClientSecret',
                ];
                const publicNext = Object.fromEntries(Object.entries(next).filter(([key]) => !credentialKeys.includes(key)));
                setSettings(prev => ({
                    ...Object.fromEntries(Object.entries(prev).filter(([key]) => !credentialKeys.includes(key))),
                    ...publicNext,
                    ...(response?.settings || {}),
                }));

                // The core accepts the write but does not necessarily keep it, so read
                // it back rather than telling the user it was stored. The key is
                // deliberately never echoed back, so it is confirmed through the
                // flag instead of by looking for itself.
                const stored = await apiRequest('/api/settings').catch(() => ({ settings: {} }));
                const persisted = Object.keys(next).every(key => {
                    if (credentialKeys.includes(key)) return stored?.settings?.[`${key}Set`] === Boolean(next[key]?.trim());
                    return JSON.stringify(stored?.settings?.[key]) === JSON.stringify(next[key]);
                });

                // Model and language changes land on the engine, so pick up its new state.
                await refresh();
                return { ok: true, persisted };
            } catch (cause) {
                if (processingChanged && capture && captureRef.current === capture) {
                    await capture.setProcessing({ noiseSuppression: previous.noiseSuppression !== false, echoCancellation: previous.echoSuppression !== false }).catch(() => {});
                }
                setError(cause.message);
                return { ok: false, persisted: false, message: cause.message };
            }
        },
        [refresh]
    );

    const activateLicense = useCallback(async licenseKey => {
        try {
            const response = await apiRequest('/api/license/activate', { method: 'POST', body: { licenseKey } });
            if (response.success === false) {
                return { ok: false, message: response.error || 'The backend rejected that key.' };
            }
            const status = await apiRequest('/api/license/status').catch(() => null);
            setLicense(status);
            return { ok: true, message: 'License activated.' };
        } catch (cause) {
            return { ok: false, message: cause.message };
        }
    }, []);

    return {
        setOnCalendarConnection,
        setOnConnectorConnection,
        addNote,
        deleteNote,
        backendUrl: getBackendUrl(),
        connection,
        isConnected: connection === 'online',
        sessionState,
        activeMeeting,
        isGeneratingSummary,
        interimTurns,
        durationSeconds,
        subscribeAudioLevels: levels.subscribe,
        systemAudioSeen,
        micMuted,
        clientMicMuted,
        systemAudioMuted,
        recordingState,
        stopFailed,
        error,
        micError,
        systemAudioError,
        settings,
        license,
        engine,
        liveRoster,
        meetingClient,
        startMeeting,
        pauseMeeting,
        resumeMeeting,
        stopMeeting,
        loadMeeting,
        regenerateSummary,
        updateActiveMeeting,
        updateCommitments,
        updatePostMeetingAction,
        renameSpeaker,
        changeTurnSpeaker,
        toggleMicMute,
        toggleSystemAudioMute,
        updateSettings,
        activateLicense,
        refresh,
        setOnLiveTurn,
        setOnTranscriptReplaced,
        setOnMeetingCompleted,
        setOnMeetingEnded,
        setOnUnscheduledCall,
        clearError: useCallback(() => setError(null), []),
    };
}
