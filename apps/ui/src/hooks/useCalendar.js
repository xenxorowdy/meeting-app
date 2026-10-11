import { useCallback, useEffect, useRef, useState } from 'react';
import { apiRequest } from '@/lib/backend';
import { calendarAgendaRange, createCalendarCache } from '@/lib/calendarEvents';

const EMPTY = { providers: [] };

export function useCalendar({ isConnected }) {
    const [status, setStatus] = useState(EMPTY);
    const [events, setEvents] = useState([]);
    const [warnings, setWarnings] = useState([]);
    const [pendingProvider, setPendingProvider] = useState(null);
    const [error, setError] = useState(null);
    const mounted = useRef(true);
    const eventRequest = useRef(0);
    const eventCache = useRef(null);
    if (!eventCache.current) eventCache.current = createCalendarCache();

    useEffect(() => {
        mounted.current = true;
        return () => {
            mounted.current = false;
        };
    }, []);

    const refreshStatus = useCallback(async () => {
        try {
            const next = await apiRequest('/api/calendar/status');
            if (mounted.current) setStatus(next || EMPTY);
        } catch {
            if (mounted.current) setStatus(EMPTY);
        }
    }, []);

    const refreshEvents = useCallback(async () => {
        const requestId = ++eventRequest.current;
        const { minutesBack, minutesAhead, startMs, endMs } = calendarAgendaRange();
        const key = `${startMs}-${endMs}`;
        const cached = eventCache.current.get(key);
        if (cached) {
            setEvents(cached.events);
            setWarnings(cached.warnings);
            return;
        }
        try {
            const next = await apiRequest(`/api/calendar/events?minutesBack=${minutesBack}&minutesAhead=${minutesAhead}`);
            const fresh = {
                events: Array.isArray(next?.events) ? next.events : [],
                warnings: Array.isArray(next?.warnings) ? next.warnings : [],
            };
            if (!fresh.warnings.length) eventCache.current.set(key, fresh);
            if (!mounted.current || requestId !== eventRequest.current) return;
            setEvents(fresh.events);
            setWarnings(fresh.warnings);
            if (fresh.warnings.length) refreshStatus();
            // Keep the menu bar's "next meeting" in step with what this window just saw.
            globalThis.kesamiShell?.refreshMenuBar?.()?.catch?.(() => {});
        } catch {
            if (mounted.current && requestId === eventRequest.current) setEvents([]);
        }
    }, [refreshStatus]);

    const reloadEvents = useCallback(() => {
        eventCache.current.clear();
        return refreshEvents();
    }, [refreshEvents]);

    useEffect(() => {
        if (!isConnected) return;
        refreshStatus();
        refreshEvents();
    }, [isConnected, refreshStatus, refreshEvents]);

    const anyConnected = status.providers.some(provider => provider.connected);

    useEffect(() => {
        if (!isConnected || !anyConnected) return undefined;
        const timer = setInterval(refreshEvents, 300000);
        return () => clearInterval(timer);
    }, [isConnected, anyConnected, refreshEvents]);

    const connect = useCallback(async provider => {
        setError(null);
        setPendingProvider(provider);
        try {
            const response = await apiRequest('/api/calendar/connect', { method: 'POST', body: { provider } });
            if (response?.authUrl) window.open(response.authUrl, '_blank');
        } catch (cause) {
            setPendingProvider(null);
            setError(cause?.message || 'Could not start the calendar sign-in.');
        }
    }, []);

    const disconnect = useCallback(
        async provider => {
            setError(null);
            try {
                await apiRequest('/api/calendar/disconnect', { method: 'POST', body: { provider } });
                await refreshStatus();
                await reloadEvents();
            } catch (cause) {
                setError(cause?.message || 'Could not disconnect the calendar.');
            }
        },
        [refreshStatus, reloadEvents]
    );

    const handleConnectionEvent = useCallback(
        data => {
            setPendingProvider(null);
            if (data?.error) setError(data.error);
            refreshStatus();
            reloadEvents();
        },
        [refreshStatus, reloadEvents]
    );

    return {
        providers: status.providers,
        events,
        warnings,
        pendingProvider,
        error,
        connect,
        disconnect,
        refreshEvents,
        reloadEvents,
        handleConnectionEvent,
        clearError: () => setError(null),
    };
}
