const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

const SAMPLE_RATE = 16000;
const STREAM_MIC = 0;
const STREAM_SYSTEM = 1;
const WEBSOCKET_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
// The grace the backend waits for a rejoin or the UI's stop, and the silence
// it tolerates from the meeting client before calling it a dropout. Both must
// stay small enough for the prompt to feel automatic; these tests would catch
// a change that quietly breaks the timings the UI relies on.
const GRACE_MS = 8000;
const DROPOUT_MS = 15000;

async function freePort() {
    const probe = net.createServer();
    probe.listen(0, '127.0.0.1');
    await once(probe, 'listening');
    const { port } = probe.address();
    await new Promise(resolve => probe.close(resolve));
    return port;
}

function vowel(ms, fundamental, formants) {
    const samples = new Float32Array((SAMPLE_RATE * ms) / 1000);
    for (let index = 0; index < samples.length; index += 1) {
        const time = index / SAMPLE_RATE;
        let value = 0;
        for (const centre of formants) {
            const ratio = (fundamental * 3) / centre;
            value += Math.sin(2 * Math.PI * fundamental * time) / Math.sqrt(1 + ratio * ratio);
        }
        samples[index] = value;
    }
    const peak = samples.reduce((loudest, value) => Math.max(loudest, Math.abs(value)), 0);
    const pcm = Buffer.alloc(samples.length * 2);
    for (let index = 0; index < samples.length; index += 1) {
        pcm.writeInt16LE(Math.round((samples[index] / peak) * 0.6 * 32767), index * 2);
    }
    return pcm;
}

function quiet(ms) {
    return Buffer.alloc(((SAMPLE_RATE * ms) / 1000) * 2);
}

function loudness(pcm) {
    if (pcm.length < 2) return 0;
    let total = 0;
    for (let index = 0; index < pcm.length; index += 2) {
        const sample = pcm.readInt16LE(index) / 32768;
        total += sample * sample;
    }
    return Math.sqrt(total / (pcm.length / 2));
}

function audioPacket(streamId, timestampMs, pcm) {
    const header = Buffer.alloc(16);
    header.writeUInt32LE(streamId, 0);
    header.writeBigInt64LE(BigInt(timestampMs), 4);
    header.writeUInt32LE(pcm.length, 12);
    return Buffer.concat([header, pcm]);
}

function frame(opcode, payload) {
    const body = Buffer.from(payload);
    let header;
    if (body.length < 126) {
        header = Buffer.from([0x80 | opcode, body.length]);
    } else {
        header = Buffer.alloc(4);
        header.writeUInt8(0x80 | opcode, 0);
        header.writeUInt8(126, 1);
        header.writeUInt16BE(body.length, 2);
    }
    return Buffer.concat([header, body]);
}

function maskedFrame(opcode, payload) {
    const mask = crypto.randomBytes(4);
    let header;
    if (payload.length < 126) {
        header = Buffer.from([0x80 | opcode, 0x80 | payload.length]);
    } else {
        header = Buffer.alloc(4);
        header.writeUInt8(0x80 | opcode, 0);
        header.writeUInt8(0x80 | 126, 1);
        header.writeUInt16BE(payload.length, 2);
    }
    const body = Buffer.from(payload);
    for (let index = 0; index < body.length; index += 1) body[index] ^= mask[index % 4];
    return Buffer.concat([header, mask, body]);
}

function readFrames(onFrame) {
    let buffer = Buffer.alloc(0);
    return chunk => {
        buffer = Buffer.concat([buffer, chunk]);
        for (;;) {
            if (buffer.length < 2) return;
            const opcode = buffer[0] & 0x0f;
            const masked = (buffer[1] & 0x80) !== 0;
            let length = buffer[1] & 0x7f;
            let offset = 2;
            if (length === 126) {
                if (buffer.length < 4) return;
                length = buffer.readUInt16BE(2);
                offset = 4;
            } else if (length === 127) {
                if (buffer.length < 10) return;
                length = Number(buffer.readBigUInt64BE(2));
                offset = 10;
            }
            let mask = null;
            if (masked) {
                if (buffer.length < offset + 4) return;
                mask = buffer.subarray(offset, offset + 4);
                offset += 4;
            }
            if (buffer.length < offset + length) return;
            const payload = Buffer.from(buffer.subarray(offset, offset + length));
            buffer = buffer.subarray(offset + length);
            if (mask) for (let index = 0; index < payload.length; index += 1) payload[index] ^= mask[index % 4];
            onFrame(opcode, payload);
        }
    };
}

