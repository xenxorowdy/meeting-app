import { useCallback, useEffect, useRef, useState } from 'react';
import { apiRequest, apiText, normalizeMeeting } from '@/lib/backend';

const SEARCH_DEBOUNCE_MS = 250;

/**
 * The stored meeting list, served by the backend. Search is handed to the
 * backend so results come from its index rather than from whatever the client
 * happens to be holding.
 */
export function useMeetingHistory({ enabled = true } = {}) {
    const [meetings, setMeetings] = useState([]);
    const [searchQuery, setSearchQuery] = useState('');
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState(null);

    const requestIdRef = useRef(0);

    const load = useCallback(async (query = '') => {
        const requestId = requestIdRef.current + 1;
        requestIdRef.current = requestId;

        setIsLoading(true);
        try {
            const params = new URLSearchParams({ limit: '200' });
            if (query.trim()) params.set('search', query.trim());

            const response = await apiRequest(`/api/meetings?${params.toString()}`);
            if (requestIdRef.current !== requestId) return;

            const list = Array.isArray(response.meetings) ? response.meetings : [];
            setMeetings(list.map(normalizeMeeting).sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0)));
            setError(null);
        } catch (cause) {
            if (requestIdRef.current !== requestId) return;
            setMeetings([]);
            setError(cause.message);
        } finally {
            if (requestIdRef.current === requestId) setIsLoading(false);
        }
    }, []);

    useEffect(() => {
        if (!enabled) return undefined;
        const timer = setTimeout(() => load(searchQuery), searchQuery ? SEARCH_DEBOUNCE_MS : 0);
        return () => clearTimeout(timer);
    }, [enabled, load, searchQuery]);

    const deleteMeeting = useCallback(async id => {
        try {
            await apiRequest(`/api/meetings/${id}`, { method: 'DELETE' });
            setMeetings(prev => prev.filter(meeting => meeting.id !== id));
            return true;
        } catch (cause) {
            setError(cause.message);
            return false;
        }
    }, []);

    const exportMeeting = useCallback(async (id, format = 'md') => {
        return apiText(`/api/meetings/${id}/export?format=${encodeURIComponent(format)}`);
    }, []);

    return {
        meetings,
        searchQuery,
        setSearchQuery,
        isLoading,
        error,
        reload: () => load(searchQuery),
        deleteMeeting,
        exportMeeting,
    };
}
