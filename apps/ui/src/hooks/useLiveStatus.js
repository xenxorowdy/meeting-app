import { useCallback, useEffect, useRef, useState } from 'react';
import { apiRequest, createBackendSocket, mapBackendState, mergeInterim, normalizeTurn } from '@/lib/backend';

const MAX_TURNS = 300;

export function useLiveStatus() {
    const [connection, setConnection] = useState('connecting');
    const [sessionState, setSessionState] = useState('idle');
    const [meeting, setMeeting] = useState(null);
    const [turns, setTurns] = useState([]);
    const [interimTurns, setInterimTurns] = useState([]);
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
                    setInterimTurns([]);
                    setDurationSeconds(0);
                    setSessionState('recording');
                    break;

                case 'transcript_interim':
                    setInterimTurns(prev => mergeInterim(prev, data));
                    break;

                case 'transcript_turn': {
                    const turn = normalizeTurn(data, Date.now());
                    setInterimTurns(prev => prev.filter(entry => entry.stream !== turn.stream));
                    setTurns(prev => [...prev, turn].slice(-MAX_TURNS));
                    break;
                }

                case 'transcript_replaced':
                    setInterimTurns([]);
                    setTurns((Array.isArray(data?.turns) ? data.turns : []).map(normalizeTurn).slice(-MAX_TURNS));
                    break;

                case 'meeting_completed':
                    setInterimTurns([]);
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

    useEffect(() => {
        if (sessionState !== 'recording') setInterimTurns([]);
    }, [sessionState]);

    const isLive = sessionState === 'recording' || sessionState === 'paused';

    return { connection, sessionState, meeting, turns, interimTurns, durationSeconds, isLive };
}
