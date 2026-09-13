import { useState, useEffect, useCallback } from 'react';
import { normalizeTurn } from '@/lib/backend';

/**
 * useTranscriptStream hook
 * Holds the turns the backend has emitted for the current meeting.
 */
export function useTranscriptStream({ turns: externalTurns } = {}) {
    const [turns, setTurns] = useState([]);

    // Adopt the transcript of whichever meeting is open.
    useEffect(() => {
        if (Array.isArray(externalTurns)) {
            setTurns(externalTurns);
        }
    }, [externalTurns]);

    // Append a turn pushed over the backend socket.
    const addTurn = useCallback(turnData => {
        const turn = { ...normalizeTurn(turnData, Date.now()), live: true };
        setTurns(prev => (prev.some(existing => existing.id === turn.id) ? prev : [...prev, turn]));
    }, []);

    const clearTurns = useCallback(() => {
        setTurns([]);
    }, []);

    return { turns, addTurn, clearTurns, setTurns };
}
