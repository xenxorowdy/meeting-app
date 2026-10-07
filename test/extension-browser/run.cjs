const { spawn, execFileSync } = require('node:child_process');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const https = require('node:https');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { once } = require('node:events');

const ROOT = path.resolve(__dirname, '../..');
const BACKEND = path.join(ROOT, 'apps/core-backend/target/debug/kesami-core-backend');
const EXTENSION = path.join(ROOT, 'apps/extension');
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const BROWSERS = [
    process.env.KESAMI_TEST_BROWSER,
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/usr/bin/brave-browser',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
].filter(Boolean);

const MEET_PAGE = `<!doctype html><html><head><title>Meet - abc-defg-hij</title></head><body>
<div data-participant-id="p1" style="width:120px;height:80px"><span data-self-name="Riyam Jain">Riyam Jain</span></div>
<div data-participant-id="p2" style="width:120px;height:80px"><span class="notranslate">Aditi Sharma</span><div data-is-speaking="true" style="width:10px;height:10px"></div></div>
<div data-participant-id="p3" style="width:120px;height:80px"><span class="notranslate">Ben Lee</span></div>
<button id="mic" aria-label="Turn off microphone (⌘ + d)">mic</button>
<button aria-label="Leave call">leave</button>
</body></html>`;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function freePort() {
    const probe = net.createServer();
    probe.listen(0, '127.0.0.1');
    await once(probe, 'listening');
    const { port } = probe.address();
    await new Promise(resolve => probe.close(resolve));
    return port;
}

async function until(read, label, timeoutMs = 10000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const value = await read();
        if (value) return value;
        if (Date.now() > deadline) throw new assert.AssertionError({ message: `timed out waiting for ${label}` });
        await sleep(200);
    }
}

function recogniserStub() {
    const server = http.createServer((request, response) => {
        response.writeHead(404);
        response.end();
    });
    server.on('upgrade', (request, socket) => {
        const accept = crypto.createHash('sha1').update(request.headers['sec-websocket-key'] + GUID).digest('base64');
        socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
        socket.on('error', () => {});
        socket.on('end', () => socket.end());
        socket.on('data', () => {});
    });
    return server;
}

async function devtools(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
        ws.onopen = resolve;
        ws.onerror = reject;
    });
    let nextId = 0;
    const pending = new Map();
    ws.onmessage = event => {
        const message = JSON.parse(event.data);
        const waiter = message.id && pending.get(message.id);
        if (!waiter) return;
        pending.delete(message.id);
        if (message.error) waiter.reject(new Error(message.error.message));
        else waiter.resolve(message.result);
    };
    const send = (method, params = {}, sessionId) =>
        new Promise((resolve, reject) => {
            const id = ++nextId;
            pending.set(id, { resolve, reject });
            ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
        });
    const evaluate = async (sessionId, expression) => {
        const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
        if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
        return result.result.value;
    };
    return { send, evaluate, close: () => ws.close() };
}

