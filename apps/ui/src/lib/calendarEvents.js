export const EVENT_MATCH_LEAD_MS = 300000;
export const EVENT_MATCH_GRACE_MS = 300000;
export const REMINDER_LEAD_MS = 60000;

function withBounds(events) {
    return (Array.isArray(events) ? events : [])
        .map(event => ({ ...event, startMs: Date.parse(event?.start), endMs: Date.parse(event?.end) }))
        .filter(event => Number.isFinite(event.startMs));
}

function localDayKey(value) {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return null;
    return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

export function eventsForTodayAndTomorrow(events, nowMs = Date.now()) {
    const today = new Date(nowMs);
    const tomorrow = new Date(nowMs);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const todayKey = localDayKey(today);
    const tomorrowKey = localDayKey(tomorrow);
    const days = { today: [], tomorrow: [] };

    for (const event of Array.isArray(events) ? events : []) {
        const key = localDayKey(event?.start);
        if (key === todayKey) days.today.push(event);
        if (key === tomorrowKey) days.tomorrow.push(event);
    }

    return days;
}

export function calendarEventLink(event) {
    const candidates = [event?.joinUrl, ...(Array.isArray(event?.links) ? event.links : []), event?.eventUrl];
    return candidates.find(value => typeof value === 'string' && /^https?:\/\//i.test(value.trim()))?.trim() || null;
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
        links: Array.isArray(event.links) ? event.links : [],
        eventUrl: event.eventUrl ?? null,
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
        const startMs = Date.parse(event?.start);
        if (!Number.isFinite(startMs)) return false;
        const untilStart = startMs - nowMs;
        return untilStart >= 0 && untilStart <= leadMs;
    });
}

export function durationLabel(ms) {
    if (!Number.isFinite(ms) || ms < 60000) return '<1m';
    const totalMinutes = Math.floor(ms / 60000);
    if (totalMinutes < 60) return `${totalMinutes}m`;
    const totalHours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    if (totalHours < 24) return minutes === 0 ? `${totalHours}h` : `${totalHours}h ${minutes}m`;
    const days = Math.floor(totalHours / 24);
    const hours = totalHours % 24;
    return hours === 0 ? `${days}d` : `${days}d ${hours}h`;
}

export function countdownLabel(msUntilStart) {
    if (!Number.isFinite(msUntilStart) || msUntilStart <= 0) return 'now';
    return `in ${durationLabel(msUntilStart)}`;
}

export function startsLabel(msUntilStart) {
    if (!Number.isFinite(msUntilStart)) return 'No upcoming meetings';
    if (msUntilStart > 0) return `Starts ${countdownLabel(msUntilStart)}`;
    const elapsed = -msUntilStart;
    if (elapsed < 60000) return 'Starting now';
    return `Started ${durationLabel(elapsed)} ago`;
}

export function formatEventRange(event, locale = undefined, timeZone = undefined) {
    const startMs = Date.parse(event?.start);
    if (!Number.isFinite(startMs)) return '';
    const formatter = new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit', ...(timeZone ? { timeZone } : {}) });
    const clean = value => formatter.format(value).replace(/ /g, ' ');
    const endMs = Date.parse(event?.end);
    if (!Number.isFinite(endMs) || endMs <= startMs) return clean(startMs);
    return `${clean(startMs)} – ${clean(endMs)}`;
}
