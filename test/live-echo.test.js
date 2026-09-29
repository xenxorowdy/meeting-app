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

async function freePort() {
    const probe = net.createServer();
    probe.listen(0, '127.0.0.1');
    await once(probe, 'listening');
    const { port } = probe.address();
    await new Promise(resolve => probe.close(resolve));
    return port;
}

function syllableGain(time) {
    const period = 0.35;
    const voiced = 0.25;
    const ramp = 0.02;
    const phase = time % period;
    if (phase >= voiced) return 0.02;
    if (phase < ramp) return phase / ramp;
    if (phase > voiced - ramp) return (voiced - phase) / ramp;
    return 1;
}

function vowel(ms, fundamental, formants) {
    const samples = new Float32Array((SAMPLE_RATE * ms) / 1000);
    const harmonics = Math.floor(7000 / fundamental);
    for (let index = 0; index < samples.length; index += 1) {
        const time = index / SAMPLE_RATE;
        const syllable = syllableGain(time);
        let value = 0;
        for (let harmonic = 1; harmonic <= harmonics; harmonic += 1) {
            const frequency = fundamental * harmonic;
            const gain = formants.reduce((total, centre) => {
                const ratio = frequency / centre;
                const real = 1 - ratio * ratio;
                const imaginary = ratio / 8;
                return total + 1 / Math.sqrt(real * real + imaginary * imaginary);
            }, 0);
            value += (gain / harmonic) * Math.sin(2 * Math.PI * frequency * time);
        }
        samples[index] = value * syllable;
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

function quieter(pcm, factor) {
    const out = Buffer.alloc(pcm.length);
    for (let index = 0; index < pcm.length; index += 2) {
        out.writeInt16LE(Math.round(pcm.readInt16LE(index) * factor), index);
    }
    return out;
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
    } else if (body.length < 65536) {
        header = Buffer.alloc(4);
        header.writeUInt8(0x80 | opcode, 0);
        header.writeUInt8(126, 1);
        header.writeUInt16BE(body.length, 2);
    } else {
        header = Buffer.alloc(10);
        header.writeUInt8(0x80 | opcode, 0);
        header.writeUInt8(127, 1);
        header.writeBigUInt64BE(BigInt(body.length), 2);
    }
    return Buffer.concat([header, body]);
}

function maskedFrame(opcode, payload) {
    const mask = crypto.randomBytes(4);
    let header;
    if (payload.length < 126) {
        header = Buffer.from([0x80 | opcode, 0x80 | payload.length]);
    } else if (payload.length < 65536) {
        header = Buffer.alloc(4);
        header.writeUInt8(0x80 | opcode, 0);
        header.writeUInt8(0x80 | 126, 1);
        header.writeUInt16BE(payload.length, 2);
    } else {
        header = Buffer.alloc(10);
        header.writeUInt8(0x80 | opcode, 0);
        header.writeUInt8(0x80 | 127, 1);
        header.writeBigUInt64BE(BigInt(payload.length), 2);
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

function recogniserStub() {
    const connections = [];
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

        const connection = { heard: [], speech: 0, name: `voice ${connections.length + 1}` };
        connections.push(connection);
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
                    const pcm = Buffer.from(message.audio, 'base64');
                    connection.heard.push(pcm);
                    if (loudness(pcm) > 0.01) {
                        connection.speech += 1;
                        if (connection.speech === 3) {
                            socket.write(frame(1, JSON.stringify({ event: 'transcript.partial', text: `${connection.name} is talking` })));
                        }
                    }
                } else if (message.event === 'end') {
                    if (connection.speech > 0) {
                        socket.write(frame(1, JSON.stringify({ event: 'transcript.final', text: `${connection.name} is talking`, language: 'en' })));
                    }
                    socket.write(frame(1, JSON.stringify({ event: 'session.end' })));
                }
            })
        );
    });

    return { server, connections };
}

async function openSocket(port, onEvent) {
    const socket = net.connect(port, '127.0.0.1');
    socket.on('error', () => {});
    await once(socket, 'connect');
    const key = crypto.randomBytes(16).toString('base64');
    socket.write(
        `GET /ws HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`
    );

    let upgraded = false;
    let buffer = Buffer.alloc(0);
    const frames = readFrames((opcode, payload) => {
        if (opcode === 1) {
            try {
                onEvent(JSON.parse(payload.toString('utf8')));
            } catch {}
        }
    });
    socket.on('data', chunk => {
        if (!upgraded) {
            buffer = Buffer.concat([buffer, chunk]);
            const end = buffer.indexOf('\r\n\r\n');
            if (end === -1) return;
            upgraded = true;
            chunk = buffer.subarray(end + 4);
        }
        frames(chunk);
    });

    return {
        send: value => socket.write(maskedFrame(1, Buffer.from(JSON.stringify(value)))),
        sendAudio: packet => socket.write(maskedFrame(2, packet)),
        close: () => socket.destroy(),
    };
}

