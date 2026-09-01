import { useCallback, useEffect, useRef, useState } from 'react';
import { apiRequest } from '@/lib/backend';

const EMPTY = { providers: [] };

export function useCalendar({ isConnected }) {
    const [status, setStatus] = useState(EMPTY);
    const [events, setEvents] = useState([]);
    const [warnings, setWarnings] = useState([]);
    const [pendingProvider, setPendingProvider] = useState(null);
    const [error, setError] = useState(null);
    const mounted = useRef(true);

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
        try {
            const next = await apiRequest('/api/calendar/events');
            if (!mounted.current) return;
            setEvents(Array.isArray(next?.events) ? next.events : []);
            setWarnings(Array.isArray(next?.warnings) ? next.warnings : []);
        } catch {
            if (mounted.current) setEvents([]);
        }
    }, []);

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
                await refreshEvents();
            } catch (cause) {
                setError(cause?.message || 'Could not disconnect the calendar.');
            }
        },
        [refreshStatus, refreshEvents]
    );

    const handleConnectionEvent = useCallback(
        data => {
            setPendingProvider(null);
            if (data?.error) setError(data.error);
            refreshStatus();
            refreshEvents();
        },
        [refreshStatus, refreshEvents]
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
        handleConnectionEvent,
        clearError: () => setError(null),
    };
}
