/**
 * Complete Core Backend Test Suite.
 * Validates Audio Ingestion, VAD, Echo Suppressor, STT, Diarization, SQLite, AI Summarizer, Billing, Orchestrator, and Server.
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
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
    ClaudeCliClient,
    LicenseManager,
    MeetingOrchestrator,
    SessionState,
    BackendServer,
} = require('../src/index');

let passedTests = 0;
let failedTests = 0;

async function test(name, fn) {
    try {
        await fn();
        console.log(`  ✅ ${name}`);
        passedTests++;
    } catch (err) {
        console.error(`  ❌ ${name}`);
        console.error(`     ${err.stack || err.message}`);
        failedTests++;
    }
}

async function runAllTests() {
    console.log('\n======================================================');
    console.log('🧪 RUNNING CORE BACKEND ENGINE TEST SUITE');
    console.log('======================================================\n');

    /* ----------------------------------------------------------------- */
    /* 1. NativeAudioBridge Tests                                        */
    /* ----------------------------------------------------------------- */
    console.log('📦 1. Native Audio Bridge & 16-Byte Protocol:');

    await test('Encodes and decodes 16-byte protocol packet accurately', async () => {
        const bridge = new NativeAudioBridge();
        const testPcm = Buffer.alloc(3200); // 100ms at 16kHz 16-bit
        for (let i = 0; i < 1600; i++) {
            testPcm.writeInt16LE(Math.floor(Math.sin(i * 0.1) * 10000), i * 2);
        }

        const now = Date.now();
        const packet = NativeAudioBridge.encodePacket(0, now, testPcm);
        assert.strictEqual(packet.length, 16 + 3200);

        let receivedPacket = null;
        bridge.on('packet', p => {
            receivedPacket = p;
        });

        // Feed in fragmented chunks (e.g. 10 bytes then rest)
        bridge.feedChunk(packet.subarray(0, 10));
        assert.strictEqual(receivedPacket, null); // Not complete yet

        bridge.feedChunk(packet.subarray(10));
        assert.ok(receivedPacket);
        assert.strictEqual(receivedPacket.streamId, 0);
        assert.strictEqual(receivedPacket.streamType, 'mic');
        assert.strictEqual(receivedPacket.payloadLength, 3200);
        assert.strictEqual(receivedPacket.samplesCount, 1600);
        assert.strictEqual(receivedPacket.int16Data.length, 1600);
    });

    await test('Generates synthetic packets with configurable frequency', async () => {
        const bridge = new NativeAudioBridge();
        const { packet, pcmBuffer, numSamples } = bridge.generateSyntheticPacket(1, 100, 440, 0.5);
        assert.strictEqual(packet.length, 16 + pcmBuffer.length);
        assert.strictEqual(numSamples, 1600);
    });

    /* ----------------------------------------------------------------- */
    /* 2. Audio Ingestion & VAD Tests                                    */
    /* ----------------------------------------------------------------- */
    console.log('\n📦 2. Audio Ingestion, 16kHz Resampling & RMS VAD:');

    await test('Calculates RMS accurately from Int16 samples', async () => {
        const silentSamples = new Int16Array(1600).fill(0);
        const silentRms = AudioIngestionPipeline.calculateRMS(silentSamples);
        assert.strictEqual(silentRms, 0);

        const loudSamples = new Int16Array(1600).fill(16384); // 50% amplitude
        const loudRms = AudioIngestionPipeline.calculateRMS(loudSamples);
        assert.ok(loudRms > 0.49 && loudRms < 0.51);
    });

    await test('Resamples 48kHz stereo to 16kHz mono', async () => {
        const pipeline = new AudioIngestionPipeline();
        const stereo48k = Buffer.alloc(4800 * 2 * 2); // 100ms at 48kHz stereo
        const resampled = pipeline.resampleTo16kHz(stereo48k, 48000, 2);
        assert.strictEqual(resampled.length, 1600 * 2); // 100ms at 16kHz mono
    });

    await test('Detects speech frames and emits speech_segment with pre-roll', async () => {
        const pipeline = new AudioIngestionPipeline({
            frameDurationMs: 100,
            vadRmsThreshold: 0.01,
            minSpeechFrames: 2,
            silenceHangoverFrames: 3,
            minSegmentDurationMs: 200,
        });

        const emittedSegments = [];
        pipeline.on('speech_segment', seg => emittedSegments.push(seg));

        // 1. Send 2 silence frames (pre-roll)
        const silencePcm = Buffer.alloc(3200);
        pipeline.ingestPacket({ streamId: 0, timestampMs: 1000, pcmData: silencePcm });
        pipeline.ingestPacket({ streamId: 0, timestampMs: 1100, pcmData: silencePcm });

        // 2. Send 4 loud speech frames
        const speechPcm = Buffer.alloc(3200);
        for (let i = 0; i < 1600; i++) speechPcm.writeInt16LE(15000, i * 2);

        pipeline.ingestPacket({ streamId: 0, timestampMs: 1200, pcmData: speechPcm });
        pipeline.ingestPacket({ streamId: 0, timestampMs: 1300, pcmData: speechPcm });
        pipeline.ingestPacket({ streamId: 0, timestampMs: 1400, pcmData: speechPcm });
        pipeline.ingestPacket({ streamId: 0, timestampMs: 1500, pcmData: speechPcm });

        // 3. Send 3 silence frames to trigger hangover offset
        pipeline.ingestPacket({ streamId: 0, timestampMs: 1600, pcmData: silencePcm });
        pipeline.ingestPacket({ streamId: 0, timestampMs: 1700, pcmData: silencePcm });
        pipeline.ingestPacket({ streamId: 0, timestampMs: 1800, pcmData: silencePcm });

        assert.strictEqual(emittedSegments.length, 1);
        assert.strictEqual(emittedSegments[0].channel, 'mic');
        assert.strictEqual(emittedSegments[0].speaker, 'You');
        assert.ok(emittedSegments[0].durationMs >= 600); // 4 speech + silence/pre-roll
    });

    /* ----------------------------------------------------------------- */
    /* 3. Echo Suppressor Tests                                          */
    /* ----------------------------------------------------------------- */
    console.log('\n📦 3. Acoustic Echo Suppressor:');

    await test('Identifies matching energy profile and rejects acoustic bleed', async () => {
        const suppressor = new EchoSuppressor({ correlationThreshold: 0.6 });

        const pcm = Buffer.alloc(32000); // 1s
        const int16Array = new Int16Array(16000);
        for (let i = 0; i < 16000; i++) {
            int16Array[i] = Math.floor(Math.sin(i * 0.05) * 8000);
            pcm.writeInt16LE(int16Array[i], i * 2);
        }

        const now = Date.now();
        const sysSeg = {
            id: 'sys_1',
            startMs: now,
            endMs: now + 1000,
            durationMs: 1000,
            rms: 0.25,
            int16Array,
        };

        suppressor.recordSystemSegment(sysSeg);

        // Simulated mic echo 50ms later with slightly lower amplitude
        const micSeg = {
            id: 'mic_1',
            startMs: now + 50,
            endMs: now + 1050,
            durationMs: 1000,
            rms: 0.15,
            int16Array,
        };

        const result = suppressor.filterMicSegment(micSeg);
        assert.ok(result.isEcho);
        assert.ok(result.confidence > 0.6);
    });

    await test('Filters duplicate recognized transcript tokens', async () => {
        const suppressor = new EchoSuppressor({ similarityThreshold: 0.7 });
        const now = Date.now();
        suppressor.recordSystemTranscript('let us review the backend architecture for meeting capture', now);

        const dupCheck = suppressor.isDuplicateTranscript("let's review the backend architecture for meeting capture", now + 1000);
        assert.ok(dupCheck.isDuplicate);
        assert.ok(dupCheck.similarity >= 0.7);

        const uniqueCheck = suppressor.isDuplicateTranscript('we should also check the UI client components', now + 1000);
        assert.strictEqual(uniqueCheck.isDuplicate, false);
    });

    /* ----------------------------------------------------------------- */
    /* 4. Whisper STT Engine Tests                                       */
    /* ----------------------------------------------------------------- */
    console.log('\n📦 4. Speech-to-Text Whisper Engine:');

    await test('Transcribes audio segment via mock/fallback backend with high confidence', async () => {
        const stt = new WhisperEngine({ backend: 'mock' });
        await stt.initialize();

        const dummyPcm = Buffer.alloc(16000 * 2); // 1s
        const result = await stt.transcribe({
            id: 'seg_test_1',
            channel: 'mic',
            speaker: 'You',
            durationMs: 1000,
            audioBuffer: dummyPcm,
        });

        assert.ok(result.text.length > 0);
        assert.strictEqual(result.backend, 'mock');
        assert.ok(result.confidence >= 0.9);
    });

    /* ----------------------------------------------------------------- */
    /* 5. Diarization Engine Tests                                       */
    /* ----------------------------------------------------------------- */
    console.log('\n📦 5. Speaker Diarization & Timeline Interleaver:');

    await test('Assigns physical mic turns to "You" and partitions system audio into Speaker clusters', async () => {
        const diarizer = new DiarizerEngine();

        // 1. Mic Turn
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
            { text: "Hello everyone, let's start the project sync." }
        );

        assert.strictEqual(turn1.speaker, 'You');
        assert.strictEqual(turn1.channel, 'mic');

        // 2. System Speaker Turn
        const turn2 = diarizer.diarizeTurn(
            {
                id: 't2',
                channel: 'system',
                streamId: 1,
                startMs: 2600,
                endMs: 4000,
                durationMs: 1400,
                int16Array: new Int16Array(22400).fill(12000),
            },
            { text: 'Sounds good, I am ready with the updates.' }
        );

        assert.strictEqual(turn2.speaker, 'Speaker 1');
        assert.strictEqual(turn2.channel, 'system');

        // Timeline ordering
        const timeline = diarizer.getTimeline();
        assert.strictEqual(timeline.length, 2);
        assert.strictEqual(timeline[0].speaker, 'You');
        assert.strictEqual(timeline[1].speaker, 'Speaker 1');
    });

    await test('Renames speaker labels dynamically and propagates across turns', async () => {
        const diarizer = new DiarizerEngine();
        diarizer.diarizeTurn(
            {
                id: 't1',
                channel: 'system',
                streamId: 1,
                startMs: 1000,
                endMs: 2000,
                int16Array: new Int16Array(16000),
            },
            { text: 'I will deploy the update.' }
        );

        diarizer.renameSpeaker('Speaker 1', 'Sarah');
        const timeline = diarizer.getTimeline();
        assert.strictEqual(timeline[0].speaker, 'Sarah');
    });

    /* ----------------------------------------------------------------- */
    /* 6. SQLite Store & FTS Search Tests                                */
    /* ----------------------------------------------------------------- */
    console.log('\n📦 6. SQLite Storage & Full-Text Search:');

    const tempDbPath = path.join(os.tmpdir(), `test_alpha_${Date.now()}.sqlite`);
    const store = new SqliteStore({ dbPath: tempDbPath });

    await test('Creates meeting, saves turns, and executes search', async () => {
        await store.initialize();

        const meeting = await store.createMeeting({
            title: 'Q3 Product Strategy Sync',
            startedAt: Date.now(),
        });
        assert.ok(meeting.id);

        await store.addTranscriptTurn({
            meetingId: meeting.id,
            channel: 'mic',
            speaker: 'You',
            startMs: 1000,
            endMs: 3000,
            text: 'We should accelerate our desktop audio engine rollout.',
        });

        await store.addTranscriptTurn({
            meetingId: meeting.id,
            channel: 'system',
            speaker: 'Alex',
            startMs: 3200,
            endMs: 5000,
            text: 'I agree, the latency optimizations are performing well.',
        });

        const turns = await store.getTranscriptTurns(meeting.id);
        assert.strictEqual(turns.length, 2);

        const searchResults = await store.searchTranscripts('latency');
        assert.ok(searchResults.length > 0);
        assert.ok(searchResults[0].text.includes('latency'));

        // Action items
        await store.saveActionItems(meeting.id, [{ task: 'Ship audio resampler', owner: 'Alex', deadline: 'Friday' }]);
        const items = await store.getActionItems(meeting.id);
        assert.strictEqual(items.length, 1);
        assert.strictEqual(items[0].task, 'Ship audio resampler');

        await store.close();
    });

    /* ----------------------------------------------------------------- */
    /* 7. Export Utilities Tests                                         */
    /* ----------------------------------------------------------------- */
    console.log('\n📦 7. Multi-Format Exporters:');

    await test('Generates valid Markdown, JSON, PlainText, SRT, VTT, and Slack exports', async () => {
        const dummyMeeting = {
            id: 'm1',
            title: 'Weekly Standup',
            startedAt: Date.now(),
            durationSeconds: 1800,
        };
        const dummyTurns = [
            { startMs: 1000, endMs: 4000, speaker: 'You', text: 'Good morning everyone.' },
            { startMs: 4500, endMs: 9000, speaker: 'Sarah', text: 'Good morning, all tasks on track.' },
        ];
        const dummyActions = [{ task: 'Deploy v1.0', owner: 'You', deadline: 'Tomorrow' }];

        const md = ExportUtils.exportToMarkdown(dummyMeeting, dummyTurns, dummyActions);
        assert.ok(md.includes('# Weekly Standup'));
        assert.ok(md.includes('Deploy v1.0'));
        assert.ok(md.includes('**You**: Good morning everyone.'));

        const jsonStr = ExportUtils.exportToJSON(dummyMeeting, dummyTurns, dummyActions);
        const parsed = JSON.parse(jsonStr);
        assert.strictEqual(parsed.title, 'Weekly Standup');
        assert.strictEqual(parsed.transcript.length, 2);

        const srt = ExportUtils.exportToSRT(dummyTurns);
        assert.ok(srt.includes('00:00:01,000 --> 00:00:04,000'));

        const vtt = ExportUtils.exportToVTT(dummyTurns);
        assert.ok(vtt.includes('WEBVTT'));

        const slack = ExportUtils.exportToSlackMarkdown(dummyMeeting, 'Great progress', dummyActions);
        assert.ok(slack.includes('*📋 Weekly Standup*'));
    });

    /* ----------------------------------------------------------------- */
    /* 8. AI Summarizer & Heuristics Tests                               */
    /* ----------------------------------------------------------------- */
    console.log('\n📦 8. AI Meeting Summarizer & Offline Heuristic Engine:');

    await test('Generates structured offline summary, decisions, and action items', async () => {
        const summarizer = new MeetingSummarizer({ provider: 'offline' });
        const turns = [
            { speaker: 'You', text: "Let's align on the release schedule." },
            { speaker: 'David', text: 'We decided to deploy the new build on Thursday.' },
            { speaker: 'Sarah', text: 'I will prepare the release notes and test checklist.' },
            { speaker: 'You', text: 'Action item: verify all WebSocket endpoints before launch.' },
        ];

        const result = await summarizer.generateSummary({ title: 'Release Alignment' }, turns);
        assert.ok(result.executiveSummary.length > 10);
        assert.ok(result.keyDecisions.length > 0);
        assert.ok(result.actionItems.length >= 2);
        assert.ok(result.followUpEmail.subject.includes('Release Alignment'));
        assert.strictEqual(result.provider, 'offline_heuristic');
    });

    console.log('\n\ud83d\udce6 8b. Claude Code CLI Summarization Transport:');

    const CLI_TURNS = [
        { speaker: 'You', text: 'We need to lock the beta date today.', startMs: 1000 },
        { speaker: 'Priya', text: 'I will send the release notes on Thursday.', startMs: 9000 },
    ];

    const CLI_MARKDOWN = [
        '# Meeting Summary',
        '',
        '## \ud83d\udccc Executive Summary',
        'The team locked the beta release date and assigned the release notes.',
        '',
        '```json',
        JSON.stringify(
            {
                executiveSummary: 'The team locked the beta release date and assigned the release notes.',
                keyDecisions: ['Ship the beta on Friday'],
                actionItems: [{ task: 'Send release notes', owner: 'Priya', deadline: 'Thursday', priority: 'High' }],
                followUpEmail: { subject: 'Beta ships Friday', body: 'Hi team,' },
                topics: ['Beta readiness'],
            },
            null,
            2
        ),
        '```',
    ].join('\n');

    function fakeCliSpawn({ stdout = '', stderr = '', code = 0 } = {}) {
        const calls = [];
        const spawnFn = (binary, args, options) => {
            const call = { binary, args, options, stdin: '' };
            calls.push(call);
            const handlers = {};
            const child = {
                stdout: {
                    on: (event, fn) => {
                        if (event === 'data') handlers.stdout = fn;
                    },
                },
                stderr: {
                    on: (event, fn) => {
                        if (event === 'data') handlers.stderr = fn;
                    },
                },
                stdin: {
                    on: () => {},
                    end: chunk => {
                        call.stdin = chunk || '';
                    },
                },
                on: (event, fn) => {
                    handlers[event] = fn;
                },
                kill: () => {},
            };
            setImmediate(() => {
                if (stdout && handlers.stdout) handlers.stdout(Buffer.from(stdout));
                if (stderr && handlers.stderr) handlers.stderr(Buffer.from(stderr));
                if (handlers.close) handlers.close(code);
            });
            return child;
        };
        return { spawnFn, calls };
    }

    function cliEnvelope(result, extra = {}) {
        return JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result, total_cost_usd: 0.01, ...extra });
    }

    await test('Invokes the CLI non-interactively with the transcript on stdin', async () => {
        const { spawnFn, calls } = fakeCliSpawn({ stdout: cliEnvelope('{"ok":true}') });
        const client = new ClaudeCliClient({ binaryPath: process.execPath, spawnFn });

        const result = await client.run({
            instruction: 'Summarize the transcript.',
            systemPrompt: 'You are a summarizer.',
            input: 'transcript body',
            jsonSchema: { type: 'object' },
        });

        assert.strictEqual(calls.length, 1);
        const args = calls[0].args;
        assert.strictEqual(args[0], '--print');
        assert.strictEqual(args[1], 'Summarize the transcript.');
        assert.strictEqual(args[args.indexOf('--output-format') + 1], 'json');
        assert.ok(args.includes('--no-session-persistence'), "must not litter the user's session history");
        assert.ok(args.includes('--safe-mode'), 'summaries must not depend on local project settings');
        assert.strictEqual(args[args.indexOf('--system-prompt') + 1], 'You are a summarizer.');
        assert.ok(args.includes('--json-schema'));
        assert.strictEqual(calls[0].stdin, 'transcript body');
        assert.strictEqual(calls[0].options.env.MAX_THINKING_TOKENS, '0');
        assert.strictEqual(result.text, '{"ok":true}');
        assert.strictEqual(result.costUsd, 0.01);
    });

    await test('Surfaces structured output and CLI failures', async () => {
        const structured = fakeCliSpawn({
            stdout: cliEnvelope('{"executiveSummary":"Done."}', { structured_output: { executiveSummary: 'Done.' } }),
        });
        const okClient = new ClaudeCliClient({ binaryPath: process.execPath, spawnFn: structured.spawnFn });
        const ok = await okClient.run({ instruction: 'go' });
        assert.strictEqual(ok.structured.executiveSummary, 'Done.');

        const failing = fakeCliSpawn({ stderr: 'Invalid API key\nmore detail', code: 1 });
        const failClient = new ClaudeCliClient({ binaryPath: process.execPath, spawnFn: failing.spawnFn });
        await assert.rejects(() => failClient.run({ instruction: 'go' }), /exited with 1: Invalid API key/);

        const errored = fakeCliSpawn({ stdout: JSON.stringify({ is_error: true, result: 'Credit balance is too low' }) });
        const errClient = new ClaudeCliClient({ binaryPath: process.execPath, spawnFn: errored.spawnFn });
        await assert.rejects(() => errClient.run({ instruction: 'go' }), /Credit balance is too low/);

        const garbage = fakeCliSpawn({ stdout: 'not json at all' });
        const garbageClient = new ClaudeCliClient({ binaryPath: process.execPath, spawnFn: garbage.spawnFn });
        await assert.rejects(() => garbageClient.run({ instruction: 'go' }), /unparseable/);
    });

    await test('Reports the CLI as unavailable when the binary is missing', async () => {
        const client = new ClaudeCliClient({ binaryPath: path.join(os.tmpdir(), 'definitely-not-claude') });
        assert.strictEqual(client.isAvailable(), false);
        await assert.rejects(() => client.run({ instruction: 'go' }), /not found/);
    });

    await test('Summarizes a meeting through the CLI provider', async () => {
        const { spawnFn, calls } = fakeCliSpawn({ stdout: cliEnvelope(CLI_MARKDOWN) });
        const summarizer = new MeetingSummarizer({
            provider: 'claude-cli',
            claudeCliClient: new ClaudeCliClient({ binaryPath: process.execPath, spawnFn }),
        });

        const result = await summarizer.generateSummary({ title: 'Beta Sync' }, CLI_TURNS);
        assert.strictEqual(result.provider, 'claude-cli');
        assert.strictEqual(result.keyDecisions[0], 'Ship the beta on Friday');
        assert.strictEqual(result.actionItems[0].owner, 'Priya');
        assert.strictEqual(result.followUpEmail.subject, 'Beta ships Friday');
        assert.ok(calls[0].args[1].includes('[00:01] You: We need to lock the beta date today.'));
    });

    await test('Falls back to the offline heuristic when the CLI fails', async () => {
        const { spawnFn } = fakeCliSpawn({ stderr: 'not logged in', code: 1 });
        const summarizer = new MeetingSummarizer({
            provider: 'claude-cli',
            claudeCliClient: new ClaudeCliClient({ binaryPath: process.execPath, spawnFn }),
        });

        const warnings = [];
        summarizer.on('warning', w => warnings.push(w.message));

        const result = await summarizer.generateSummary({ title: 'Beta Sync' }, CLI_TURNS);
        assert.strictEqual(result.provider, 'offline_heuristic');
        assert.ok(result.actionItems.length > 0);
        assert.ok(warnings.some(m => m.includes('claude-cli')));
    });

    await test('Auto mode prefers an API key, then the CLI, then offline', async () => {
        const available = new ClaudeCliClient({ binaryPath: process.execPath, spawnFn: fakeCliSpawn().spawnFn });
        const missing = new ClaudeCliClient({ binaryPath: path.join(os.tmpdir(), 'definitely-not-claude') });

        const keyed = new MeetingSummarizer({ anthropicApiKey: 'sk-test', claudeCliClient: available });
        assert.strictEqual(keyed._resolveProvider(keyed.options), 'claude');

        const cliOnly = new MeetingSummarizer({ anthropicApiKey: null, openaiApiKey: null, claudeCliClient: available });
        assert.strictEqual(cliOnly._resolveProvider(cliOnly.options), 'claude-cli');

        const nothing = new MeetingSummarizer({ anthropicApiKey: null, openaiApiKey: null, claudeCliClient: missing });
        assert.strictEqual(nothing._resolveProvider(nothing.options), 'offline');
    });

    await test('Resolves generic speaker labels through the CLI', async () => {
        const { spawnFn } = fakeCliSpawn({ stdout: cliEnvelope('Here you go:\n{"Speaker 1": "Priya Nair"}') });
        const summarizer = new MeetingSummarizer({
            provider: 'claude-cli',
            claudeCliClient: new ClaudeCliClient({ binaryPath: process.execPath, spawnFn }),
        });

        const mapping = await summarizer.resolveSpeakerNames(CLI_TURNS, ['Speaker 1']);
        assert.deepStrictEqual(mapping, { 'Speaker 1': 'Priya Nair' });
    });

    /* ----------------------------------------------------------------- */
    /* 9. Billing & License Manager Tests                                */
    /* ----------------------------------------------------------------- */
    console.log('\n📦 9. Billing & Commercial License Manager:');

    await test('Enforces Free tier meeting limits and validates Pro keys', async () => {
        const tempLicenseDb = path.join(os.tmpdir(), `test_lic_${Date.now()}.json`);
        const licStore = new SqliteStore({ dbPath: tempLicenseDb });
        await licStore.initialize();

        const licManager = new LicenseManager(licStore, { freeMonthlyMeetingLimit: 2, freeMonthlyMinutesLimit: 20 });
        await licManager.initialize();

        // 1. Initial Free Tier
        const canStart1 = licManager.canStartMeeting();
        assert.strictEqual(canStart1.allowed, true);
        assert.strictEqual(canStart1.tier, 'free');

        // Record 2 meetings (exhaust free limit)
        await licManager.recordMeetingUsage(600); // 10 min
        await licManager.recordMeetingUsage(600); // 10 min

        const canStart2 = licManager.canStartMeeting();
        assert.strictEqual(canStart2.allowed, false); // Limit reached!

        // Generate and activate Pro License Key
        const proKey = LicenseManager.generateLicenseKey('PRO');
        const activation = await licManager.activateKey(proKey);
        assert.strictEqual(activation.success, true);
        assert.strictEqual(activation.tier, 'pro');

        const canStart3 = licManager.canStartMeeting();
        assert.strictEqual(canStart3.allowed, true);
        assert.strictEqual(canStart3.tier, 'pro');

        await licStore.close();
    });

    /* ----------------------------------------------------------------- */
    /* 10. Orchestrator End-to-End Lifecycle Test                        */
    /* ----------------------------------------------------------------- */
    console.log('\n📦 10. Central Meeting Session Orchestrator:');

    await test('Full meeting session lifecycle (Start -> Audio Stream -> STT -> Diarize -> Stop -> Summarize)', async () => {
        const tempOrchDb = path.join(os.tmpdir(), `test_orch_${Date.now()}.json`);
        const orchStore = new SqliteStore({ dbPath: tempOrchDb });

        const orchestrator = new MeetingOrchestrator({
            storage: orchStore,
            sttOptions: { backend: 'mock' },
            aiOptions: { provider: 'offline' },
            ingestionOptions: {
                minSegmentDurationMs: 100,
                vadRmsThreshold: 0.005,
                silenceHangoverFrames: 1,
            },
        });

        await orchestrator.initialize();
        assert.strictEqual(orchestrator.state, SessionState.IDLE);

        // Start meeting
        const meeting = await orchestrator.startMeeting({ title: 'Architecture Sync' });
        assert.strictEqual(orchestrator.state, SessionState.RECORDING);
        assert.strictEqual(meeting.title, 'Architecture Sync');

        // Stream audio packet (mic)
        const micAudio = Buffer.alloc(1600 * 4); // 200ms loud audio
        for (let i = 0; i < 1600 * 2; i++) micAudio.writeInt16LE(12000, i * 2);
        const micPacket = NativeAudioBridge.encodePacket(0, Date.now(), micAudio);
        orchestrator.feedAudioPacket({ streamId: 0, pcmData: micAudio, timestampMs: Date.now() });

        // Stream silence to trigger VAD speech offset
        const silenceAudio = Buffer.alloc(3200);
        orchestrator.feedAudioPacket({ streamId: 0, pcmData: silenceAudio, timestampMs: Date.now() + 300 });

        // Wait brief moment for STT and diarization
        await new Promise(r => setTimeout(r, 400));

        // Stop meeting and summarize
        const completed = await orchestrator.stopMeeting({ summarize: true });
        assert.strictEqual(completed.id, meeting.id);
        assert.ok(completed.endedAt > 0);
        assert.ok(completed.summaryMarkdown.length > 0);

        const status = orchestrator.getLiveStatus();
        assert.strictEqual(status.state, SessionState.IDLE);

        await orchStore.close();
    });

    /* ----------------------------------------------------------------- */
    /* 11. Backend API Server Test                                       */
    /* ----------------------------------------------------------------- */
    console.log('\n📦 11. Standalone HTTP REST & WebSocket Server:');

    await test('Dispatches /health, /api/status, and /api/meetings through BackendServer', async () => {
        const tempServerDb = path.join(os.tmpdir(), `test_srv_${Date.now()}.json`);
        const serverStore = new SqliteStore({ dbPath: tempServerDb });
        await serverStore.initialize();

        const orch = new MeetingOrchestrator({ storage: serverStore, sttOptions: { backend: 'mock' } });
        const server = new BackendServer({ port: 49123, orchestrator: orch });

        // 1. Test /health route handler
        const healthRes = await simulateHttpRequest(server, 'GET', '/health');
        assert.strictEqual(healthRes.statusCode, 200);
        assert.strictEqual(healthRes.body.status, 'ok');
        assert.strictEqual(healthRes.body.version, '1.0.0');

        // 2. Test /api/status route handler
        const statusRes = await simulateHttpRequest(server, 'GET', '/api/status');
        assert.strictEqual(statusRes.statusCode, 200);
        assert.strictEqual(statusRes.body.state, 'IDLE');

        // 3. Test /api/meetings route handler
        const meetingsRes = await simulateHttpRequest(server, 'GET', '/api/meetings');
        assert.strictEqual(meetingsRes.statusCode, 200);
        assert.ok(Array.isArray(meetingsRes.body.meetings));

        // 4. Test /api/license/status
        const licRes = await simulateHttpRequest(server, 'GET', '/api/license/status');
        assert.strictEqual(licRes.statusCode, 200);
        assert.strictEqual(licRes.body.tier, 'free');

        await serverStore.close();
    });

    console.log('\n======================================================');
    console.log(`📊 TEST SUITE SUMMARY: ${passedTests} Passed, ${failedTests} Failed`);
    console.log('======================================================\n');

    if (failedTests > 0) {
        process.exit(1);
    }
}

/**
 * Simulate an HTTP request to BackendServer._handleHttpRequest
 */
function simulateHttpRequest(server, method, pathname, payload = null) {
    return new Promise(async (resolve, reject) => {
        const { EventEmitter } = require('events');
        const req = new EventEmitter();
        req.method = method;
        req.url = pathname;
        req.headers = { host: '127.0.0.1:49123' };

        let statusCode = 200;
        const headers = {};
        let responseData = '';

        const res = {
            setHeader(k, v) {
                headers[k] = v;
            },
            writeHead(code, h = {}) {
                statusCode = code;
                Object.assign(headers, h);
            },
            end(chunk) {
                if (chunk) responseData += chunk;
                let parsedBody = responseData;
                try {
                    parsedBody = JSON.parse(responseData);
                } catch (_) {}
                resolve({ statusCode, headers, body: parsedBody });
            },
        };

        try {
            const handlePromise = server._handleHttpRequest(req, res);
            if (payload) {
                req.emit('data', Buffer.from(JSON.stringify(payload)));
            }
            req.emit('end');
            await handlePromise;
        } catch (e) {
            reject(e);
        }
    });
}

runAllTests().catch(err => {
    console.error('Fatal Test Suite Error:', err);
    process.exit(1);
});
