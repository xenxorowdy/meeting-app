const assert = require('node:assert/strict');
const { test } = require('node:test');
const load = () => import('../apps/ui/src/lib/backend.js');

// The payload shape is the backend's `transcript_interim` event body
// (main.rs: consume_live_events → LiveEvent::Partial).
const partial = (channel, text, speaker) => ({ meetingId: 'm1', channel, speaker, text });

test('a partial replaces the previous one for its own channel only', async () => {
    const { mergeInterim } = await load();

    let interim = mergeInterim([], partial('mic', 'so the plan', 'You'));
    assert.deepEqual(
        interim.map(turn => [turn.speaker, turn.text]),
        [['You', 'so the plan']]
    );

    interim = mergeInterim(interim, partial('mic', 'so the plan is to ship', 'You'));
    assert.equal(interim.length, 1, 'the same speaker mid-sentence is one line, not two');
    assert.equal(interim[0].text, 'so the plan is to ship');

    interim = mergeInterim(interim, partial('system', 'agreed', 'Speaker 1'));
    assert.deepEqual(
        interim.map(turn => [turn.stream, turn.text]),
        [
            ['mic', 'so the plan is to ship'],
            ['system', 'agreed'],
        ]
    );
});

test('an empty partial clears that channel', async () => {
    const { mergeInterim } = await load();
    const interim = mergeInterim(mergeInterim([], partial('mic', 'half a word', 'You')), partial('mic', '   ', 'You'));
    assert.deepEqual(interim, []);
});

test('interim turns are marked and carry the channel speaker, never the stale label', async () => {
    const { mergeInterim, normalizeTurn } = await load();
    const [turn] = mergeInterim([], partial('mic', 'testing', 'Speaker 1'));

    assert.equal(turn.interim, true);
    assert.equal(turn.speaker, 'You', 'the microphone is always the local user');
    assert.equal(turn.id, 'interim-mic');
    assert.notEqual(turn.id, normalizeTurn({ channel: 'mic', text: 'testing' }).id, 'a committed turn must not collide with a partial');
});
