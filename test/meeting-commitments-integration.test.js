// Real local Rust HTTP flow, synthetic data only, no remote services.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

test('commitments require grounded review and survive reload, completion and regeneration', { timeout: 30000 }, async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kesami-commitments-http-'));
    let backend;
    t.after(async () => {
        if (backend?.exitCode === null) { backend.kill('SIGTERM'); await once(backend, 'exit'); }
        await fs.rm(root, { recursive: true, force: true });
    });
    const probe = net.createServer();
    probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
    const port = probe.address().port;
    await new Promise(resolve => probe.close(resolve));
    const library = path.join(root, 'library');
    // Batch mode without a recording cannot call STT; posted synthetic turns
    // exercise completion even with automatic AI summaries disabled.
    await fs.writeFile(path.join(root, 'settings.json'), JSON.stringify({ transcriptionProvider: 'sarvam', autoSummarize: false }));
    const transcript = [
        ['Riyam', "I'll send the proposal tomorrow."],
        ['Riyam', "I'll check this with engineering."],
        ['John', "I'll create the Jira ticket."],
        ['Riyam', "Let's schedule a follow-up next Tuesday."],
        ['Riyam', "If approved, I'll send the contract."],
        ['Riyam', 'John will send the API documentation on Friday.'],
        ['Riyam', 'I might create another ticket.'],
        ['Riyam', 'The API will be faster next week.'],
        ['Riyam', 'For example. I will send a fake proposal.'],
    ].map(([speaker, text], i) => ({ id: `t${i}`, speaker, text, channel: 'mic', startMs: i * 1000, endMs: i * 1000 + 900, confidence: 1 }));
    const meeting = { id: 'synthetic', title: 'Synthetic commitments', startedAt: 0, endedAt: 10000,
        durationSeconds: 10, createdAt: 0, summaryMarkdown: '', actionItems: [], keyDecisions: [], metadata: {}, transcript };
    for (const m of [meeting, { ...meeting, id: 'live', endedAt: null }]) {
        await fs.mkdir(path.join(library, m.id), { recursive: true });
        await fs.writeFile(path.join(library, m.id, 'meeting.json'), JSON.stringify(m));
    }
    const fake = path.join(root, 'fake-claude');
    await fs.writeFile(fake, `#!${process.execPath}
process.stdin.resume();
process.stdin.on('end', () => process.stdout.write(JSON.stringify({structured_output:{
executiveSummary:'Synthetic recap.',sections:[],keyDecisions:[],followUpEmail:{subject:'',body:''},memoryFacts:[],
actionItems:[{task:'Send the proposal',owner:'Riyam',deadline:'Monday',priority:'Medium',sourceTurns:[0]}]
}})));
`, { mode: 0o700 });
    const env = { ...process.env };
    for (const key of Object.keys(env)) {
        if (/SUPABASE|DATABASE|POSTGRES|KESAMI_CLOUD|ALPHA_CLOUD/.test(key)) delete env[key];
    }
    Object.assign(env, { KESAMI_DATA_DIR: root, KESAMI_LIBRARY_DIR: library, KESAMI_RECORDINGS_DIR: library,
        CORE_BACKEND_DATA_FILE: path.join(root, 'absent.json'), CORE_BACKEND_PORT: String(port),
        KESAMI_CLOUD_URL: '', ALPHA_CLOUD_URL: '', KESAMI_GEMINI_API_KEY: '', KESAMI_OPENAI_API_KEY: '', KESAMI_SARVAM_API_KEY: 'synthetic-test-key',
        KESAMI_CHAT_EMBEDDINGS: 'off', KESAMI_CLAUDE_BIN: fake, KESAMI_SUMMARY_PROVIDER: 'claude' });
    env.KESAMI_SARVAM_REALTIME_URL = `ws://127.0.0.1:${port}/disabled-stt`;
    const start = async () => {
        backend = spawn(path.resolve(__dirname, '../apps/core-backend/target/debug/kesami-core-backend'), [], { cwd: root, env, stdio: 'ignore' });
        let error; backend.on('error', value => { error = value; });
        for (let i = 0; i < 100; i++) {
            if (error) throw error;
            if (backend.exitCode !== null) throw new Error('Test backend exited before becoming ready');
            try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return; } catch {}
            await new Promise(resolve => setTimeout(resolve, 50));
        }
        throw new Error('Build the Rust debug backend before running commitments integration');
    };
    await start();
    const api = async (route, body, method = body === undefined ? 'GET' : 'POST') => {
        const response = await fetch(`http://127.0.0.1:${port}${route}`, { method,
            headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
        return { status: response.status, data: await response.json() };
    };
    const route = '/api/meetings/synthetic/commitments';
    assert.equal((await api(route)).data.current, false);
    assert.equal((await api('/api/meetings/live/commitments', {})).status, 409);
    assert.equal((await api('/api/meetings/missing/commitments', {})).status, 404);
    const detected = await api(route, {});
    assert.equal(detected.status, 200, JSON.stringify(detected.data));
    assert.equal(detected.data.meeting.actionItems.length, 0, 'detection creates no tasks');
    const memory = detected.data.meeting.metadata.meetingCommitments;
    const promise = memory.candidates.find(c => c.sourceTurnIds.includes('t0'));
    const otherSpeaker = memory.candidates.find(c => c.sourceTurnIds.includes('t2'));
    const suggestion = memory.candidates.find(c => c.classification === 'suggested_action');
    const discussion = memory.candidates.find(c => c.classification === 'discussion');
    assert.equal(promise.person, 'Riyam'); assert.equal(promise.dueDate, 'tomorrow'); assert.equal(promise.confidence, 'high');
    assert.equal(otherSpeaker.person, 'John');
    assert.equal(suggestion.person, ''); assert.equal(suggestion.dueDate, 'next Tuesday');
    assert.ok(memory.candidates.some(c => c.classification === 'other_person_commitment' && c.person === 'John'));
    assert.ok(memory.candidates.some(c => c.classification === 'unclear'));
    for (const candidate of memory.candidates) assert.ok(transcript.find(turn => turn.id === candidate.sourceTurnIds[0]).text.includes(candidate.commitment));
    const review = { status: 'confirmed', transcriptRevision: memory.transcriptRevision, person: promise.person, targetAction: promise.targetAction };
    assert.equal((await api(`${route}/${promise.id}`, { ...review, person: '' }, 'PATCH')).status, 400);
    assert.equal((await api(`${route}/${promise.id}`, { ...review, transcriptRevision: 'stale' }, 'PATCH')).status, 409);
    assert.equal((await api(`${route}/${discussion.id}`, review, 'PATCH')).status, 400);
    assert.equal((await api(`${route}/unknown`, review, 'PATCH')).status, 404);
    const folder = (await api('/api/folders', { name: 'Synthetic project' })).data.folders[0];
    const results = await Promise.all([
        ...Array.from({ length: 3 }, () => api(`${route}/${promise.id}`, review, 'PATCH')),
        api('/api/meetings/synthetic/notes', { text: 'A manually reviewed note.' }),
        api('/api/meetings/synthetic/folder', { folderId: folder.id }, 'PATCH'),
    ]);
    assert.ok(results.every(r => r.status === 200));
    let saved = (await api('/api/meetings/synthetic')).data.meeting;
    assert.equal(saved.actionItems.length, 1, 'concurrent confirmations are idempotent');
    const task = saved.actionItems[0];
    assert.equal(saved.metadata.collectionId, folder.id);
    assert.equal(saved.notes.length, 1, 'notes and review updates do not overwrite each other');
    assert.equal((await api(`/api/meetings/synthetic/notes/${saved.notes[0].id}`, undefined, 'DELETE')).status, 200);
    assert.equal(task.confirmation, 'human_reviewed'); assert.equal(task.sourceQuote, transcript[0].text);
    assert.deepEqual(task.sourceTurnIds, ['t0']); assert.equal(task.completed, false);
    assert.equal((await api(`${route}/${suggestion.id}`, { status: 'dismissed', transcriptRevision: memory.transcriptRevision }, 'PATCH')).status, 200);
    await api('/api/meetings/synthetic', { actionItems: [{ ...task, completed: true }] }, 'PATCH');
    const regenerated = await api('/api/meetings/synthetic/summarize', { regenerate: true });
    assert.equal(regenerated.status, 200, JSON.stringify(regenerated.data));
    saved = (await api('/api/meetings/synthetic')).data.meeting;
    assert.equal(saved.actionItems.length, 1);
    assert.deepEqual(saved.actionItems[0], { ...task, completed: true }, 'AI regeneration cannot replace a reviewed task or its provenance');
    const repeated = (await api(route, {})).data.meeting.metadata.meetingCommitments;
    assert.equal(repeated.candidates.find(c => c.id === promise.id).status, 'confirmed');
    assert.equal(repeated.candidates.find(c => c.id === suggestion.id).status, 'dismissed');
    const stored = JSON.parse(await fs.readFile(path.join(library, saved.folder, 'meeting.json'), 'utf8'));
    assert.equal(stored.actionItems[0].completed, true);
    backend.kill('SIGTERM'); await once(backend, 'exit'); await start();
    const restored = (await api(route)).data;
    assert.equal(restored.current, true); assert.equal(restored.candidates.find(c => c.id === promise.id).status, 'confirmed');
    const edited = await api('/api/meetings/synthetic', { speakerRenames: { Riyam: 'Asha' } }, 'PATCH');
    assert.equal(edited.status, 200);
    assert.equal((await api(route)).data.current, false);
    assert.equal((await api(`${route}/${promise.id}`, review, 'PATCH')).status, 409);
    const refreshed = (await api(route, {})).data.meeting;
    assert.equal(refreshed.metadata.meetingCommitments.candidates.find(c => c.sourceTurnIds.includes('t0')).person, 'Asha');
    assert.equal(refreshed.actionItems.length, 1, 'source correction preserves the existing task');
    assert.equal(refreshed.actionItems[0].completed, true);
    const started = await api('/api/meetings/start', { title: 'Synthetic recorded promise' });
    assert.equal(started.status, 200, JSON.stringify(started.data));
    const finished = await api('/api/meetings/stop', { transcript: [{ ...transcript[0], speaker: 'You' }] });
    assert.equal(finished.status, 200, JSON.stringify(finished.data));
    const finalMeeting = finished.data.meeting;
    assert.equal(finalMeeting.summaryMarkdown, '', 'auto-summarize off suppresses automatic summary generation');
    assert.equal(finalMeeting.metadata.meetingCommitments.candidates[0].classification, 'explicit_commitment');
    assert.equal(finalMeeting.metadata.meetingCommitments.candidates[0].person, 'You');
    assert.equal(finalMeeting.metadata.meetingCommitments.candidates[0].dueDate, 'tomorrow');
    assert.equal(finalMeeting.actionItems.length, 0, 'automatic detection still requires human confirmation');
    const finalRoute = `/api/meetings/${finalMeeting.id}`;
    const candidate = finalMeeting.metadata.meetingCommitments.candidates[0];
    assert.equal((await api(`${finalRoute}/commitments/${candidate.id}`, { status: 'confirmed', person: 'You', targetAction: candidate.targetAction, transcriptRevision: finalMeeting.metadata.meetingCommitments.transcriptRevision }, 'PATCH')).status, 200);
    const note = await api(`${finalRoute}/notes`, { text: 'Review saved after recording.' });
    assert.equal(note.status, 200);
    await api(`${finalRoute}/notes/${note.data.note.id}`, undefined, 'DELETE');
    const current = (await api(finalRoute)).data.meeting;
    assert.equal(current.actionItems.length, 1, 'completed-session note edits preserve confirmations');
    assert.equal(current.metadata.meetingCommitments.candidates[0].status, 'confirmed');
    const retryStop = await api('/api/meetings/stop', {});
    assert.equal(retryStop.data.meeting.actionItems.length, 1, 'idempotent stop returns the current reviewed record');
});
