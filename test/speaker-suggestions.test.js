const assert = require('node:assert/strict');
const { test } = require('node:test');

const speakers = () => import('../apps/ui/src/lib/speakers.js');
const backend = () => import('../apps/ui/src/lib/backend.js');

const turns = [
    { id: 't1', speaker: 'You', stream: 'mic', startMs: 0, endMs: 3000 },
    { id: 't2', speaker: 'Speaker 2', stream: 'system', startMs: 4000, endMs: 9000 },
    { id: 't3', speaker: 'Speaker 2', stream: 'system', startMs: 12000, endMs: 15000 },
    { id: 't4', speaker: 'Ben Lee', stream: 'system', startMs: 16000, endMs: 18000 },
];

const metadata = {
    participantSelf: 'Riyam Jain',
    participants: ['Riyam Jain', 'Aditi Sharma', 'Ben Lee', 'Chen Wu'],
    speakingActivity: [
        { name: 'Aditi Sharma', startMs: 4200, endMs: 8800 },
        { name: 'Aditi Sharma', startMs: 12100, endMs: 14900 },
        { name: 'Ben Lee', startMs: 8500, endMs: 9500 },
        { name: 'Riyam Jain', startMs: 0, endMs: 3000 },
    ],
    calendarEvent: { attendees: [{ name: 'Dana Fox', email: 'dana@example.com' }, { name: 'Aditi Sharma', email: 'aditi@example.com' }] },
};

test('the person the meeting showed talking during those lines is recommended first', async () => {
    const { speakerSuggestions, suggestionReason } = await speakers();
    const suggestions = speakerSuggestions({ turns, metadata, speaker: 'Speaker 2' });
    assert.deepEqual(
        suggestions.map(suggestion => [suggestion.name, suggestion.source]),
        [
            ['Aditi Sharma', 'activity'],
            ['Ben Lee', 'activity'],
            ['You', 'call'],
            ['Chen Wu', 'call'],
            ['Dana Fox', 'invite'],
        ]
    );
    assert.equal(suggestions[0].recommended, true);
    assert.equal(suggestions[1].recommended, undefined);
    assert.equal(suggestionReason(suggestions[0]), 'Talking during 100% of these lines');
    assert.equal(suggestionReason(suggestions[1]), 'Talking during 16% of these lines');
    assert.equal(suggestionReason(suggestions[4]), 'Invited');
});

test('one line is judged on its own, and the current name is never suggested', async () => {
    const { speakerSuggestions, suggestionReason } = await speakers();
    const line = speakerSuggestions({ turns, metadata, turnId: 't2' });
    assert.equal(line[0].name, 'Aditi Sharma');
    assert.equal(line[0].recommended, true);
    assert.equal(suggestionReason(line[1], true), 'Talking during 26% of this line');

    const quiet = speakerSuggestions({ turns, metadata, turnId: 't4' });
    assert.deepEqual(quiet.map(suggestion => suggestion.name), ['You', 'Aditi Sharma', 'Chen Wu', 'Dana Fox']);
    assert.ok(quiet.every(suggestion => !suggestion.recommended));
});

test('close evidence is offered without a recommendation, and live roster names are included', async () => {
    const { speakerSuggestions } = await speakers();
    const crossTalk = {
        speakingActivity: [
            { name: 'Aditi Sharma', startMs: 4000, endMs: 7000 },
            { name: 'Ben Lee', startMs: 6000, endMs: 9000 },
        ],
    };
    const suggestions = speakerSuggestions({ turns, metadata: crossTalk, roster: ['Eve Park'], turnId: 't2' });
    assert.deepEqual(suggestions.slice(0, 3).map(suggestion => suggestion.name), ['Aditi Sharma', 'Ben Lee', 'Eve Park']);
    assert.ok(suggestions.every(suggestion => !suggestion.recommended));
});

test('nobody is recommended over a label the evidence already supports', async () => {
    const { speakerSuggestions } = await speakers();
    const evidence = {
        speakingActivity: [
            { name: 'Ben Lee', startMs: 16000, endMs: 18000 },
            { name: 'Aditi Sharma', startMs: 16500, endMs: 17200 },
        ],
    };
    const suggestions = speakerSuggestions({ turns, metadata: evidence, turnId: 't4' });
    assert.equal(suggestions[0].name, 'Aditi Sharma');
    assert.ok(suggestions.every(suggestion => !suggestion.recommended));
});

test('generic labels are never offered as names', async () => {
    const { isGenericSpeaker, speakerSuggestions } = await speakers();
    for (const label of ['Speaker', 'Speaker 3', 'Others', 'other', 'Unknown']) assert.equal(isGenericSpeaker(label), true, label);
    for (const label of ['Aditi', 'Speakers Bureau', 'You']) assert.equal(isGenericSpeaker(label), false, label);
    const suggestions = speakerSuggestions({ turns: [...turns, { id: 't5', speaker: 'Speaker 7', startMs: 0, endMs: 1 }], speaker: 'Ben Lee' });
    assert.ok(!suggestions.some(suggestion => isGenericSpeaker(suggestion.name)));
});

test('a speaker set by hand survives the channel rules', async () => {
    const { normalizeTurn } = await backend();
    assert.equal(normalizeTurn({ channel: 'mic', speaker: 'Aditi Sharma', text: 'x' }).speaker, 'You');
    assert.equal(normalizeTurn({ channel: 'system', speaker: 'You', text: 'x' }).speaker, 'Speaker 1');
    const reassigned = normalizeTurn({ channel: 'mic', speaker: 'Aditi Sharma', speakerEdited: true, text: 'x' });
    assert.equal(reassigned.speaker, 'Aditi Sharma');
    assert.equal(reassigned.speakerEdited, true);
    assert.equal(normalizeTurn({ channel: 'system', speaker: 'You', speakerEdited: true, text: 'x' }).speaker, 'You');
    assert.equal(normalizeTurn({ channel: 'system', speaker: '', speakerEdited: true, text: 'x' }).speaker, 'Speaker 1');
});
