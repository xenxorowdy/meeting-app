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

test('one agenda fetch covers today through the end of the sixth day', async () => {
    const { calendarAgendaRange, AGENDA_HORIZON_DAYS } = await load();
    const now = new Date(2026, 9, 12, 15, 30).getTime();
    const range = calendarAgendaRange(now);

    assert.equal(AGENDA_HORIZON_DAYS, 6);
    assert.ok(now - range.minutesBack * 60000 <= new Date(2026, 9, 12).getTime(), 'includes the start of today');
    assert.ok(now + range.minutesAhead * 60000 >= new Date(2026, 9, 18).getTime(), 'includes the end of the sixth day');
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

test('calendarAgendaRange keeps the same bounds through the day and moves at midnight', async () => {
    const { calendarAgendaRange } = await load();
    const now = new Date(2026, 9, 12, 15, 30).getTime();
    const first = calendarAgendaRange(now);
    const later = calendarAgendaRange(now + 90000);
    const tomorrow = calendarAgendaRange(new Date(2026, 9, 13, 0, 5).getTime());

    assert.equal(first.startMs, new Date(2026, 9, 12).getTime());
    assert.equal(first.endMs, new Date(2026, 9, 18).getTime());
    assert.equal(later.startMs, first.startMs, 'the cache key holds steady as time passes');
    assert.equal(later.endMs, first.endMs);
    assert.equal(tomorrow.startMs, new Date(2026, 9, 13).getTime(), 'after midnight the window starts at the new today');
});

test('createCalendarCache serves a page for 60 seconds and forgets it after', async () => {
    const { createCalendarCache, CALENDAR_CACHE_MS } = await load();
    let now = 1000;
    const cache = createCalendarCache(CALENDAR_CACHE_MS, () => now);
    const page = { events: [{ id: 'a' }], warnings: [] };

    assert.equal(CALENDAR_CACHE_MS, 60000);
    assert.equal(cache.get('p'), null);
    cache.set('p', page);
    now += 59999;
    assert.equal(cache.get('p'), page);
    now += 1;
    assert.equal(cache.get('p'), null, 'an entry expires at exactly 60 seconds');
    cache.set('p', page);
    cache.clear();
    assert.equal(cache.get('p'), null, 'clear drops cached pages so a calendar change is fetched fresh');
});

test('suggestFolderName drops cadence words, dates, and edge separators from a meeting title', async () => {
    const { suggestFolderName } = await load();
    assert.equal(suggestFolderName('Daily Scrum | Lab Module'), 'Scrum | Lab Module');
    assert.equal(suggestFolderName('Weekly sync - Design'), 'Sync - Design');
    assert.equal(suggestFolderName('Standup 12/10'), 'Standup');
    assert.equal(suggestFolderName('Retro #14 (Oct 12)'), 'Retro');
    assert.equal(suggestFolderName('1:1 with Alex'), '1:1 with Alex');
    assert.equal(suggestFolderName('Dentira.com'), 'Dentira.com');
    assert.equal(suggestFolderName('Weekly'), 'Weekly', 'a title made only of a cadence word is kept');
    assert.equal(suggestFolderName('x'.repeat(80)).length, 60);
    assert.equal(suggestFolderName(''), '');
});

test('suggestedFolder prefers an exact match, then a folder named inside the title', async () => {
    const { suggestedFolder } = await load();
    const folders = [{ id: 'a', name: 'Scrum | Lab Module' }, { id: 'b', name: 'Dentira' }, { id: 'c', name: 'QA' }];
    assert.equal(suggestedFolder('Daily Scrum | Lab Module', folders)?.id, 'a');
    assert.equal(suggestedFolder('Dentira.com sync', folders)?.id, 'b');
    assert.equal(suggestedFolder('Quarterly planning', folders), null, 'very short folder names are not matched inside words');
    assert.equal(suggestedFolder('Anything', []), null);
});

test('eventFolderId lets one event override its series and falls back to the series rule', async () => {
    const { eventFolderId, seriesFolderId } = await load();
    const rules = { events: { 'google:tue': null, 'google:solo': 'f2' }, series: { 'google:scrum': 'f1' } };
    assert.equal(eventFolderId({ provider: 'google', id: 'mon', seriesId: 'scrum' }, rules), 'f1');
    assert.equal(eventFolderId({ provider: 'google', id: 'tue', seriesId: 'scrum' }, rules), null, 'an explicit unfile wins over the series');
    assert.equal(eventFolderId({ provider: 'google', id: 'solo' }, rules), 'f2');
    assert.equal(eventFolderId({ provider: 'google', id: 'other' }, rules), null);
    assert.equal(seriesFolderId({ provider: 'google', id: 'tue', seriesId: 'scrum' }, rules), 'f1');
    assert.equal(eventFolderId({ provider: 'google', id: 'mon', seriesId: 'scrum' }, undefined), null);
});

test('calendarEventMetadata keeps the recurring series id so the backend can file the meeting', async () => {
    const { calendarEventMetadata } = await load();
    assert.equal(calendarEventMetadata({ id: 'e', provider: 'google', seriesId: 'scrum' }).seriesId, 'scrum');
    assert.equal(calendarEventMetadata({ id: 'e', provider: 'google' }).seriesId, null);
});
