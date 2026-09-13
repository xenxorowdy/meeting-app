const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const MODULE_URL = pathToFileURL(path.join(__dirname, '..', 'apps', 'ui', 'src', 'lib', 'calendarEvents.js')).href;
const load = () => import(MODULE_URL);

const NOW = Date.parse('2026-08-31T10:00:00.000Z');
const at = (minutes, durationMinutes = 30) => ({
    start: new Date(NOW + minutes * 60000).toISOString(),
    end: new Date(NOW + (minutes + durationMinutes) * 60000).toISOString(),
});

const event = (id, minutes, attendees = [], durationMinutes = 30) => ({
    id,
    provider: 'google',
    title: `Event ${id}`,
    attendees,
    ...at(minutes, durationMinutes),
});

const person = email => ({ name: null, email });

test('eventForNow claims a meeting started a few minutes early', async () => {
    const { eventForNow } = await load();
    const match = eventForNow([event('standup', 3)], NOW);
    assert.equal(match.id, 'standup');
});

test('eventForNow claims a meeting started a few minutes late', async () => {
    const { eventForNow } = await load();
    const match = eventForNow([event('standup', -2)], NOW);
    assert.equal(match.id, 'standup');
});

test('eventForNow ignores a meeting far outside its slot', async () => {
    const { eventForNow } = await load();
    assert.equal(eventForNow([event('later', 45)], NOW), null);
    assert.equal(eventForNow([event('done', -120)], NOW), null);
});

test('eventForNow picks the slot closest to now when two overlap', async () => {
    const { eventForNow } = await load();
    const match = eventForNow([event('far', -4), event('near', 1)], NOW);
    assert.equal(match.id, 'near');
});

test('eventForNow tolerates an undated or malformed entry', async () => {
    const { eventForNow } = await load();
    assert.equal(eventForNow([{ id: 'broken', start: 'not a date' }], NOW), null);
    assert.equal(eventForNow(null, NOW), null);
});

test('eventsForTodayAndTomorrow keeps both local calendar days separate', async () => {
    const { eventsForTodayAndTomorrow } = await load();
    const now = new Date(2026, 8, 9, 20, 0);
    const today = { id: 'today', start: new Date(2026, 8, 9, 21, 0).toISOString() };
    const tomorrow = { id: 'tomorrow', start: new Date(2026, 8, 10, 9, 0).toISOString() };
    const later = { id: 'later', start: new Date(2026, 8, 11, 9, 0).toISOString() };

    assert.deepEqual(eventsForTodayAndTomorrow([today, tomorrow, later], now.getTime()), {
        today: [today],
        tomorrow: [tomorrow],
    });
});

test('calendarEventLink prefers a meeting link and falls back to supplied or calendar links', async () => {
    const { calendarEventLink } = await load();
    assert.equal(calendarEventLink({ joinUrl: 'https://meet.example/join', links: ['https://docs.example/brief'] }), 'https://meet.example/join');
    assert.equal(calendarEventLink({ links: ['javascript:alert(1)', 'https://docs.example/brief'] }), 'https://docs.example/brief');
    assert.equal(calendarEventLink({ eventUrl: 'https://calendar.example/event' }), 'https://calendar.example/event');
    assert.equal(calendarEventLink({ joinUrl: 'javascript:alert(1)' }), null);
});

test('dueForReminder fires inside the lead window for a real meeting', async () => {
    const { dueForReminder } = await load();
    const soon = event('soon', 0.5, [person('a@example.com'), person('b@example.com')]);
    assert.deepEqual(
        dueForReminder([soon], NOW).map(entry => entry.id),
        ['soon']
    );
});

test('dueForReminder fires for a solo hold as well as an invited meeting', async () => {
    const { dueForReminder } = await load();
    const solo = event('solo', 0.5, [person('a@example.com')]);
    const empty = event('empty', 0.5);
    assert.deepEqual(
        dueForReminder([solo, empty], NOW).map(entry => entry.id),
        ['solo', 'empty']
    );
});

test('dueForReminder ignores meetings already under way and ones still far off', async () => {
    const { dueForReminder } = await load();
    const started = event('started', -1, [person('a@example.com'), person('b@example.com')]);
    const distant = event('distant', 10, [person('a@example.com'), person('b@example.com')]);
    assert.deepEqual(dueForReminder([started, distant], NOW), []);
});

test('reminderKey separates two occurrences of the same recurring event', async () => {
    const { reminderKey } = await load();
    const first = event('weekly', 0);
    const second = event('weekly', 10080);
    assert.notEqual(reminderKey(first), reminderKey(second));
});