async function backendSocket(port, onEvent) {
    const socket = net.connect(port, '127.0.0.1');
    socket.on('error', () => {});
    await once(socket, 'connect');
    socket.write(`GET /ws HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${crypto.randomBytes(16).toString('base64')}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
    let buffer = Buffer.alloc(0);
    let upgraded = false;
    let answered;
    const handshake = new Promise(resolve => {
        answered = resolve;
    });
    socket.on('data', chunk => {
        buffer = Buffer.concat([buffer, chunk]);
        if (!upgraded) {
            const end = buffer.indexOf('\r\n\r\n');
            if (end === -1) return;
            upgraded = true;
            answered(buffer.subarray(0, end).toString('latin1'));
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
            try {
                onEvent(JSON.parse(payload.toString('utf8')));
            } catch {}
        }
    });
    assert.match(await handshake, /^HTTP\/1\.1 101 /);
    return {
        send: value => {
            const body = Buffer.from(JSON.stringify(value));
            const mask = crypto.randomBytes(4);
            const header = body.length < 126 ? Buffer.from([0x81, 0x80 | body.length]) : Buffer.from([0x81, 0xfe, body.length >> 8, body.length & 0xff]);
            for (let index = 0; index < body.length; index += 1) body[index] ^= mask[index % 4];
            socket.write(Buffer.concat([header, mask, body]));
        },
        close: () => socket.destroy(),
    };
}

async function main() {
    const browser = BROWSERS.find(candidate => fsSync.existsSync(candidate));
    if (!browser) {
        console.log('SKIP: no Chromium-based browser found. Set KESAMI_TEST_BROWSER to Brave, Chrome, Edge or Chromium.');
        return;
    }
    assert.ok(fsSync.existsSync(BACKEND), 'build the Rust debug backend first: cargo build --manifest-path apps/core-backend/Cargo.toml');

    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kesami-extension-'));
    const cleanups = [];
    try {
        const key = path.join(root, 'key.pem');
        const cert = path.join(root, 'cert.pem');
        execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=meet.google.com', '-addext', 'subjectAltName=DNS:meet.google.com'], { stdio: 'ignore' });
        const pagePort = await freePort();
        const page = https.createServer({ key: await fs.readFile(key), cert: await fs.readFile(cert) }, (request, response) => {
            response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            response.end(MEET_PAGE);
        });
        page.listen(pagePort, '127.0.0.1');
        await once(page, 'listening');
        cleanups.push(() => new Promise(resolve => page.close(resolve)));

        const stubPort = await freePort();
        const stub = recogniserStub();
        stub.listen(stubPort, '127.0.0.1');
        await once(stub, 'listening');
        cleanups.push(() => new Promise(resolve => stub.close(resolve)));

        const port = await freePort();
        await fs.writeFile(path.join(root, 'settings.json'), JSON.stringify({ transcriptionProvider: 'sarvam-realtime', autoSummarize: false }));
        const backend = spawn(BACKEND, [], {
            cwd: root,
            stdio: 'ignore',
            env: {
                ...process.env,
                KESAMI_DATA_DIR: root,
                KESAMI_LIBRARY_DIR: path.join(root, 'library'),
                CORE_BACKEND_DATA_FILE: path.join(root, 'absent.json'),
                CORE_BACKEND_PORT: String(port),
                KESAMI_SARVAM_API_KEY: 'test-key',
                KESAMI_SARVAM_REALTIME_URL: `ws://127.0.0.1:${stubPort}/ws`,
                KESAMI_GEMINI_API_KEY: '',
                KESAMI_CHAT_EMBEDDINGS: 'off',
            },
        });
        cleanups.push(async () => {
            if (backend.exitCode === null) {
                backend.kill('SIGTERM');
                await once(backend, 'exit');
            }
        });
        const api = async (route, options) => (await fetch(`http://127.0.0.1:${port}${route}`, options)).json();
        await until(async () => (await fetch(`http://127.0.0.1:${port}/health`).catch(() => null))?.ok, 'the backend');

        const profile = path.join(root, 'profile');
        const chromium = spawn(browser, [
            `--user-data-dir=${profile}`,
            '--remote-debugging-port=0',
            `--load-extension=${EXTENSION}`,
            `--disable-extensions-except=${EXTENSION}`,
            '--disable-features=DisableLoadExtensionCommandLineSwitch',
            `--host-resolver-rules=MAP meet.google.com:443 127.0.0.1:${pagePort}`,
            '--ignore-certificate-errors',
            '--no-first-run',
            '--no-default-browser-check',
            ...(process.argv.includes('--headed') ? [] : ['--headless=new']),
            'about:blank',
        ], { stdio: 'ignore' });
        cleanups.push(async () => {
            if (chromium.exitCode === null) {
                chromium.kill('SIGTERM');
                await Promise.race([once(chromium, 'exit'), sleep(5000)]);
            }
        });

        const activePort = await until(() => fs.readFile(path.join(profile, 'DevToolsActivePort'), 'utf8').catch(() => null), 'the browser');
        const [debugPort, debugPath] = activePort.trim().split('\n');
        const cdp = await devtools(`ws://127.0.0.1:${debugPort}${debugPath}`);
        cleanups.push(async () => cdp.close());

        const worker = await until(async () => {
            const { targetInfos } = await cdp.send('Target.getTargets');
            return targetInfos.find(target => target.type === 'service_worker' && target.url.startsWith('chrome-extension://') && target.url.endsWith('/src/background.js'));
        }, 'the Kesami extension to load');
        const workerSession = (await cdp.send('Target.attachToTarget', { targetId: worker.targetId, flatten: true })).sessionId;
        await until(() => cdp.evaluate(workerSession, "typeof chrome !== 'undefined' && Boolean(chrome.storage?.local)").catch(() => false), 'the extension worker to start');
        await cdp.evaluate(workerSession, `chrome.storage.local.set({ port: ${port} }).then(() => true)`);
        const lastReport = async () => JSON.parse(await cdp.evaluate(workerSession, 'chrome.storage.session.get({ report: null }).then(stored => JSON.stringify(stored.report))'));

        const { targetId } = await cdp.send('Target.createTarget', { url: 'https://meet.google.com/abc-defg-hij' });
        const pageSession = (await cdp.send('Target.attachToTarget', { targetId, flatten: true })).sessionId;

        const idle = await until(lastReport, 'the first report from the meeting tab');
        assert.equal(idle.error, undefined, `the backend refused the extension: ${idle.error}`);
        assert.equal(idle.accepted, false);
        assert.deepEqual(idle.participants, ['Riyam Jain', 'Aditi Sharma', 'Ben Lee']);
        assert.deepEqual(idle.speaking, ['Aditi Sharma']);
        assert.equal(idle.self, 'Riyam Jain');
        assert.equal(idle.micMuted, false);
        const idleStatus = await api('/api/status');
        assert.equal(idleStatus.meetingClient?.source, 'google-meet', 'Kesami can tell the extension is connected before a meeting starts');

        const events = [];
        const socket = await backendSocket(port, event => events.push(event));
        cleanups.push(async () => socket.close());
        socket.send({ action: 'start_meeting', payload: { title: 'Extension check' } });
        const started = await until(() => events.find(event => event.type === 'meeting_started'), 'the meeting to start');
        const meetingId = started.data.id;
        const startedAt = Date.now();
        const recording = await until(async () => {
            const report = await lastReport();
            return report?.at > startedAt && report.accepted ? report : null;
        }, 'a report accepted while recording');
        assert.equal(recording.meetingId, meetingId);
        assert.deepEqual((await api('/api/status')).participants.names, ['Riyam Jain', 'Aditi Sharma', 'Ben Lee']);

        await cdp.evaluate(pageSession, `document.getElementById('mic').setAttribute('aria-label', 'Turn on microphone (⌘ + d)')`);
        await until(() => events.find(event => event.type === 'mic_muted' && event.data?.muted === true), 'the mute from the meeting toolbar');
        assert.equal((await api('/api/status')).clientMicMuted, true);

        await cdp.evaluate(pageSession, `document.body.innerHTML = '<h1>You left the meeting</h1><button>Rejoin</button>'`);
        const ended = await until(() => events.find(event => event.type === 'meeting_ended'), 'the end of the call');
        assert.equal(ended.data.reason, 'ended');
        await until(() => events.find(event => event.type === 'meeting_completed'), 'the meeting to finish after the rejoin grace', 30000);

        const { meeting } = await api(`/api/meetings/${meetingId}`);
        assert.deepEqual(meeting.metadata.participants, ['Riyam Jain', 'Aditi Sharma', 'Ben Lee']);
        assert.equal(meeting.metadata.participantSelf, 'Riyam Jain');
        assert.ok(meeting.metadata.speakingActivity.some(span => span.name === 'Aditi Sharma' && span.endMs > span.startMs), 'who spoke when is kept for speaker suggestions');

        console.log(`PASS (${path.basename(browser)}): the extension reads the roster, speaker, self and mute state from Google Meet; Kesami accepts its reports idle and while recording; leaving the call ends the meeting; names and speaking spans are saved.`);
    } finally {
        for (const cleanup of cleanups.reverse()) {
            await cleanup().catch(() => {});
        }
        await fs.rm(root, { recursive: true, force: true }).catch(() => {});
    }
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
