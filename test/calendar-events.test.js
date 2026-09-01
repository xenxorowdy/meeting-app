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

test('dueForReminder fires inside the lead window for a real meeting', async () => {
    const { dueForReminder } = await load();
    const soon = event('soon', 0.5, [person('a@example.com'), person('b@example.com')]);
    assert.deepEqual(
        dueForReminder([soon], NOW).map(entry => entry.id),
        ['soon']
    );
});

test('dueForReminder ignores solo holds and meetings already under way', async () => {
    const { dueForReminder } = await load();
    const solo = event('solo', 0.5, [person('a@example.com')]);
    const started = event('started', -1, [person('a@example.com'), person('b@example.com')]);
    const distant = event('distant', 10, [person('a@example.com'), person('b@example.com')]);
    assert.deepEqual(dueForReminder([solo, started, distant], NOW), []);
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
        organizer: 'asha@example.com',
        startMs: NOW,
        endMs: NOW + 1,
    });
    assert.equal(stored.id, 'sync');
    assert.equal(stored.joinUrl, 'https://meet.google.com/abc-defg-hij');
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
