export const CALL_PROMPT_LIFETIME_MS = 120_000;
export const CALL_PROMPT_WOBBLE_DELAY_MS = 15_000;
const COOLDOWN_MS = 5 * 60 * 1000;

/** One idle-call prompt, shared by browser observations and the microphone watcher. */
export function createCallPromptController({ onChange, now = Date.now, schedule = setTimeout, cancel = clearTimeout, makeId = () => crypto.randomUUID() }) {
    let context = { enabled: false, canRecord: false };
    let prompt = null;
    let expiry = null;
    let disposed = false;
    const lastPrompted = new Map();
    const publish = next => { prompt = next; onChange(next); };
    const stopTimer = () => { if (expiry !== null) cancel(expiry); expiry = null; };
    const clear = () => { stopTimer(); if (prompt) publish(null); };
    const armExpiry = () => {
        stopTimer();
        if (!prompt || prompt.status === 'starting') return;
        const id = prompt.id;
        expiry = schedule(() => { if (prompt?.id === id) clear(); }, Math.max(0, prompt.expiresAt - now()));
    };

    return {
        setContext(next) {
            context = next;
            if (!next.enabled || (!next.canRecord && prompt?.status !== 'starting')) clear();
        },
        detect(call) {
            if (disposed || !context.enabled || !context.canRecord || !call?.source) return;
            const key = `${call.source}|${call.url || ''}`;
            if (prompt) {
                // Enrich a generic mic observation without extending the card's life.
                lastPrompted.set(key, now());
                if (prompt.source === 'microphone' && call.source !== 'microphone') publish({ ...prompt, source: call.source });
                return;
            }
            const previous = lastPrompted.get(key);
            if (previous !== undefined && now() - previous < COOLDOWN_MS) return;
            const createdAt = now();
            lastPrompted.set(key, createdAt);
            publish({ id: makeId(), source: call.source, createdAt, expiresAt: createdAt + CALL_PROMPT_LIFETIME_MS, status: 'ready', error: null });
            armExpiry();
        },
        microphoneInactive() {
            if (prompt?.source === 'microphone' && prompt.status !== 'starting') clear();
        },
        dismiss(id) {
            if (!prompt || prompt.id !== id || prompt.status === 'starting') return false;
            clear();
            return true;
        },
        async start(id) {
            if (!prompt || prompt.id !== id || prompt.status === 'starting' || !context.enabled || !context.canRecord || now() >= prompt.expiresAt) return false;
            stopTimer();
            publish({ ...prompt, status: 'starting', error: null });
            try {
                const meeting = await context.onStart();
                if (disposed || prompt?.id !== id) return Boolean(meeting);
                if (!meeting) throw new Error('Could not start recording. Check your recording settings in Kesami, then retry.');
                clear();
                return true;
            } catch (cause) {
                if (!disposed && prompt?.id === id) {
                    publish({ ...prompt, status: 'ready', error: cause.message || 'Could not start recording. Try again.' });
                    armExpiry();
                }
                return false;
            }
        },
        dispose() { disposed = true; stopTimer(); prompt = null; },
    };
}
