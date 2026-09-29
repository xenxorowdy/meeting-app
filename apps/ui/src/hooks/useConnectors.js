import { useCallback, useEffect, useRef, useState } from 'react';
import { apiRequest } from '@/lib/backend';

const EMPTY = { providers: [], mcp: null };
const SIGN_IN_POLL_MS = 2000;
const SIGN_IN_TIMEOUT_MS = 300000;

export function useConnectors({ enabled = true } = {}) {
    const [status, setStatus] = useState(EMPTY);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);
    const mounted = useRef(true);
    const signInOutcome = useRef(null);

    useEffect(() => {
        mounted.current = true;
        return () => {
            mounted.current = false;
        };
    }, []);

    const refresh = useCallback(async () => {
        setLoading(true);
        try {
            const next = await apiRequest('/api/connectors');
            if (mounted.current) {
                setStatus({ providers: next?.providers || [], mcp: next?.mcp || null });
                setError(null);
            }
            return next?.providers || [];
        } catch (cause) {
            if (mounted.current) setError(cause.message);
            return [];
        } finally {
            if (mounted.current) setLoading(false);
        }
    }, []);

    useEffect(() => {
        if (enabled) refresh();
    }, [enabled, refresh]);

    const replace = useCallback(connector => {
        setStatus(current => ({
            ...current,
            providers: current.providers.map(entry => (entry.provider === connector.provider ? connector : entry)),
        }));
    }, []);

    const save = useCallback(
        async (provider, config) => {
            const result = await apiRequest('/api/connectors/save', { method: 'POST', body: { provider, config } });
            if (result?.connector && mounted.current) replace(result.connector);
            return result?.connector;
        },
        [replace]
    );

    const disconnect = useCallback(
        async provider => {
            await apiRequest('/api/connectors/disconnect', { method: 'POST', body: { provider } });
            await refresh();
        },
        [refresh]
    );

    const signIn = useCallback(
        async provider => {
            signInOutcome.current = null;
            const response = await apiRequest('/api/connectors/connect', { method: 'POST', body: { provider } });
            if (response?.authUrl) window.open(response.authUrl, '_blank');
            const deadline = Date.now() + SIGN_IN_TIMEOUT_MS;
            while (mounted.current && Date.now() < deadline) {
                await new Promise(resolve => setTimeout(resolve, SIGN_IN_POLL_MS));
                const outcome = signInOutcome.current;
                if (outcome?.provider === provider && outcome.connected === false) {
                    throw new Error(outcome.error || 'The Google sign-in was cancelled.');
                }
                const providers = await refresh();
                if (providers.find(entry => entry.provider === provider)?.connected) return true;
            }
            throw new Error('The browser sign-in didn’t finish. Try again.');
        },
        [refresh]
    );

    const handleConnectionEvent = useCallback(data => {
        signInOutcome.current = data || null;
    }, []);

    const test = useCallback(async provider => {
        const result = await apiRequest('/api/connectors/test', { method: 'POST', body: { provider } });
        return result?.message || 'Connected.';
    }, []);

    const send = useCallback(async (provider, meetingId, { force = false } = {}) => {
        const result = await apiRequest('/api/connectors/send', { method: 'POST', body: { provider, meetingId, force } });
        return result?.delivery;
    }, []);

    return { ...status, loading, error, refresh, save, disconnect, signIn, test, send, handleConnectionEvent };
}
