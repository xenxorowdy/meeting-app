const test = require('node:test');
const assert = require('node:assert/strict');

const { tidyName, observationFrom, sameObservation, ActivityTracker } = require('../apps/extension/src/content/observer.js');

test('participant labels lose the role suffixes the meeting UIs add', () => {
    assert.equal(tidyName('  Aditi   Sharma  '), 'Aditi Sharma');
    assert.equal(tidyName('Riyam Jain (You)'), 'Riyam Jain');
    assert.equal(tidyName('Riyam Jain (Host, me)'), 'Riyam Jain');
    assert.equal(tidyName('Aditi [Guest]'), 'Aditi');
    assert.equal(tidyName('Riyam (Dentira)'), 'Riyam (Dentira)');
});

test('labels that are not somebody are dropped rather than sent', () => {
    assert.equal(tidyName('You'), '');
    assert.equal(tidyName('Everyone'), '');
    assert.equal(tidyName('  '), '');
    assert.equal(tidyName('🎤'), '');
    assert.equal(tidyName('a'.repeat(81)), '');
    assert.equal(tidyName(null), '');
});

test('an observation is a deduplicated roster plus whoever is talking', () => {
    const observation = observationFrom([
        { name: 'Riyam Jain (You)', speaking: false },
        { name: 'Aditi', speaking: true },
        { name: 'Aditi', speaking: false },
        { name: '(Host)', speaking: true },
    ]);
    assert.deepEqual(observation.participants, ['Riyam Jain', 'Aditi']);
    assert.deepEqual(observation.speaking, ['Aditi']);
});

test('identical observations are recognised so the backend is not spammed', () => {
    const first = observationFrom([{ name: 'Aditi', speaking: true }]);
    const second = observationFrom([{ name: 'Aditi', speaking: true }]);
    const third = observationFrom([{ name: 'Aditi', speaking: false }]);
    assert.equal(sameObservation(first, second), true);
    assert.equal(sameObservation(first, third), false);
    assert.equal(sameObservation(first, null), false);
});

test('the activity fallback picks the tile that is animating, and only when it stands out', () => {
    const tracker = new ActivityTracker(700);
    const now = 10_000;
    for (let i = 0; i < 6; i += 1) tracker.record('Aditi', now - i * 50);
    tracker.record('Riyam', now - 100);
    assert.equal(tracker.active(now), 'Aditi');

    const tied = new ActivityTracker(700);
    for (let i = 0; i < 4; i += 1) {
        tied.record('Aditi', now - i * 50);
        tied.record('Riyam', now - i * 50);
    }
    assert.equal(tied.active(now), null);

    const quiet = new ActivityTracker(700);
    quiet.record('Aditi', now - 5_000);
    assert.equal(quiet.active(now), null);
});
