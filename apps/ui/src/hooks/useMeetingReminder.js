import { useEffect, useRef } from 'react';
import { dueForReminder, reminderKey } from '@/lib/calendarEvents';

const POLL_MS = 15000;

export function useMeetingReminder({ events, enabled, canRecord, onStart }) {
    const notifiedRef = useRef(new Set());
    const latestRef = useRef({ events, canRecord, onStart });
    latestRef.current = { events, canRecord, onStart };

    useEffect(() => {
        if (!enabled || typeof Notification === 'undefined') return;
        if (Notification.permission !== 'default') return;
        Notification.requestPermission().catch(() => {});
    }, [enabled]);

    useEffect(() => {
        if (!enabled || typeof Notification === 'undefined') return undefined;

        const check = () => {
            const { events: current, canRecord: ready, onStart: start } = latestRef.current;
            if (!ready || Notification.permission !== 'granted') return;

            for (const event of dueForReminder(current, Date.now())) {
                const key = reminderKey(event);
                if (notifiedRef.current.has(key)) continue;
                notifiedRef.current.add(key);

                const invited = event.attendees.length;
                const notification = new Notification(event.title || 'Meeting starting', {
                    body: `Starts in under a minute · ${invited} invited. Open Alpha to record it.`,
                    tag: key,
                });
                notification.onclick = () => {
                    window.focus();
                    start?.(event);
                };
            }
        };

        check();
        const timer = setInterval(check, POLL_MS);
        return () => clearInterval(timer);
    }, [enabled]);
}
