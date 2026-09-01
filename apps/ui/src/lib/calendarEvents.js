export const EVENT_MATCH_LEAD_MS = 300000;
export const EVENT_MATCH_GRACE_MS = 300000;
export const REMINDER_LEAD_MS = 60000;
export const REMINDER_MIN_ATTENDEES = 2;

function withBounds(events) {
    return (Array.isArray(events) ? events : [])
        .map(event => ({ ...event, startMs: Date.parse(event?.start), endMs: Date.parse(event?.end) }))
        .filter(event => Number.isFinite(event.startMs));
}

export function currentOrNextEvent(events, nowMs = Date.now()) {
    const parsed = withBounds(events);
    if (parsed.length === 0) return null;
    const running = parsed.find(event => event.startMs <= nowMs && event.endMs > nowMs);
    if (running) return running;
    return parsed.find(event => event.startMs > nowMs) || null;
}

export function eventForNow(events, nowMs = Date.now()) {
    const candidates = withBounds(events).filter(event => {
        const endMs = Number.isFinite(event.endMs) ? event.endMs : event.startMs;
        return nowMs >= event.startMs - EVENT_MATCH_LEAD_MS && nowMs <= endMs + EVENT_MATCH_GRACE_MS;
    });
    if (candidates.length === 0) return null;
    return candidates.reduce((best, event) => (Math.abs(event.startMs - nowMs) < Math.abs(best.startMs - nowMs) ? event : best));
}

export function calendarEventMetadata(event) {
    if (!event) return null;
    return {
        id: event.id ?? null,
        provider: event.provider ?? null,
        title: event.title ?? null,
        start: event.start ?? null,
        end: event.end ?? null,
        location: event.location ?? null,
        joinUrl: event.joinUrl ?? null,
        organizer: event.organizer ?? null,
        attendees: (Array.isArray(event.attendees) ? event.attendees : []).map(person => ({
            name: person?.name ?? null,
            email: person?.email ?? null,
        })),
    };
}

export function attendeeNames(source) {
    const list = Array.isArray(source?.attendees) ? source.attendees : [];
    const names = list.map(person => String(person?.name ?? '').trim() || String(person?.email ?? '').trim()).filter(Boolean);
    return Array.from(new Set(names));
}

export function reminderKey(event) {
    return `${event?.provider || 'calendar'}:${event?.id || 'unknown'}:${event?.start || ''}`;
}

export function dueForReminder(events, nowMs, leadMs = REMINDER_LEAD_MS) {
    if (!Array.isArray(events)) return [];
    return events.filter(event => {
        const attendees = Array.isArray(event?.attendees) ? event.attendees : [];
        if (attendees.length < REMINDER_MIN_ATTENDEES) return false;
        const startMs = Date.parse(event.start);
        if (!Number.isFinite(startMs)) return false;
        const untilStart = startMs - nowMs;
        return untilStart >= 0 && untilStart <= leadMs;
    });
}