function* chunk(buffer, size) {
    for (let offset = 0; offset < buffer.length; offset += size) {
        yield buffer.subarray(offset, offset + size);
    }
}

async function runMeeting(t, { meetingAudio, microphone }) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kesami-echo-'));
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
        JSON.stringify({
            transcriptionProvider: 'sarvam-realtime',
            autoSummarize: false,
            noiseSuppression: true,
            echoSuppression: true,
        })
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

    const turns = [];
    const interim = [];
    const states = [];
    const socket = await openSocket(port, event => {
        const data = event.data || event;
        if (event.type === 'transcript_turn') turns.push(data);
        if (event.type === 'transcript_interim') interim.push(data);
        if (event.type === 'state_change') states.push(data.newState);
    });

    socket.send({ action: 'start_meeting', payload: { title: 'On speaker' } });
    for (let attempt = 0; attempt < 200 && !states.includes('RECORDING'); attempt += 1) {
        await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.ok(states.includes('RECORDING'), `the meeting never started: ${states.join(',')}`);

    let offset = 0;
    const startedAt = Date.now();
    const meetingBlocks = [...chunk(meetingAudio, 3200)];
    const microphoneBlocks = [...chunk(microphone, 3200)];
    for (let index = 0; index < meetingBlocks.length; index += 1) {
        socket.sendAudio(audioPacket(STREAM_SYSTEM, startedAt + offset, meetingBlocks[index]));
        socket.sendAudio(audioPacket(STREAM_MIC, startedAt + offset, microphoneBlocks[index]));
        offset += (meetingBlocks[index].length / 2 / SAMPLE_RATE) * 1000;
        await new Promise(resolve => setImmediate(resolve));
    }

    socket.send({ action: 'stop_meeting', payload: {} });
    for (let attempt = 0; attempt < 800 && !states.includes('COMPLETED'); attempt += 1) {
        await new Promise(resolve => setTimeout(resolve, 25));
    }
    socket.close();

    assert.equal(stub.connections.length, 2, 'both streams should reach the recogniser');
    const recognised = stub.connections.map(connection => Buffer.concat(connection.heard)).sort((left, right) => loudness(left) - loudness(right));

    return { turns, interim, fromMicrophone: recognised[0], fromMeeting: recognised[1] };
}

const LEAD_IN_MS = 1500;
const SPEECH_MS = 12000;

test('meeting audio coming back through the speakers is not transcribed a second time', { timeout: 120000 }, async t => {
    const speech = vowel(SPEECH_MS, 110, [520, 1100, 2400]);
    const meetingAudio = Buffer.concat([quiet(LEAD_IN_MS), speech]);
    const microphone = Buffer.concat([quiet(LEAD_IN_MS + 80), quieter(speech, 0.3)]).subarray(0, meetingAudio.length);

    const { turns, interim, fromMicrophone, fromMeeting } = await runMeeting(t, { meetingAudio, microphone });

    assert.ok(loudness(fromMeeting) > 0.02, `the meeting channel was never transcribed: ${loudness(fromMeeting)}`);
    assert.ok(
        loudness(fromMicrophone) < loudness(fromMeeting) * 0.02,
        `the microphone passed the meeting's own audio on to the recogniser: ${loudness(fromMicrophone)} of ${loudness(fromMeeting)}`
    );

    assert.deepEqual(
        turns.map(turn => turn.channel),
        ['system'],
        JSON.stringify(turns.map(turn => [turn.channel, turn.speaker, turn.text]))
    );
    assert.deepEqual(
        interim.map(entry => entry.channel),
        ['system'],
        JSON.stringify(interim)
    );
});

test('the user talking over the meeting is still transcribed', { timeout: 120000 }, async t => {
    const speech = vowel(SPEECH_MS, 110, [520, 1100, 2400]);
    const mine = vowel(SPEECH_MS / 2, 215, [780, 1900, 3100]);
    const meetingAudio = Buffer.concat([quiet(LEAD_IN_MS), speech]);
    const microphone = Buffer.concat([
        quiet(LEAD_IN_MS + 80),
        quieter(speech.subarray(0, ((SAMPLE_RATE * (SPEECH_MS / 2)) / 1000) * 2), 0.3),
        mine,
    ]).subarray(0, meetingAudio.length);

    const { turns, fromMicrophone } = await runMeeting(t, { meetingAudio, microphone });

    assert.ok(loudness(fromMicrophone) > 0.02, `the user's own voice never reached the recogniser: ${loudness(fromMicrophone)}`);
    assert.deepEqual(
        turns.map(turn => turn.channel).sort(),
        ['mic', 'system'],
        JSON.stringify(turns.map(turn => [turn.channel, turn.speaker, turn.text]))
    );
});
