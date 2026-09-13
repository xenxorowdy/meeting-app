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

function audioPacket(streamId, timestampMs, pcm) {
    const header = Buffer.alloc(16);
    header.writeUInt32LE(streamId, 0);
    header.writeBigInt64LE(BigInt(timestampMs), 4);
    header.writeUInt32LE(pcm.length, 12);
    return Buffer.concat([header, pcm]);
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

test('a live meeting numbers each meeting-audio voice and keeps the microphone as You', { timeout: 60000 }, async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'alpha-speakers-'));
    let backend;
    let recogniser;
    t.after(async () => {
        if (backend && backend.exitCode === null) {
            backend.kill('SIGTERM');
            await once(backend, 'exit');
        }
        if (recogniser) await new Promise(resolve => recogniser.close(resolve));
        await fs.rm(root, { recursive: true, force: true });
    });

    let heard = 0;
    const reply = (response, body) => {
        const payload = Buffer.from(body);
        response.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': payload.length });
        response.end(payload);
    };
    recogniser = http.createServer((request, response) => {
        if (request.url === '/health') {
            reply(response, '{}');
            return;
        }
        request.resume();
        request.on('end', () => {
            heard += 1;
            reply(response, JSON.stringify({ text: `utterance ${heard}`, language: 'en', duration: 3 }));
        });
    });
    const sttPort = await freePort();
    recogniser.listen(sttPort, '127.0.0.1');
    await once(recogniser, 'listening');

    await fs.writeFile(
        path.join(root, 'settings.json'),
        JSON.stringify({ transcriptionProvider: 'whisper', autoSummarize: false, noiseSuppression: true, echoSuppression: true })
    );
    const stub = path.join(root, 'whisper-stub');
    await fs.writeFile(stub, '', { mode: 0o700 });

    const port = await freePort();
    backend = spawn(path.resolve(__dirname, '../apps/core-backend/target/debug/alpha-core-backend'), [], {
        cwd: root,
        stdio: ['ignore', 'ignore', 'ignore'],
        env: {
            ...process.env,
            ALPHA_DATA_DIR: root,
            ALPHA_LIBRARY_DIR: path.join(root, 'library'),
            CORE_BACKEND_DATA_FILE: path.join(root, 'absent.json'),
            CORE_BACKEND_PORT: String(port),
            CORE_BACKEND_WHISPER_BIN: stub,
            CORE_BACKEND_STT_HOST: '127.0.0.1',
            CORE_BACKEND_STT_PORT: String(sttPort),
            ALPHA_GEMINI_API_KEY: '',
            ALPHA_SARVAM_API_KEY: '',
            ALPHA_CHAT_EMBEDDINGS: 'off',
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
    const states = [];
    const socket = await openSocket(port, event => {
        const data = event.payload || event.data || event;
        if (event.type === 'transcript_turn') turns.push(data);
        if (event.type === 'state_change') states.push(data.newState);
    });

    socket.send({ action: 'start_meeting', payload: { title: 'Voices' } });
    for (let attempt = 0; attempt < 200 && !states.includes('RECORDING'); attempt += 1) {
        await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.ok(states.includes('RECORDING'), `the meeting never started: ${states.join(',')}`);

    const first = vowel(3000, 110, [520, 1100, 2400]);
    const second = vowel(3000, 215, [780, 1900, 3100]);
    const mine = vowel(1500, 150, [640, 1500, 2700]);

    const meetingAudio = Buffer.concat([first, quiet(1200), second, quiet(1200), first, quiet(1200), quiet(1500), quiet(1500)]);
    const microphone = Buffer.concat([quieter(first, 0.5), quiet(1200), quiet(3000), quiet(1200), quiet(3000), quiet(1200), mine, quiet(1500)]);
    assert.equal(meetingAudio.length, microphone.length);

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

    for (let attempt = 0; attempt < 400 && turns.length < 4; attempt += 1) {
        await new Promise(resolve => setTimeout(resolve, 25));
    }
    socket.send({ action: 'stop_meeting', payload: {} });
    for (let attempt = 0; attempt < 400 && !states.includes('COMPLETED'); attempt += 1) {
        await new Promise(resolve => setTimeout(resolve, 25));
    }
    socket.close();

    const summary = JSON.stringify(turns.map(turn => [turn.channel, turn.speaker, turn.startMs, turn.endMs]));
    const meetingTurns = turns.filter(turn => turn.channel === 'system');
    const mineTurns = turns.filter(turn => turn.channel === 'mic');

    assert.deepEqual(
        meetingTurns.map(turn => turn.speaker),
        ['Speaker 1', 'Speaker 2', 'Speaker 1'],
        summary
    );
    assert.deepEqual(
        mineTurns.map(turn => turn.speaker),
        ['You'],
        summary
    );
    assert.ok(mineTurns[0].startMs > 12000, summary);
    assert.ok(meetingTurns[0].startMs < meetingTurns[1].startMs, summary);
    assert.ok(meetingTurns[1].startMs < meetingTurns[2].startMs, summary);
    assert.ok(meetingTurns[2].endMs <= 13000, summary);
});

function* chunk(buffer, size) {
    for (let offset = 0; offset < buffer.length; offset += size) {
        yield buffer.subarray(offset, offset + size);
    }
}
