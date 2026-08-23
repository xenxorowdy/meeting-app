import { useState, useEffect, useMemo, useCallback } from 'react';
import { normalizeTurn } from '@/lib/backend';

/**
 * useTranscriptStream hook
 * Holds the turns the backend has emitted for the current meeting, plus the
 * search, speaker filter, and talk-time metrics the views render.
 */
export function useTranscriptStream({ turns: externalTurns } = {}) {
    const [turns, setTurns] = useState([]);
    const [searchQuery, setSearchQuery] = useState('');
    const [selectedSpeakerFilter, setSelectedSpeakerFilter] = useState('ALL');
    const [autoScroll, setAutoScroll] = useState(true);

    // Adopt the transcript of whichever meeting is open.
    useEffect(() => {
        if (Array.isArray(externalTurns)) {
            setTurns(externalTurns);
        }
    }, [externalTurns]);

    // Append a turn pushed over the backend socket.
    const addTurn = useCallback(turnData => {
        const turn = normalizeTurn(turnData, Date.now());
        setTurns(prev => (prev.some(existing => existing.id === turn.id) ? prev : [...prev, turn]));
    }, []);

    const updateTurn = useCallback((id, updatedText) => {
        setTurns(prev => prev.map(t => (t.id === id ? { ...t, text: updatedText } : t)));
    }, []);

    const deleteTurn = useCallback(id => {
        setTurns(prev => prev.filter(t => t.id !== id));
    }, []);

    const clearTurns = useCallback(() => {
        setTurns([]);
        setSearchQuery('');
        setSelectedSpeakerFilter('ALL');
    }, []);

    // Unique list of speakers in current transcript
    const speakers = useMemo(() => {
        const speakerSet = new Set();
        turns.forEach(t => {
            if (t.speaker) speakerSet.add(t.speaker);
        });
        return Array.from(speakerSet);
    }, [turns]);

    // Filtered turns based on search query and speaker filter
    const filteredTurns = useMemo(() => {
        return turns.filter(turn => {
            // Speaker filter
            if (selectedSpeakerFilter !== 'ALL' && turn.speaker !== selectedSpeakerFilter) {
                return false;
            }

            // Search query
            if (searchQuery.trim()) {
                const query = searchQuery.toLowerCase();
                const textMatch = turn.text?.toLowerCase().includes(query);
                const speakerMatch = turn.speaker?.toLowerCase().includes(query);
                return textMatch || speakerMatch;
            }

            return true;
        });
    }, [turns, searchQuery, selectedSpeakerFilter]);

    // Speaker metrics & statistics
    const speakerStats = useMemo(() => {
        const stats = {};
        let totalWords = 0;

        turns.forEach(t => {
            const spk = t.speaker || 'Unknown';
            const words = (t.text || '').trim().split(/\s+/).filter(Boolean).length;
            totalWords += words;

            if (!stats[spk]) {
                stats[spk] = { turns: 0, words: 0, stream: t.stream };
            }
            stats[spk].turns += 1;
            stats[spk].words += words;
        });

        return Object.entries(stats).map(([speaker, data]) => ({
            speaker,
            turns: data.turns,
            words: data.words,
            stream: data.stream,
            percentage: totalWords > 0 ? Math.round((data.words / totalWords) * 100) : 0,
        }));
    }, [turns]);

    return {
        turns,
        filteredTurns,
        searchQuery,
        setSearchQuery,
        selectedSpeakerFilter,
        setSelectedSpeakerFilter,
        speakers,
        speakerStats,
        autoScroll,
        setAutoScroll,
        addTurn,
        updateTurn,
        deleteTurn,
        clearTurns,
        setTurns,
    };
}
