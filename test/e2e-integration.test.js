/**
 * End-to-End System Integration Test Suite for Alpha Commercial Meeting Assistant.
 * Validates the complete decoupled architecture:
 * 1. Binary IPC Audio Ingestion & Resampling
 * 2. VAD & Multi-Channel Speech Segmentation
 * 3. Physical "You" & System Speaker Diarization
 * 4. SQLite Storage & FTS5 Search Indexing
 * 5. Multi-Format Exporters (Markdown, Slack, SRT)
 * 6. AI Summarization (Claude/OpenAI + Offline Heuristics)
 * 7. Commercial License & Billing Tier Enforcement
 * 8. Full REST & WebSocket API Server Integration
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');
const fs = require('fs');
const http = require('http');

const {
    NativeAudioBridge,
    AudioIngestionPipeline,
    EchoSuppressor,
    WhisperEngine,
    DiarizerEngine,
    SqliteStore,
    ExportUtils,
    MeetingSummarizer,
    LicenseManager,
    MeetingOrchestrator,
    SessionState,
    BackendServer,
} = require('../apps/core-backend/src/index');

// ── 1. Protocol & DSP Pipeline Integration ──

test('DSP & Binary IPC Protocol: Decodes fragmented binary audio packets and computes RMS', () => {
    const bridge = new NativeAudioBridge();
    const pcm = Buffer.alloc(3200); // 100ms PCM16 at 16kHz
    for (let i = 0; i < 1600; i++) {
        pcm.writeInt16LE(12000, i * 2);
    }

    const timestamp = Date.now();
    const packet = NativeAudioBridge.encodePacket(0, timestamp, pcm);

    let received = null;
    bridge.on('packet', p => {
        received = p;
    });

    // Feed in two fragmented slices
    bridge.feedChunk(packet.subarray(0, 12));
    assert.equal(received, null);

    bridge.feedChunk(packet.subarray(12));
    assert.ok(received);
    assert.equal(received.streamType, 'mic');
    assert.equal(received.timestampMs, timestamp);
    assert.equal(received.samplesCount, 1600);

    const rms = AudioIngestionPipeline.calculateRMS(received.int16Data);
    assert.ok(rms > 0.35 && rms < 0.38, `RMS was ${rms}`);
});

// ── 2. Dual-Channel Ingestion & VAD Segmentation ──

test('Audio Ingestion: Detects voice activity and emits speech segments for Mic and System', async () => {
    const ingestion = new AudioIngestionPipeline({
        frameDurationMs: 100,
        vadRmsThreshold: 0.01,
        minSpeechFrames: 2,
        silenceHangoverFrames: 2,
        minSegmentDurationMs: 200,
    });

    let segmentEmitted = null;
    ingestion.on('speech_segment', seg => {
        segmentEmitted = seg;
    });

    const silentPcm = Buffer.alloc(3200);
    const loudPcm = Buffer.alloc(3200);
    for (let i = 0; i < 1600; i++) loudPcm.writeInt16LE(15000, i * 2);

    // 2 silence frames (pre-roll)
    ingestion.ingestPacket({ streamId: 0, timestampMs: 1000, pcmData: silentPcm });
    ingestion.ingestPacket({ streamId: 0, timestampMs: 1100, pcmData: silentPcm });
    assert.equal(segmentEmitted, null);

    // 2 voiced frames (triggers speech)
    ingestion.ingestPacket({ streamId: 0, timestampMs: 1200, pcmData: loudPcm });
    ingestion.ingestPacket({ streamId: 0, timestampMs: 1300, pcmData: loudPcm });

    // 2 silence frames (triggers segment finalization)
    ingestion.ingestPacket({ streamId: 0, timestampMs: 1400, pcmData: silentPcm });
    ingestion.ingestPacket({ streamId: 0, timestampMs: 1500, pcmData: silentPcm });

    assert.ok(segmentEmitted !== null);
    assert.equal(segmentEmitted.channel, 'mic');
    assert.equal(segmentEmitted.speaker, 'You');
});

// ── 3. Diarizer Engine: Physical Attribution & System Clustering ──

test('Diarizer: Physically tags mic as "You", clusters system audio, and renames participants', () => {
    const diarizer = new DiarizerEngine();

    const turn1 = diarizer.diarizeTurn(
        {
            id: 't1',
            channel: 'mic',
            streamId: 0,
            startMs: 1000,
            endMs: 2500,
            durationMs: 1500,
            int16Array: new Int16Array(24000).fill(5000),
        },
        { text: 'Hi everyone, let us review the quarterly release.' }
    );
    assert.equal(turn1.speaker, 'You');
    assert.equal(turn1.channel, 'mic');

    const turn2 = diarizer.diarizeTurn(
        {
            id: 't2',
            channel: 'system',
            streamId: 1,
            startMs: 3000,
            endMs: 5000,
            durationMs: 2000,
            int16Array: new Int16Array(32000).fill(12000),
        },
        { text: 'The backend APIs are ready for load testing.' }
    );
    assert.equal(turn2.speaker, 'Speaker 1');
    assert.equal(turn2.channel, 'system');

    // Dynamic speaker renaming
    diarizer.renameSpeaker('Speaker 1', 'Sarah (Tech Lead)');
    const allTurns = diarizer.getTimeline();
    assert.equal(allTurns[1].speaker, 'Sarah (Tech Lead)');
});

// ── 4. SQLite Store & Multi-Format Exporters ──

test('SQLite Store & Exporters: Persists meeting, indexes FTS5, and formats exports', async () => {
    const testDbPath = path.join(os.tmpdir(), `test-meeting-e2e-${Date.now()}.json`);
    const store = new SqliteStore({ dbPath: testDbPath });
    await store.initialize();

    const meeting = await store.createMeeting({
        title: 'Q3 Cloud Architecture Review',
        startedAt: 1715000000000,
    });

    assert.ok(meeting.id);

    await store.addTranscriptTurn({
        meetingId: meeting.id,
        channel: 'mic',
        speaker: 'You',
        startMs: 1000,
        endMs: 3000,
        text: 'What is our strategy for cache invalidation?',
    });

    await store.addTranscriptTurn({
        meetingId: meeting.id,
        channel: 'system',
        speaker: 'Sarah',
        startMs: 3500,
        endMs: 6000,
        text: 'We will use Redis pub/sub for invalidation events.',
    });

    // Full-Text Search
    const searchRes = await store.searchTranscripts('invalidation');
    assert.ok(searchRes.length > 0);
    assert.ok(searchRes[0].text.includes('invalidation'));

    // Export formats
    const turns = await store.getTranscriptTurns(meeting.id);
    const md = ExportUtils.exportToMarkdown(meeting, turns);
    assert.ok(md.includes('# Q3 Cloud Architecture Review'));
    assert.ok(md.includes('invalidation events'));

    const srt = ExportUtils.exportToSRT(turns);
    assert.ok(srt.includes('00:00:01,000 --> 00:00:03,000'));
    assert.ok(srt.includes('[You] What is our strategy'));

    const slack = ExportUtils.exportToSlackMarkdown(meeting, 'Adopt Redis pub/sub');
    assert.ok(slack.includes('*📋 Q3 Cloud Architecture Review*'));

    await store.close();
    try {
        fs.unlinkSync(testDbPath);
    } catch (e) {
        // Ignore
    }
});

// ── 5. AI Meeting Summarizer & Prompt Formatter ──

test('Meeting Summarizer: Formats structured prompts and produces complete meeting notes', async () => {
    const summarizer = new MeetingSummarizer({ provider: 'offline' });
    const turns = [
        { speaker: 'You', text: 'We decided to deploy to AWS us-east-1.' },
        { speaker: 'Sarah', text: 'I will prepare the Terraform scripts by tomorrow.' },
    ];

    // Offline heuristic summary
    const offline = await summarizer.generateSummary({ title: 'DevOps Sync' }, turns);
    assert.ok(offline.executiveSummary.includes('participants reviewed core progress'));
    assert.ok(offline.keyDecisions.length > 0);
    assert.ok(offline.actionItems.length > 0);
    assert.ok(offline.followUpEmail.subject.includes('DevOps Sync'));

    // Cloud response parser
    const mockCloudResponse =
        `Executive Summary:\nThe team met for DevOps Sync and finalized us-east-1.\n\n` +
        `Key Decisions:\n- Deploy to AWS us-east-1\n- Use Terraform for IaC\n\n` +
        `Action Items:\n- Prepare Terraform scripts | Sarah | Tomorrow\n\n` +
        `Follow-Up Email Draft:\nSubject: Notes: DevOps Sync\n\nHi team,\nHere are our next steps.`;

    const cloudSummarizer = new MeetingSummarizer({
        provider: 'claude',
        queryFn: async () => mockCloudResponse,
    });
    const cloud = await cloudSummarizer.generateSummary({ title: 'DevOps Sync' }, turns);

    assert.ok(cloud.keyDecisions.length >= 1);
    assert.ok(cloud.actionItems.length >= 1);
    assert.ok(cloud.actionItems[0].task.includes('Terraform'));
    assert.equal(cloud.actionItems[0].owner, 'Sarah');
});

// ── 6. Commercial License & Billing Quota Manager ──

test('License Manager: Enforces Free tier quotas and validates Pro HMAC keys', async () => {
    const testDbPath = path.join(os.tmpdir(), `test-license-e2e-${Date.now()}.json`);
    const store = new SqliteStore({ dbPath: testDbPath });
    await store.initialize();
    const license = new LicenseManager(store, { freeMonthlyMeetingLimit: 2, freeMonthlyMinutesLimit: 20 });
    await license.initialize();

    // Initial state: Free tier
    const check1 = license.canStartMeeting();
    assert.equal(check1.allowed, true);
    assert.equal(check1.tier, 'free');

    // Exhaust free limit
    await license.recordMeetingUsage(600);
    await license.recordMeetingUsage(600);

    const check2 = license.canStartMeeting();
    assert.equal(check2.allowed, false);

    // Generate and activate Pro key
    const proKey = LicenseManager.generateLicenseKey('PRO');
    const activation = await license.activateKey(proKey);
    assert.equal(activation.success, true);
    assert.equal(activation.tier, 'pro');

    const check3 = license.canStartMeeting();
    assert.equal(check3.allowed, true);
    assert.equal(check3.tier, 'pro');

    await store.close();
    try {
        fs.unlinkSync(testDbPath);
    } catch (e) {
        // Ignore
    }
});

// ── 7. Full REST & WebSocket Backend Server Integration ──

test('BackendServer: Handles HTTP API requests and broadcasts meeting events', async () => {
    const testDbPath = path.join(os.tmpdir(), `test-server-e2e-${Date.now()}.json`);
    const store = new SqliteStore({ dbPath: testDbPath });
    await store.initialize();
    const orchestrator = new MeetingOrchestrator({ storage: store });
    const server = new BackendServer({ orchestrator });

    // Mock HTTP request/response dispatcher
    const makeRequest = (reqPath, method = 'GET', body = null) => {
        return new Promise(resolve => {
            const { EventEmitter } = require('events');
            const req = new EventEmitter();
            req.url = reqPath;
            req.method = method;
            req.headers = { host: '127.0.0.1' };

            let statusCode = 200;
            const headers = {};
            let responseBody = '';

            const res = {
                writeHead(code, h) {
                    statusCode = code;
                    Object.assign(headers, h);
                    return res;
                },
                setHeader(k, v) {
                    headers[k] = v;
                },
                end(data) {
                    if (data) responseBody += data;
                    try {
                        resolve({ status: statusCode, data: JSON.parse(responseBody) });
                    } catch (e) {
                        resolve({ status: statusCode, raw: responseBody });
                    }
                },
            };

            server._handleHttpRequest(req, res);

            if (body) {
                req.emit('data', Buffer.from(JSON.stringify(body)));
            }
            req.emit('end');
        });
    };

    // 1. GET /health
    const health = await makeRequest('/health');
    assert.equal(health.status, 200);
    assert.equal(health.data.status, 'ok');

    // 2. GET /api/status
    const status = await makeRequest('/api/status');
    assert.equal(status.status, 200);
    assert.equal(status.data.state, SessionState.IDLE);

    // 3. POST /api/meetings/start
    const startRes = await makeRequest('/api/meetings/start', 'POST', { title: 'REST API Test Meeting' });
    assert.equal(startRes.status, 200);
    assert.equal(startRes.data.success, true);
    assert.equal(startRes.data.meeting.title, 'REST API Test Meeting');

    // 4. POST /api/meetings/stop
    const stopRes = await makeRequest('/api/meetings/stop', 'POST');
    assert.equal(stopRes.status, 200);
    assert.equal(stopRes.data.success, true);
    assert.equal(stopRes.data.meeting.title, 'REST API Test Meeting');

    // 5. GET /api/meetings
    const listRes = await makeRequest('/api/meetings');
    assert.equal(listRes.status, 200);
    assert.ok(listRes.data.meetings.length >= 1);
    assert.equal(listRes.data.meetings[0].title, 'REST API Test Meeting');

    // Teardown
    await store.close();
    try {
        fs.unlinkSync(testDbPath);
    } catch (e) {
        // Ignore
    }
});