async function openSocket(port, onEvent) {
    const socket = net.connect(port, '127.0.0.1');
    socket.on('error', () => {});
    await once(socket, 'connect');
    const key = crypto.randomBytes(16).toString('base64');
    socket.write(
        `GET /ws HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`
    );

    let buffer = Buffer.alloc(0);
    let upgraded = false;
    socket.on('data', chunk => {
        buffer = Buffer.concat([buffer, chunk]);
        if (!upgraded) {
            const end = buffer.indexOf('\r\n\r\n');
            if (end === -1) return;
            upgraded = true;
            buffer = buffer.subarray(end + 4);
        }
        for (;;) {
            if (buffer.length < 2) return;
            let length = buffer[1] & 0x7f;
            let offset = 2;
            if (length === 126) {
                if (buffer.length < 4) return;
                length = buffer.readUInt16BE(2);
                offset = 4;
            } else if (length === 127) {
                if (buffer.length < 10) return;
                length = Number(buffer.readBigUInt64BE(2));
                offset = 10;
            }
            if (buffer.length < offset + length) return;
            const payload = buffer.subarray(offset, offset + length);
            buffer = buffer.subarray(offset + length);
            if ((buffer[0] & 0x0f) !== 8) {
                try {
                    onEvent(JSON.parse(payload.toString('utf8')));
                } catch {}
            }
        }
    });

    return {
        send: value => socket.write(maskedFrame(1, Buffer.from(JSON.stringify(value)))),
        sendAudio: packet => socket.write(maskedFrame(2, packet)),
        close: () => socket.destroy(),
    };
}

/**
 * A fake Sarvam realtime endpoint, as in live-speakers: audio arrives as
 * base64 `audio_input` messages and one `transcript.final` closes each
 * utterance after a 500 ms silence.
 */
function recogniserStub() {
    let utterance = 0;
    const server = http.createServer((request, response) => {
        response.writeHead(404);
        response.end();
    });

    server.on('upgrade', (request, socket) => {
        const accept = crypto
            .createHash('sha1')
            .update(request.headers['sec-websocket-key'] + WEBSOCKET_GUID)
            .digest('base64');
        socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);

        const QUIET_CHUNKS_TO_CLOSE = 5;
        const connection = { wasLoud: false, speaking: false, quietRun: 0 };
        socket.on('error', () => {});
        socket.on(
            'data',
            readFrames((opcode, payload) => {
                if (opcode === 8) {
                    socket.end();
                    return;
                }
                if (opcode !== 1) return;
                let message;
                try {
                    message = JSON.parse(payload.toString('utf8'));
                } catch {
                    return;
                }
                if (message.event === 'audio_input') {
                    const loud = loudness(Buffer.from(message.audio, 'base64')) > 0.01;
                    if (loud) {
                        connection.wasLoud = true;
                        connection.speaking = true;
                        connection.quietRun = 0;
                    } else if (connection.speaking && ++connection.quietRun >= QUIET_CHUNKS_TO_CLOSE) {
                        connection.speaking = false;
                        socket.write(frame(1, JSON.stringify({ event: 'transcript.final', text: `utterance ${++utterance} is talking`, language: 'en' })));
                    }
                } else if (message.event === 'end') {
                    if (connection.speaking) {
                        connection.speaking = false;
                        socket.write(frame(1, JSON.stringify({ event: 'transcript.final', text: `utterance ${++utterance} is talking`, language: 'en' })));
                    }
                    socket.write(frame(1, JSON.stringify({ event: 'session.end' })));
                }
            })
        );
    });

    return { server };
}

/**
 * One backend per test, isolated data, isolated fake recogniser — the same
 * harness live-speakers uses, plus the participant-observation POSTs that
 * stand in for the browser extension.
 */
