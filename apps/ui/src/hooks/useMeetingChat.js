import { useCallback, useEffect, useRef, useState } from 'react';
import { apiRequest } from '@/lib/backend';
import { scopeKey } from '@/lib/chat';

export function useMeetingChat(scope, isConnected) {
    const [threads, setThreads] = useState([]);
    const [thread, setThread] = useState(null);
    const [messages, setMessages] = useState([]);
    const [question, setQuestion] = useState('');
    const [busy, setBusy] = useState(false);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);
    const [index, setIndex] = useState(null);
    const [before, setBefore] = useState(null);
    const [nextOffset, setNextOffset] = useState(null);
    const generation = useRef(0);
    const active = useRef(null);
    const threadRef = useRef(null);
    const retryRef = useRef(null);
    const key = scopeKey(scope);
    const keyRef = useRef(key);
    keyRef.current = key;

    const refreshThreads = useCallback(async () => {
        const response = await apiRequest('/api/chat/threads');
        setThreads(response.threads || []);
        setNextOffset(response.nextOffset ?? null);
        return response.threads || [];
    }, []);

    const cancel = useCallback(() => {
        const pending = active.current;
        active.current = null;
        generation.current += 1;
        pending?.controller.abort();
        if (pending?.threadId) apiRequest(`/api/chat/threads/${pending.threadId}/requests/${pending.requestId}/cancel`, { method: 'POST' }).catch(() => {});
        if (pending?.question) { setQuestion(pending.question); retryRef.current = null; }
        setBusy(false);
    }, []);

    const openThread = useCallback(async selected => {
        cancel();
        const run = ++generation.current;
        setLoading(true); setError(null); retryRef.current = null;
        setQuestion(''); setMessages([]); setThread(selected); threadRef.current = selected;
        try {
            const response = await apiRequest(`/api/chat/threads/${selected.id}/messages`);
            if (run !== generation.current) return;
            setMessages(response.messages || []);
            setBefore(response.before ?? null);
        } catch (cause) {
            if (run === generation.current) setError(cause.message);
        } finally {
            if (run === generation.current) setLoading(false);
        }
    }, [cancel]);

    useEffect(() => {
        cancel();
        const run = ++generation.current;
        threadRef.current = null; retryRef.current = null;
        setThread(null); setMessages([]); setQuestion(''); setError(null); setLoading(true);
        if (!isConnected) { setLoading(false); return; }
        refreshThreads().then(list => {
            if (run !== generation.current) return;
            const recent = list.find(item => scopeKey(item.scope) === key);
            if (recent) openThread(recent);
            else setLoading(false);
        }).catch(cause => { if (run === generation.current) { setError(cause.message); setLoading(false); } });
        return cancel;
    }, [key, isConnected, cancel, openThread, refreshThreads]);

    useEffect(() => {
        if (!isConnected) return;
        let disposed = false;
        const refresh = () => apiRequest('/api/chat/index/status').then(value => { if (!disposed) setIndex(value); }).catch(() => {});
        refresh();
        const timer = setInterval(refresh, 5000);
        return () => { disposed = true; clearInterval(timer); };
    }, [isConnected]);

    const newThread = useCallback(() => {
        cancel(); threadRef.current = null; retryRef.current = null;
        setThread(null); setMessages([]); setQuestion(''); setError(null); setBefore(null); setLoading(false);
    }, [cancel]);

    const send = useCallback(async (value = question) => {
        const text = value.trim();
        if (!text || active.current || !isConnected || loading) return;
        const run = ++generation.current;
        const controller = new AbortController();
        const requestId = retryRef.current?.question === text ? retryRef.current.requestId : crypto.randomUUID();
        const pending = { controller, requestId, question: text, threadId: threadRef.current?.id };
        active.current = pending;
        setBusy(true); setError(null);
        try {
            let selected = threadRef.current;
            if (!selected) {
                selected = await apiRequest('/api/chat/threads', { method: 'POST', body: { scope: JSON.parse(keyRef.current) }, signal: controller.signal });
                if (run !== generation.current) return;
                threadRef.current = selected; setThread(selected);
                pending.threadId = selected.id;
            }
            retryRef.current = { question: text, requestId };
            setMessages(previous => previous.some(m => m.role === 'user' && m.requestId === requestId) ? previous : [...previous, { role: 'user', content: text, requestId }]);
            setQuestion('');
            const response = await apiRequest(`/api/chat/threads/${selected.id}/messages`, {
                method: 'POST', body: { question: text, requestId }, signal: controller.signal,
            });
            if (run !== generation.current) return;
            setMessages(previous => [...previous, { ...response, role: 'assistant', content: response.answer, requestId }]);
            retryRef.current = null;
            refreshThreads().catch(() => {});
        } catch (cause) {
            if (run !== generation.current) return;
            setQuestion(text); setError(cause.message);
        } finally {
            if (run === generation.current) { active.current = null; setBusy(false); }
        }
    }, [question, isConnected, loading, refreshThreads]);

    const loadEarlier = async () => {
        if (!before || !threadRef.current || loading) return;
        const run = generation.current;
        setLoading(true);
        try {
            const response = await apiRequest(`/api/chat/threads/${threadRef.current.id}/messages?before=${before}`);
            if (run !== generation.current) return;
            setMessages(previous => [...(response.messages || []), ...previous]); setBefore(response.before ?? null);
        } catch (cause) { if (run === generation.current) setError(cause.message); }
        finally { if (run === generation.current) setLoading(false); }
    };

    const loadMoreThreads = async () => {
        if (nextOffset === null) return;
        try {
            const response = await apiRequest(`/api/chat/threads?offset=${nextOffset}`);
            setThreads(previous => [...previous, ...(response.threads || []).filter(item => !previous.some(old => old.id === item.id))]);
            setNextOffset(response.nextOffset ?? null);
        } catch (cause) { setError(cause.message); }
    };

    const deleteThread = async () => {
        if (!threadRef.current) return;
        const id = threadRef.current.id;
        cancel();
        try { await apiRequest(`/api/chat/threads/${id}`, { method: 'DELETE' }); newThread(); await refreshThreads(); }
        catch (cause) { setError(cause.message); }
    };

    return { threads, thread, messages, question, setQuestion, busy, loading, error, index,
        send, cancel, openThread, newThread, deleteThread, before, loadEarlier, nextOffset, loadMoreThreads };
}
