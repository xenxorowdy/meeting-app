import { useCallback, useEffect, useRef, useState } from 'react';
import { apiRequest, createBackendSocket, mapBackendState, normalizeTurn } from '@/lib/backend';

const MAX_TURNS = 300;

export function useLiveStatus() {
    const [connection, setConnection] = useState('connecting');
    const [sessionState, setSessionState] = useState('idle');
    const [meeting, setMeeting] = useState(null);
    const [turns, setTurns] = useState([]);
    const [durationSeconds, setDurationSeconds] = useState(0);

    const meetingIdRef = useRef(null);

    const adopt = useCallback(async meetingId => {
        if (!meetingId || meetingId === meetingIdRef.current) return;
        meetingIdRef.current = meetingId;
        try {
            const detail = await apiRequest(`/api/meetings/${meetingId}`);
            const loaded = detail?.meeting;
            if (!loaded || loaded.id !== meetingIdRef.current) return;
            setMeeting({ id: loaded.id, title: loaded.title, startedAt: loaded.startedAt });
            setTurns((Array.isArray(loaded.transcript) ? loaded.transcript : []).map(normalizeTurn).slice(-MAX_TURNS));
        } catch {
            // The socket keeps reporting state; a failed detail fetch only costs
            // the widget the turns spoken before it opened.
        }
    }, []);

    const handleEvent = useCallback(
        message => {
            const { type, data } = message;

            switch (type) {
                case 'connection_established':
                case 'status_update': {
                    const status = message.status || data;
                    if (!status) break;
                    setSessionState(mapBackendState(status.state));
                    if (typeof status.durationSeconds === 'number') setDurationSeconds(status.durationSeconds);
                    adopt(status.meetingId || status.currentMeeting?.id || null);
                    break;
                }

                case 'state_change':
                    setSessionState(mapBackendState(data?.newState || data?.to));
                    break;

                case 'meeting_started':
                    meetingIdRef.current = data?.id || null;
                    setMeeting(data ? { id: data.id, title: data.title, startedAt: data.startedAt } : null);
                    setTurns([]);
                    setDurationSeconds(0);
                    setSessionState('recording');
                    break;

                case 'transcript_turn':
                    setTurns(prev => [...prev, normalizeTurn(data, prev.length)].slice(-MAX_TURNS));
                    break;

                case 'meeting_completed':
                    setSessionState('completed');
                    break;

                default:
                    break;
            }
        },
        [adopt]
    );

    useEffect(() => {
        const socket = createBackendSocket({ onEvent: handleEvent, onConnectionChange: setConnection });
        return () => socket.close();
    }, [handleEvent]);

    useEffect(() => {
        if (sessionState !== 'recording' && sessionState !== 'paused') return undefined;
        const startedAt = meeting?.startedAt;
        if (!startedAt) return undefined;

        const tick = () => setDurationSeconds(Math.max(0, Math.floor((Date.now() - startedAt) / 1000)));
        tick();
        const timer = setInterval(tick, 1000);
        return () => clearInterval(timer);
    }, [sessionState, meeting?.startedAt]);

    const isLive = sessionState === 'recording' || sessionState === 'paused';

    return { connection, sessionState, meeting, turns, durationSeconds, isLive };
}