async function harness(t, settings = {}) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kesami-meeting-end-'));
    let backend;
    const stub = recogniserStub();
    t.after(async () => {
        if (backend && backend.exitCode === null) {
            backend.kill('SIGTERM');
            await once(backend, 'exit');
        }
        await new Promise(resolve => stub.server.close(resolve));
        await fs.rm(root, { recursive: true, force: true });
    });

    const recogniserPort = await freePort();
    stub.server.listen(recogniserPort, '127.0.0.1');
    await once(stub.server, 'listening');

    await fs.writeFile(
        path.join(root, 'settings.json'),
        JSON.stringify({ transcriptionProvider: 'sarvam-realtime', autoSummarize: false, noiseSuppression: true, echoSuppression: true, ...settings })
    );

    const port = await freePort();
    backend = spawn(path.resolve(__dirname, '../apps/core-backend/target/debug/kesami-core-backend'), [], {
        cwd: root,
        stdio: ['ignore', 'ignore', 'ignore'],
        env: {
            ...process.env,
            KESAMI_DATA_DIR: root,
            KESAMI_LIBRARY_DIR: path.join(root, 'library'),
            CORE_BACKEND_DATA_FILE: path.join(root, 'absent.json'),
            CORE_BACKEND_PORT: String(port),
            KESAMI_SARVAM_API_KEY: 'test-key',
            KESAMI_SARVAM_REALTIME_URL: `ws://127.0.0.1:${recogniserPort}/ws`,
            KESAMI_GEMINI_API_KEY: '',
            KESAMI_CHAT_EMBEDDINGS: 'off',
        },
    });
    let spawnError;
    backend.on('error', error => {
        spawnError = error;
    });

    let ready = false;
    for (let attempt = 0; attempt < 200; attempt += 1) {
        if (spawnError) throw spawnError;
        if (backend.exitCode !== null) throw new Error('the backend exited before becoming ready');
        try {
            if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) {
                ready = true;
                break;
            }
        } catch {}
        await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.ok(ready, 'build the Rust debug backend before this test');

    const events = [];
    const socket = await openSocket(port, event => events.push(event));

    async function waitFor(predicate, ms = 45000, label = 'condition') {
        const deadline = Date.now() + ms;
        while (Date.now() < deadline) {
            if (predicate()) return;
            await new Promise(resolve => setTimeout(resolve, 50));
        }
        assert.ok(false, `timed out waiting for ${label}`);
    }

    async function startMeeting(title = 'Probe') {
        socket.send({ action: 'start_meeting', payload: { title } });
        await waitFor(() => events.some(event => event.type === 'meeting_started'), 15000, 'meeting start');
    }

    async function observe(payload) {
        const response = await fetch(`http://127.0.0.1:${port}/api/session/participants`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ source: 'google-meet', url: 'https://meet.google.com/abc-defg-hij', ...payload }),
        });
        assert.equal(response.status, 200);
        return response.json();
    }

    async function speak(socketStream, pcm, startedAt) {
        let offset = 0;
        for (const block of [...chunk(pcm, 3200)]) {
            socket.sendAudio(audioPacket(socketStream, startedAt + offset, block));
            offset += (block.length / 2 / SAMPLE_RATE) * 1000;
            await new Promise(resolve => setImmediate(resolve));
        }
    }

    const turns = () =>
        events
            .filter(event => event.type === 'transcript_turn')
            .map(event => event.data || event.payload)
            .filter(Boolean);

    return { root, port, events, socket, waitFor, startMeeting, observe, speak, turns };
}

function* chunk(buffer, size) {
    for (let offset = 0; offset < buffer.length; offset += size) {
        yield buffer.subarray(offset, offset + size);
    }
}

