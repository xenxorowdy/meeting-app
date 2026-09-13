const assert = require('node:assert/strict');
const { test } = require('node:test');
const load = () => import('../apps/ui/src/lib/chat.js');

test('meeting selection order does not lose the conversation scope', async () => {
    const { scopeKey } = await load();
    assert.equal(scopeKey({ type: 'meetings', meetingIds: ['a', 'b'] }), scopeKey({ type: 'meetings', meetingIds: ['b', 'a'] }));
    assert.notEqual(scopeKey({ type: 'all' }), scopeKey({ type: 'folder', folderId: null }));
});

test('citations resolve original turns and reject unavailable or replaced sources', async () => {
    const { citationTarget, citationTime } = await load();
    const meeting = { id: 'm1', transcript: [{ id: 'turn-2', startMs: 65000 }] };
    const citation = { meetingId: 'm1', turnIds: ['turn-2'], startMs: 0 };
    assert.equal(citationTarget(citation, meeting).startMs, 65000);
    assert.equal(citationTarget({ ...citation, available: false }, meeting), null);
    assert.equal(citationTarget({ ...citation, turnIds: ['deleted'] }, meeting), null);
    assert.equal(citationTarget(citation, { ...meeting, id: 'm2' }), null);
    assert.equal(citationTime(65000), '1:05');
    assert.equal(citationTime(null), '');
});

test('reconnected history does not duplicate a retried user message', async () => {
    const { mergeMessages } = await load();
    const user = { requestId: 'r1', role: 'user', content: 'When?' };
    const assistant = { requestId: 'r1', role: 'assistant', content: 'Friday [1]' };
    assert.deepEqual(mergeMessages([user], [user, assistant]), [user, assistant]);
});

test('copied answers replace known citation markers with a readable source list', async () => {
    const { copyAnswerText } = await load();
    const result = copyAnswerText({
        content: '**Friday [1].**\n\nLiteral `[1]` and unrelated [2026].',
        citations: [{ number: 1, title: 'Roadmap', startMs: 65000 }],
    });
    assert.equal(result, '**Friday.**\n\nLiteral `[1]` and unrelated [2026].\n\nSources\n• Roadmap · 1:05');
    assert.equal(copyAnswerText({ content: 'An ordinary answer [3]' }), 'An ordinary answer [3]');
});