test('calendarEventMetadata keeps only the fields the meeting record needs', async () => {
    const { calendarEventMetadata } = await load();
    const stored = calendarEventMetadata({
        ...event('sync', 0, [{ name: 'Asha Rao', email: 'asha@example.com' }]),
        joinUrl: 'https://meet.google.com/abc-defg-hij',
        links: ['https://docs.example/agenda'],
        eventUrl: 'https://calendar.google.com/event/abc',
        organizer: 'asha@example.com',
        startMs: NOW,
        endMs: NOW + 1,
    });
    assert.equal(stored.id, 'sync');
    assert.equal(stored.joinUrl, 'https://meet.google.com/abc-defg-hij');
    assert.deepEqual(stored.links, ['https://docs.example/agenda']);
    assert.equal(stored.eventUrl, 'https://calendar.google.com/event/abc');
    assert.deepEqual(stored.attendees, [{ name: 'Asha Rao', email: 'asha@example.com' }]);
    assert.equal('startMs' in stored, false);
    assert.equal(calendarEventMetadata(null), null);
});

test('attendeeNames prefers display names, falls back to addresses, and de-duplicates', async () => {
    const { attendeeNames } = await load();
    const names = attendeeNames({
        attendees: [
            { name: 'Asha Rao', email: 'asha@example.com' },
            { name: '  ', email: 'ben@example.com' },
            { name: 'Asha Rao', email: 'asha.rao@example.com' },
            { name: null, email: null },
        ],
    });
    assert.deepEqual(names, ['Asha Rao', 'ben@example.com']);
    assert.deepEqual(attendeeNames(null), []);
});

test('durationLabel floors at every level so a countdown never reads higher', async () => {
    const { durationLabel } = await load();
    assert.equal(durationLabel(0), '<1m');
    assert.equal(durationLabel(59_999), '<1m');
    assert.equal(durationLabel(60_000), '1m');
    assert.equal(durationLabel(3_599_999), '59m');
    assert.equal(durationLabel(3_600_000), '1h');
    assert.equal(durationLabel(4_470_000), '1h 14m');
    assert.equal(durationLabel(86_400_000), '1d');
    assert.equal(durationLabel(90_000_000), '1d 1h');
    assert.equal(durationLabel(NaN), '<1m');
});

test('countdownLabel reads now once the meeting has begun', async () => {
    const { countdownLabel } = await load();
    assert.equal(countdownLabel(4_470_000), 'in 1h 14m');
    assert.equal(countdownLabel(300_000), 'in 5m');
    assert.equal(countdownLabel(59_999), 'in <1m');
    assert.equal(countdownLabel(0), 'now');
    assert.equal(countdownLabel(-1), 'now');
    assert.equal(countdownLabel(NaN), 'now');
});

test('startsLabel switches between upcoming, starting, and elapsed', async () => {
    const { startsLabel } = await load();
    assert.equal(startsLabel(4_320_000), 'Starts in 1h 12m');
    assert.equal(startsLabel(30_000), 'Starts in <1m');
    assert.equal(startsLabel(-30_000), 'Starting now');
    assert.equal(startsLabel(-720_000), 'Started 12m ago');
    assert.equal(startsLabel(NaN), 'No upcoming meetings');
});

test('formatEventRange prints a start and end in the viewer locale', async () => {
    const { formatEventRange } = await load();
    const slot = { start: '2026-08-31T17:00:00.000Z', end: '2026-08-31T17:45:00.000Z' };
    assert.equal(formatEventRange(slot, 'en-GB', 'UTC'), '17:00 – 17:45');
    assert.equal(formatEventRange({ start: slot.start }, 'en-GB', 'UTC'), '17:00');
    assert.equal(formatEventRange({ start: slot.start, end: slot.start }, 'en-GB', 'UTC'), '17:00');
    assert.equal(formatEventRange({ start: 'not a date' }, 'en-GB', 'UTC'), '');
    assert.equal(formatEventRange(null, 'en-GB', 'UTC'), '');
});

test('formatEventRange leaves no narrow no-break space for a 12-hour locale', async () => {
    const { formatEventRange } = await load();
    const printed = formatEventRange({ start: '2026-08-31T17:00:00.000Z', end: '2026-08-31T17:45:00.000Z' }, 'en-US', 'UTC');
    assert.equal(printed.includes(' '), false);
    assert.match(printed, /PM – .*PM$/);
});