test('a muted meeting client silences the microphone until it unmutes', { timeout: 90000 }, async t => {
    const h = await harness(t);
    const { events, socket, waitFor, startMeeting, observe, speak, turns } = h;

    await startMeeting('Mute check');

    // The extension reports the mic muted. One event on the change, and the
    // observation still counts as accepted.
    const first = await observe({ participants: ['Aditi'], speaking: ['Aditi'], micMuted: true });
    assert.equal(first.accepted, true);
    const mutedEvents = events.filter(event => event.type === 'mic_muted').map(event => event.data);
    assert.equal(mutedEvents.length, 1, `expected exactly one mic_muted event: ${JSON.stringify(mutedEvents)}`);
    assert.equal(mutedEvents[0].muted, true);

    // Loud speech on the microphone while the client says it is muted must
    // reach neither the transcriber nor the speech log. Meeting audio still
    // transcribes normally.
    const speech = vowel(3000, 150, [640, 1500, 2700]);
    const others = vowel(3000, 215, [780, 1900, 3100]);
    const startedAt = Date.now();
    await speak(STREAM_SYSTEM, Buffer.concat([others, quiet(1500)]), startedAt);
    await speak(STREAM_MIC, Buffer.concat([speech, quiet(1500)]), startedAt);

    await waitFor(() => turns().some(turn => turn.channel === 'system'), 20000, 'system turn despite client mute');
    assert.equal(turns().filter(turn => turn.channel === 'mic').length, 0, 'muted microphone must produce no mic turns');

    // Unmuting in the client restores the microphone immediately.
    await observe({ participants: ['Aditi'], speaking: ['Aditi'], micMuted: false });
    await waitFor(() => events.filter(event => event.type === 'mic_muted').length === 2, 5000, 'unmute event');

    await speak(STREAM_MIC, Buffer.concat([speech, quiet(1500)]), startedAt + 10000);
    await waitFor(() => turns().some(turn => turn.channel === 'mic' && turn.startMs > 9000), 20000, 'mic turn after unmute');
    assert.ok(turns().filter(turn => turn.channel === 'mic' && turn.startMs > 9000).every(turn => turn.speaker === 'You'));

    socket.close();
});

test('a meeting-end report finishes the meeting after the rejoin grace', { timeout: 90000 }, async t => {
    const h = await harness(t);
    const { events, socket, waitFor, startMeeting, observe } = h;

    await startMeeting('End check');
    await observe({ participants: ['Aditi'], speaking: [] });

    await observe({ participants: [], speaking: [], ended: true, reason: 'ended' });
    await waitFor(() => events.some(event => event.type === 'meeting_ended'), 5000, 'meeting_ended event');
    const ended = events.find(event => event.type === 'meeting_ended').data;
    assert.equal(ended.reason, 'ended');
    assert.equal(ended.source, 'google-meet');

    // Nothing ends before the grace runs out: an accidental leave click
    // should not have killed the recording the moment it happened.
    await new Promise(resolve => setTimeout(resolve, GRACE_MS / 2));
    assert.ok(!events.some(event => event.type === 'meeting_completed'), 'the meeting must not finish inside the grace');

    await waitFor(() => events.some(event => event.type === 'meeting_completed'), 40000, 'self-finish after the grace');
    socket.close();
});

test('the UI stopping within the grace wins, and the meeting completes exactly once', { timeout: 90000 }, async t => {
    const h = await harness(t);
    const { events, socket, waitFor, startMeeting, observe } = h;

    await startMeeting('Cancel check');
    await observe({ participants: ['Aditi'], speaking: [] });
    await observe({ participants: [], speaking: [], ended: true, reason: 'left' });

    // The renderer calls the normal stop as soon as it hears meeting_ended.
    await fetch(`http://127.0.0.1:${h.port}/api/meetings/stop`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
    });

    await waitFor(() => events.some(event => event.type === 'meeting_completed'), 40000, 'the stop to complete');
    await new Promise(resolve => setTimeout(resolve, 500));
    const completions = events.filter(event => event.type === 'meeting_completed').length;
    assert.equal(completions, 1, 'the pending end must not double-finish the meeting');
    socket.close();
});

test('a rejoin within the grace cancels the end and recording continues', { timeout: 90000 }, async t => {
    const h = await harness(t);
    const { events, socket, waitFor, startMeeting, observe, turns } = h;

    await startMeeting('Rejoin check');
    await observe({ participants: ['Aditi'], speaking: [] });
    await observe({ participants: [], speaking: [], ended: true, reason: 'left' });

    // Back within the grace window the page reports the call again, this time
    // without the end flag — the ordinary heartbeat of a live meeting.
    await new Promise(resolve => setTimeout(resolve, GRACE_MS - 3000));
    await observe({ participants: ['Aditi'], speaking: ['Aditi'] });

    // Well past the original deadline the meeting is still recording, and a
    // spoken turn still produces a live transcript turn.
    await new Promise(resolve => setTimeout(resolve, 4000));
    assert.ok(!events.some(event => event.type === 'meeting_completed'), 'a rejoin must cancel the pending end');
    await h.speak(STREAM_SYSTEM, Buffer.concat([vowel(2500, 215, [780, 1900, 3100]), quiet(1500)]), Date.now());
    await waitFor(() => turns().some(turn => turn.channel === 'system'), 20000, 'a turn after rejoining');

    socket.close();
});

