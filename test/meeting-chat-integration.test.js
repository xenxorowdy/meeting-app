// Real Rust HTTP routes + a local fake provider. All state and prompts are synthetic.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { once } = require('node:events');

test('Rust chat retrieves bounded evidence, persists threads, cancels and invalidates sources', { timeout: 30000 }, async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'alpha-chat-http-'));
    let backend;
    t.after(async () => {
        if (backend && backend.exitCode === null) { backend.kill('SIGTERM'); await once(backend, 'exit'); }
        await fs.rm(root, { recursive: true, force: true });
    });
    const probe = net.createServer();
    probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
    const port = probe.address().port;
    await new Promise(resolve => probe.close(resolve));
    const library = path.join(root, 'library');
    await fs.mkdir(path.join(root, '.alpha-meeting-assistant'));
    await fs.writeFile(path.join(root, '.alpha-meeting-assistant', 'settings.json'), JSON.stringify({ transcriptionProvider: 'sarvam' }));
    const fixtures = Array.from({ length: 205 }, (_, i) => ({
        id: `m${i}`, title: `Synthetic meeting ${i}`, startedAt: 1000 + i, endedAt: 2000 + i,
        durationSeconds: 1, createdAt: 1000, metadata: {}, summaryMarkdown: '', keyDecisions: [],
        actionItems: i === 204 ? Array.from({ length: 105 }, (_, n) => ({ task: `Task ${n}`, owner: 'Asha' })) : [],
        transcript: [{ id: 't1', channel: 'system', speaker: 'Asha', startMs: 10, endMs: 100, confidence: 1,
            text: i === 204 ? `${'Unrelated cafeteria discussion. '.repeat(200)} Zephyr deadline is Friday. ${'Unrelated weather discussion. '.repeat(200)}` : 'Outside scope secret: Monday deadline.' }],
    }));
    const liveFixture = { ...fixtures[204], id: 'live', endedAt: null, actionItems: [], transcript: [
        { ...fixtures[204].transcript[0], text: 'Zephyr deadline is Friday.' },
    ] };
    for (const m of [...fixtures, liveFixture, { ...liveFixture, id: 'live-empty', transcript: [] }]) {
        const folder = path.join(library, m.id); await fs.mkdir(folder, { recursive: true });
        await fs.writeFile(path.join(folder, 'meeting.json'), JSON.stringify(m));
    }
    const fake = path.join(root, 'fake-claude');
    await fs.writeFile(fake, `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[args.indexOf('--tools') + 1] !== '' || !args.includes('--strict-mcp-config') || !args.includes('--disable-slash-commands')) process.exit(3);
let input = '';
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', () => {
  const packet = JSON.parse(input);
  fs.appendFileSync(process.env.ALPHA_CHAT_CAPTURE, input + '\\n');
  const correcting = args[args.indexOf('--system-prompt') + 1].includes('Your previous response failed validation:');
  let answer = 'Friday [1]';
  let citations = [1];
  if (packet.question.includes('repair missing') && !correcting) answer = 'Friday';
  if (packet.question.includes('repair grouped') && !correcting) answer = 'Friday [1, 1]';
  if (packet.question.includes('invalid forever')) { answer = 'Friday [999]'; citations = [999]; }
  const finish = () => process.stdout.write(JSON.stringify({ structured_output: { answer, citations, status: 'answered' } }));
  if (packet.question.includes('slow')) setTimeout(finish, 2000); else finish();
});
`, { mode: 0o700 });
    const capture = path.join(root, 'capture.jsonl');
    backend = spawn(path.resolve(__dirname, '../apps/core-backend/target/debug/alpha-core-backend'), [], {
        cwd: root, stdio: ['ignore', 'ignore', 'ignore'],
        env: { ...process.env, ALPHA_DATA_DIR: root, ALPHA_LIBRARY_DIR: library, CORE_BACKEND_DATA_FILE: path.join(root, 'absent.json'),
            CORE_BACKEND_PORT: String(port), CORE_BACKEND_WHISPER_BIN: path.join(root, 'missing-whisper'), ALPHA_CLAUDE_BIN: fake,
            ALPHA_SUMMARY_PROVIDER: 'claude', ALPHA_GEMINI_API_KEY: '', ALPHA_SARVAM_API_KEY: '', ALPHA_CHAT_EMBEDDINGS: 'off', ALPHA_CHAT_CAPTURE: capture },
    });
    let spawnError;
    backend.on('error', error => { spawnError = error; });
    const base = `http://127.0.0.1:${port}`;
    let ready = false;
    for (let i = 0; i < 100; i++) {
        if (spawnError) throw spawnError;
        if (backend.exitCode !== null) throw new Error('Test backend exited before becoming ready');
        try { if ((await fetch(`${base}/health`)).ok) { ready = true; break; } } catch {}
        await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.ok(ready, 'Build the Rust debug backend before this test');
    const api = async (route, body, method = body === undefined ? 'GET' : 'POST') => {
        const response = await fetch(`${base}${route}`, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
        return { status: response.status, data: await response.json() };
    };
    const { data: thread } = await api('/api/chat/threads', { scope: { type: 'meetings', meetingIds: ['m204'] } });
    assert.ok(thread.id);
    const route = `/api/chat/threads/${thread.id}/messages`;
    const request = { question: 'What is the Zephyr deadline?', requestId: randomUUID() };
    const first = await api(route, request);
    assert.equal(first.status, 200, JSON.stringify(first.data));
    assert.equal(first.data.answer, 'Friday [1]');
    assert.equal(first.data.citations[0].meetingId, 'm204');
    assert.equal(first.data.citations[0].startMs, 10);
    let prompts = (await fs.readFile(capture, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(prompts.length, 1);
    assert.ok(JSON.stringify(prompts[0]).length <= 8000);
    assert.ok(JSON.stringify(prompts[0]).includes('Zephyr deadline is Friday'));
    assert.ok(!JSON.stringify(prompts[0]).includes('Outside scope secret'));
    assert.ok(!JSON.stringify(prompts[0]).includes(fixtures[204].transcript[0].text));
    assert.deepEqual((await api(route, request)).data, first.data);
    assert.equal((await fs.readFile(capture, 'utf8')).trim().split('\n').length, 1, 'retry must not call provider again');

    const list = await api('/api/chat/threads'); assert.equal(list.data.threads.length, 1);
    const history = await api(route); assert.equal(history.data.messages.length, 2);
    const followup = await api(route, { question: 'Who set that deadline?', requestId: randomUUID() });
    assert.equal(followup.status, 200);
    prompts = (await fs.readFile(capture, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.ok(prompts.at(-1).conversation.some(m => m.content === request.question));
    assert.ok(prompts.at(-1).conversation.every(m => m.role === 'user'));

    for (const scenario of ['repair missing', 'repair grouped']) {
        const repairRequest = { question: `${scenario}: Zephyr deadline?`, requestId: randomUUID() };
        const before = (await fs.readFile(capture, 'utf8')).trim().split('\n').length;
        const repaired = await api(route, repairRequest);
        assert.equal(repaired.status, 200, JSON.stringify(repaired.data));
        assert.equal(repaired.data.answer, 'Friday [1]');
        assert.equal(repaired.data.citations[0].number, 1);
        const calls = (await fs.readFile(capture, 'utf8')).trim().split('\n').map(JSON.parse);
        assert.equal(calls.length, before + 2, 'one automatic correction attempt');
        assert.deepEqual(calls.at(-1), calls.at(-2), 'correction uses the same bounded evidence');
        assert.deepEqual((await api(route, repairRequest)).data, repaired.data);
        assert.equal((await fs.readFile(capture, 'utf8')).trim().split('\n').length, before + 2);
        const saved = (await api(route)).data.messages.filter(m => m.requestId === repairRequest.requestId);
        assert.equal(saved.length, 2, 'one user turn and one validated assistant turn');
    }
    const invalidRequest = { question: 'invalid forever: Zephyr deadline?', requestId: randomUUID() };
    const beforeInvalid = (await fs.readFile(capture, 'utf8')).trim().split('\n').length;
    const invalid = await api(route, invalidRequest);
    assert.notEqual(invalid.status, 200);
    assert.match(invalid.data.error, /valid source references/);
    assert.equal((await fs.readFile(capture, 'utf8')).trim().split('\n').length, beforeInvalid + 2, 'retries are bounded');
    assert.ok(!(await api(route)).data.messages.some(m => m.requestId === invalidRequest.requestId && m.role === 'assistant'));

    const liveThread = (await api('/api/chat/threads', { scope: { type: 'meetings', meetingIds: ['live'] } })).data;
    assert.equal(liveThread.eligibleMeetings, 1);
    const liveRoute = `/api/chat/threads/${liveThread.id}/messages`;
    const livePending = api(liveRoute, { question: 'slow live Zephyr deadline?', requestId: randomUUID() });
    for (let i = 0; i < 50; i++) {
        if ((await fs.readFile(capture, 'utf8')).includes('slow live Zephyr')) break;
        await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal((await api('/api/meetings/live/notes', { text: 'New note while the AI is answering' })).status, 200);
    const liveAnswer = await livePending;
    assert.equal(liveAnswer.status, 200, JSON.stringify(liveAnswer.data));
    assert.equal(liveAnswer.data.coverage.live, true);
    assert.equal(liveAnswer.data.coverage.capturedThroughMs, 100);
    const liveCitation = liveAnswer.data.citations[0];
    assert.match(liveCitation.sourceRevision, /^live:/);
    assert.equal((await api(`/api/chat/sources/live?revision=${liveCitation.sourceRevision}`)).status, 200);
    assert.equal((await api(liveRoute)).data.messages.find(m => m.role === 'assistant').citations[0].available, true);
    const livePrompt = (await fs.readFile(capture, 'utf8')).trim().split('\n').map(JSON.parse).at(-1);
    assert.equal(livePrompt.coverage.live, true);
    assert.match(livePrompt.scopeNote, /in progress/);
    assert.ok(!JSON.stringify(livePrompt).includes('New note while'));
    const liveActions = await api(liveRoute, { question: 'List every action item for Zephyr', requestId: randomUUID() });
    assert.equal(liveActions.data.retrievalMode, 'keyword', 'live actions use speech, not unfinished summary fields');
    const emptyThread = (await api('/api/chat/threads', { scope: { type: 'meetings', meetingIds: ['live-empty'] } })).data;
    const emptyAnswer = await api(`/api/chat/threads/${emptyThread.id}/messages`, { question: 'Zephyr deadline?', requestId: randomUUID() });
    assert.equal(emptyAnswer.data.status, 'insufficient_evidence');
    assert.match(emptyAnswer.data.answer, /captured so far/);

    const all = await api('/api/chat/threads', { scope: { type: 'all' } });
    assert.equal(all.data.eligibleMeetings, 205);
    const actionRoute = `/api/chat/threads/${all.data.id}/messages`;
    const actions = await api(actionRoute, { question: 'List every action item', requestId: randomUUID() });
    assert.equal(actions.data.coverage.totalItems, 105);
    assert.equal(actions.data.coverage.shownItems, 100);
    assert.equal(actions.data.coverage.nextPage, 2);
    const page2 = await api(actionRoute, { question: 'List every action item, page 2', requestId: randomUUID() });
    assert.equal(page2.data.coverage.shownItems, 5);
    assert.equal(page2.data.coverage.nextPage, null);
    const noEvidence = await api(route, { question: 'Quantum aardvark?', requestId: randomUUID() });
    assert.equal(noEvidence.data.status, 'insufficient_evidence');

    const slowId = randomUUID();
    const slow = api(route, { question: 'slow Zephyr deadline?', requestId: slowId });
    for (let i = 0; i < 50; i++) {
        if ((await fs.readFile(capture, 'utf8')).includes('slow Zephyr')) break;
        await new Promise(resolve => setTimeout(resolve, 20));
    }
    await api(`/api/chat/threads/${thread.id}/requests/${slowId}/cancel`, {});
    assert.equal((await slow).data.code, 'cancelled');
    assert.ok(!(await api(route)).data.messages.some(m => m.requestId === slowId && m.role === 'assistant'));

    await api('/api/meetings/m204', undefined, 'DELETE');
    const afterDelete = await api(route);
    assert.equal(afterDelete.data.messages.find(m => m.role === 'assistant').citations[0].available, false);
    assert.notEqual((await api(`/api/chat/sources/m204?revision=${first.data.citations[0].sourceRevision}`)).status, 200);
    await api(`/api/chat/threads/${thread.id}`, undefined, 'DELETE');
    assert.notEqual((await api(route)).status, 200);
});
