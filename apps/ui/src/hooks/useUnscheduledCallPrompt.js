import { useCallback, useEffect, useRef } from 'react';
import { eventForNow } from '@/lib/calendarEvents';

const COOLDOWN_MS = 5 * 60 * 1000;

function describe(call) {
    if (call.source === 'google-meet') return { title: 'Google Meet call detected', body: 'This call is not on your calendar. Click to start recording it.' };
    if (call.source === 'zoom') return { title: 'Zoom call detected', body: 'This call is not on your calendar. Click to start recording it.' };
    return { title: 'A call is using your microphone', body: 'Nothing on your calendar covers it. Click to start recording.' };
}

/**
 * One coordinator for the "should I record this?" prompt, however the call was
 * detected: a browser meeting reported by the extension (the backend's
 * `unscheduled_call` event, forwarded by App) or any app opening the
 * microphone (the desktop shell's mic watcher, subscribed here). A prompt
 * fires only while Kesami is idle, nothing on the calendar covers right now,
 * and the same source has not been prompted recently. Clicking the
 * notification starts the recording immediately.
 */
export function useUnscheduledCallPrompt({ enabled, canRecord, events, onStart }) {
    const latestRef = useRef({ enabled, canRecord, events, onStart });
    latestRef.current = { enabled, canRecord, events, onStart };
    const lastPromptedRef = useRef(new Map());

    useEffect(() => {
        if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
            Notification.requestPermission().catch(() => {});
        }
    }, []);

    const notify = useCallback(call => {
        const { enabled: on, canRecord: ready, events: calendarEvents, onStart: start } = latestRef.current;
        if (!on || !ready) return;
        if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
        // A scheduled meeting already covers this moment; the reminder flow
        // owns it and this prompt would only duplicate it.
        if (eventForNow(calendarEvents)) return;
        if (!call?.source && !call?.url && !call?.participants?.length) return;

        const key = call.source || 'mic';
        const now = Date.now();
        if (now - (lastPromptedRef.current.get(key) || 0) < COOLDOWN_MS) return;
        lastPromptedRef.current.set(key, now);

        const copy = describe(call);
        const notification = new Notification(copy.title, {
            body: copy.body,
            tag: `kesami-unscheduled-${key}`,
        });
        notification.onclick = () => {
            window.focus();
            start?.();
        };
    }, []);

    // Mic-watch events arrive straight from the desktop shell; browser
    // meetings come in through notify() from the backend socket. Starting the
    // watcher also delivers the current mic state to this fresh page.
    useEffect(() => {
        const unsubscribe = globalThis.kesamiMicUsage?.onEvent?.(event => {
            if (event?.active) notify({ source: '' });
        });
        globalThis.kesamiMicUsage?.start?.().catch(() => {});
        return () => unsubscribe?.();
    }, [notify]);

    return { notifyUnscheduledCall: notify };
}
