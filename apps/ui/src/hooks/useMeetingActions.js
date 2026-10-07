import { useEffect, useRef, useState } from 'react';
import { apiRequest } from '@/lib/backend';

// Sharing and the Actions tab use the same read/review flow and durable receipts.
export function useMeetingActions({ meeting, isConnected, disabled, onUpdate, enabled = true }) {
    const [data, setData] = useState(null);
    const [loading, setLoading] = useState(enabled);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const [attempt, setAttempt] = useState(0);
    const generation = useRef(0), saving = useRef(false);
    const refresh = () => setAttempt(value => value + 1);

    useEffect(() => {
        if (!enabled || !isConnected) { setLoading(false); return undefined; }
        const request = ++generation.current, controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 10000);
        setLoading(true); setError('');
        apiRequest(`/api/meetings/${encodeURIComponent(meeting.id)}/actions`, { signal: controller.signal })
            .then(response => { if (generation.current === request) setData(response); })
            .catch(cause => { if (generation.current === request) setError(controller.signal.aborted ? 'Loading took too long. Reconnect and retry.' : cause.message); })
            .finally(() => { clearTimeout(timer); if (generation.current === request) setLoading(false); });
        return () => { ++generation.current; controller.abort(); clearTimeout(timer); };
    }, [enabled, isConnected, meeting.id, meeting.title, meeting.startedAt, meeting.summaryMarkdown, meeting.transcript, meeting.actionItems, meeting.emailDraft, meeting.metadata?.meetingCommitments, attempt]);

    const confirm = async (id, payload) => {
        if (saving.current || loading || disabled || !isConnected || error) return false;
        saving.current = true; setBusy(true); setError('');
        const request = generation.current;
        try {
            const result = await onUpdate?.(id, payload);
            if (!result?.ok) throw new Error(result?.message || 'The action was not confirmed.');
            // Display the saved receipt without waiting for the follow-up read.
            if (generation.current === request) {
                const history = result.meeting?.metadata?.postMeetingActions?.items;
                if (history) setData(current => current ? { ...current, history } : current);
                refresh();
            }
            return true;
        } catch (cause) { if (generation.current === request) setError(cause.message); return false; }
        finally { saving.current = false; setBusy(false); }
    };
    return { data, loading, busy, error, refresh, confirm };
}
