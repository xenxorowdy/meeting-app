import { useCallback, useEffect, useRef, useState } from 'react';
import { apiRequest, createBackendSocket, mapBackendState, normalizeMeeting, normalizeTurn, BACKEND_URL, STREAM_MIC } from '@/lib/backend';
import { startMicCapture } from '@/lib/micCapture';

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
    aiModel: 'claude-3-5-sonnet',
    whisperModel: 'large-v3-v20240930',
    sttLanguage: 'auto',
    autoSummarize: true,
    echoSuppression: true,
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
    const [durationSeconds, setDurationSeconds] = useState(0);
    const [audioLevels, setAudioLevels] = useState({ mic: 0, system: 0 });
    const [systemAudioSeen, setSystemAudioSeen] = useState(false);
    const [micMuted, setMicMuted] = useState(false);
    const [systemAudioMuted, setSystemAudioMuted] = useState(false);
    const [error, setError] = useState(null);
    const [micError, setMicError] = useState(null);
    const [settings, setSettings] = useState(DEFAULT_SETTINGS);
    const [license, setLicense] = useState(null);
    const [engine, setEngine] = useState(null);

    const socketRef = useRef(null);
    const captureRef = useRef(null);
    const activeMeetingIdRef = useRef(null);
    const callbacksRef = useRef({ onLiveTurn: null, onMeetingCompleted: null });

    const setOnLiveTurn = useCallback(fn => {
        callbacksRef.current.onLiveTurn = fn;
    }, []);

    const setOnMeetingCompleted = useCallback(fn => {
        callbacksRef.current.onMeetingCompleted = fn;
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

            setSessionState(mapBackendState(status.state));
            if (typeof status.durationSeconds === 'number') setDurationSeconds(status.durationSeconds);
            if (status.audioLevels) {
                setAudioLevels({ mic: clampLevel(status.audioLevels.mic), system: clampLevel(status.audioLevels.system) });
            }

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
        [adoptMeeting]
    );

    const handleEvent = useCallback(
        message => {
            const { type, data } = message;

            switch (type) {
                case 'connection_established':
                case 'status_update':
                    // The handshake carries `status`; get_status replies carry `data`.
                    applyStatus(message.status || data);
                    break;

                case 'state_change':
                    setSessionState(mapBackendState(data?.newState || data?.to));
                    break;

                case 'meeting_started':
                    adoptMeeting(data);
                    setDurationSeconds(0);
                    setError(null);
                    break;

                case 'meeting_completed': {
                    const meeting = adoptMeeting(data);
                    if (meeting && callbacksRef.current.onMeetingCompleted) {
                        callbacksRef.current.onMeetingCompleted(meeting);
                    }
                    break;
                }

                case 'transcript_turn':
                    if (callbacksRef.current.onLiveTurn) {
                        callbacksRef.current.onLiveTurn(normalizeTurn(data));
                    }
                    break;

                case 'audio_level': {
                    const mic = clampLevel(data?.mic);
                    const system = clampLevel(data?.system);
                    setAudioLevels({ mic, system });
                    if (system > 0) setSystemAudioSeen(true);
                    break;
                }

                case 'error':
                case 'warning':
                    setError(data?.message || data?.error || message.message || 'The backend reported a problem.');
                    break;

                default:
                    break;
            }
        },
        [adoptMeeting, applyStatus]
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
            const [status, storedSettings, licenseStatus, health] = await Promise.all([
                apiRequest('/api/status'),
                apiRequest('/api/settings').catch(() => ({ settings: {} })),
                apiRequest('/api/license/status').catch(() => null),
                apiRequest('/health').catch(() => null),
            ]);

            await applyStatus(status);
            setSettings(prev => ({ ...prev, ...(storedSettings?.settings || {}) }));
            setLicense(licenseStatus);
            setEngine(health);
            setError(null);
        } catch (cause) {
            setError(cause.message);
        }
    }, [applyStatus]);

    useEffect(() => {
        if (connection === 'online') refresh();
    }, [connection, refresh]);

    // Elapsed time is derived from the meeting's own start timestamp so it can't drift.
    useEffect(() => {
        if (sessionState !== SESSION_STATES.RECORDING && sessionState !== SESSION_STATES.PAUSED) return undefined;
        const startedAt = activeMeeting?.startedAt;
        if (!startedAt) return undefined;

        const tick = () => setDurationSeconds(Math.max(0, Math.floor((Date.now() - startedAt) / 1000)));
        tick();
        const timer = setInterval(tick, 1000);
        return () => clearInterval(timer);
    }, [sessionState, activeMeeting?.startedAt]);

    // Microphone capture streams real PCM to the backend while recording.
    useEffect(() => {
        let cancelled = false;
        const isLive = sessionState === SESSION_STATES.RECORDING || sessionState === SESSION_STATES.PAUSED;

        if (isLive && !captureRef.current) {
            startMicCapture({
                deviceId: settings.micDeviceId,
                muted: micMuted,
                onPcm: pcm => {
                    if (socketRef.current) socketRef.current.sendAudio(STREAM_MIC, pcm);
                },
            })
                .then(capture => {
                    if (cancelled) {
                        capture.stop();
                        return;
                    }
                    captureRef.current = capture;
                    setMicError(null);
                })
                .catch(cause => setMicError(cause.message || 'Microphone unavailable'));
        }

        if (!isLive && captureRef.current) {
            captureRef.current.stop();
            captureRef.current = null;
            setAudioLevels({ mic: 0, system: 0 });
        }

        return () => {
            cancelled = true;
        };
    }, [sessionState, settings.micDeviceId, micMuted]);

    useEffect(() => {
        if (captureRef.current) {
            captureRef.current.setMuted(micMuted || sessionState === SESSION_STATES.PAUSED);
        }
    }, [micMuted, sessionState]);

    useEffect(
        () => () => {
            if (captureRef.current) {
                captureRef.current.stop();
                captureRef.current = null;
            }
        },
        []
    );

    const startMeeting = useCallback(
        async title => {
            setError(null);
            try {
                const response = await apiRequest('/api/meetings/start', {
                    method: 'POST',
                    body: { title: title || `Meeting ${new Date().toLocaleString()}` },
                });
                const meeting = adoptMeeting(response.meeting);
                setSessionState(SESSION_STATES.RECORDING);
                setDurationSeconds(0);
                return meeting;
            } catch (cause) {
                setError(cause.message);
                return null;
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
        async (turns = []) => {
            setSessionState(SESSION_STATES.PROCESSING);
            try {
                const response = await apiRequest('/api/meetings/stop', {
                    method: 'POST',
                    body: {
                        transcript: turns.map(turn => ({
                            id: turn.id,
                            channel: turn.stream || turn.channel || 'system',
                            speaker: turn.speaker,
                            startMs: turn.startMs,
                            endMs: turn.endMs,
                            text: turn.text,
                            confidence: turn.confidence ?? 1,
                        })),
                    },
                });

                const meeting = adoptMeeting(response.meeting);
                setSessionState(SESSION_STATES.COMPLETED);
                if (meeting && callbacksRef.current.onMeetingCompleted) {
                    callbacksRef.current.onMeetingCompleted(meeting);
                }
                return meeting;
            } catch (cause) {
                setError(cause.message);
                setSessionState(SESSION_STATES.IDLE);
                return null;
            }
        },
        [adoptMeeting]
    );

    const loadMeeting = useCallback(
        async meetingOrId => {
            const id = typeof meetingOrId === 'string' ? meetingOrId : meetingOrId?.id;
            if (!id) return null;

            try {
                const detail = await apiRequest(`/api/meetings/${id}`);
                const meeting = adoptMeeting(detail.meeting);
                setSessionState(SESSION_STATES.COMPLETED);
                setDurationSeconds(meeting?.durationSeconds || 0);
                return meeting;
            } catch (cause) {
                setError(cause.message);
                return null;
            }
        },
        [adoptMeeting]
    );

    // The backend exposes no meeting-update route yet, so edits stay in this session.
    const updateActiveMeeting = useCallback(updates => {
        setActiveMeeting(prev => (prev ? { ...prev, ...updates } : prev));
    }, []);

    const toggleMicMute = useCallback(() => setMicMuted(prev => !prev), []);
    const toggleSystemAudioMute = useCallback(() => setSystemAudioMuted(prev => !prev), []);

    const updateSettings = useCallback(
        async next => {
            setSettings(prev => ({ ...prev, ...next }));
            try {
                await apiRequest('/api/settings', { method: 'POST', body: { settings: next } });

                // The core accepts the write but does not necessarily keep it, so read
                // it back rather than telling the user it was stored.
                const stored = await apiRequest('/api/settings').catch(() => ({ settings: {} }));
                const persisted = Object.keys(next).every(key => stored?.settings?.[key] !== undefined);

                // Model and language changes land on the engine, so pick up its new state.
                await refresh();
                return { ok: true, persisted };
            } catch (cause) {
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
        backendUrl: BACKEND_URL,
        connection,
        isConnected: connection === 'online',
        sessionState,
        activeMeeting,
        durationSeconds,
        audioLevels,
        systemAudioSeen,
        micMuted,
        systemAudioMuted,
        error,
        micError,
        settings,
        license,
        engine,
        startMeeting,
        pauseMeeting,
        resumeMeeting,
        stopMeeting,
        loadMeeting,
        updateActiveMeeting,
        toggleMicMute,
        toggleSystemAudioMute,
        updateSettings,
        activateLicense,
        refresh,
        setOnLiveTurn,
        setOnMeetingCompleted,
        clearError: useCallback(() => setError(null), []),
    };
}