test('silence from the meeting client counts as a dropout; a meeting without it is never touched', { timeout: 120000 }, async t => {
    const h = await harness(t);
    const { events, socket, waitFor, startMeeting, observe } = h;

    await startMeeting('Dropout check');
    // One observation is enough to mark this meeting as extension-attached;
    // then the tab disappears and its reports stop arriving.
    await observe({ participants: ['Aditi'], speaking: ['Aditi'] });

    await waitFor(
        () => events.some(event => event.type === 'meeting_ended' && (event.data || event.payload)?.reason === 'dropout'),
        DROPOUT_MS + 10000,
        'the dropout to be detected'
    );
    await waitFor(() => events.some(event => event.type === 'meeting_completed'), 40000, 'the dropout to finish the meeting');

    // A second meeting with no extension attached at all: the client has
    // never reported, so nothing may stop it.
    events.length = 0;
    socket.send({ action: 'start_meeting', payload: { title: 'No client' } });
    await waitFor(() => events.some(event => event.type === 'meeting_started'), 15000, 'second meeting start');
    await new Promise(resolve => setTimeout(resolve, DROPOUT_MS + 3000));
    assert.ok(!events.some(event => event.type === 'meeting_completed'), 'a meeting without client reports must never auto-stop');
    assert.ok(!events.some(event => event.type === 'meeting_ended'), 'a meeting without client reports must never be ended');

    socket.send({ action: 'stop_meeting', payload: {} });
    await waitFor(() => events.some(event => event.type === 'meeting_completed'), 40000, 'the manual stop');
    socket.close();
});

test('auto-stop can be switched off, and the end is then only reported', { timeout: 60000 }, async t => {
    const h = await harness(t, { autoStopOnMeetingEnd: false });
    const { events, socket, waitFor, startMeeting, observe } = h;

    await startMeeting('Manual check');
    await observe({ participants: ['Aditi'], speaking: [] });
    await observe({ participants: [], speaking: [], ended: true, reason: 'ended' });

    await waitFor(() => events.some(event => event.type === 'meeting_ended'), 5000, 'meeting_ended event');
    // Twice the grace, to prove nothing acts on the report.
    await new Promise(resolve => setTimeout(resolve, GRACE_MS * 2 + 2000));
    assert.ok(!events.some(event => event.type === 'meeting_completed'), 'auto-stop off must leave the recording running');

    socket.send({ action: 'stop_meeting', payload: {} });
    await waitFor(() => events.some(event => event.type === 'meeting_completed'), 40000, 'the manual stop');
    socket.close();
});

test('a browser call while idle is one unscheduled-call notice per meeting', { timeout: 60000 }, async t => {
    const h = await harness(t);
    const { events, socket, waitFor, observe } = h;

    const first = await observe({ participants: ['Aditi', 'Ben'], speaking: ['Aditi'] });
    assert.equal(first.accepted, false, 'nothing is recording, so the roster is not adopted');
    await waitFor(() => events.some(event => event.type === 'unscheduled_call'), 5000, 'the first unscheduled_call');
    const notices = () => events.filter(event => event.type === 'unscheduled_call').map(event => event.data || event.payload);

    // Heartbeat repeats of the same call must not re-notify.
    await observe({ participants: ['Aditi', 'Ben'], speaking: [] });
    await observe({ participants: ['Aditi', 'Ben'], speaking: ['Ben'] });
    await new Promise(resolve => setTimeout(resolve, 500));
    assert.equal(notices().length, 1, JSON.stringify(notices()));
    assert.deepEqual(notices()[0].participants, ['Aditi', 'Ben']);

    // A different meeting URL is a different call and prompts again.
    await observe({ participants: ['Chen'], speaking: [], url: 'https://meet.google.com/xyz-abcd-efg' });
    await waitFor(() => notices().length === 2, 5000, 'the second call');

    // With no roster there is no call to report.
    await observe({ participants: [], speaking: [], url: 'https://meet.google.com/new-meeting' });
    await new Promise(resolve => setTimeout(resolve, 500));
    assert.equal(notices().length, 2);

    socket.close();
});
