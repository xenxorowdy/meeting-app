'use strict';

// Dedicated provider relay. It has no meeting library and never returns provider keys.
const http = require('node:http');
const { WebSocket, WebSocketServer } = require('ws');

const port = Number(process.env.PORT || 48901);
const host = process.env.HOST || '127.0.0.1';
const authOrigin = process.env.KESAMI_SUPABASE_URL;
const publishableKey = process.env.KESAMI_SUPABASE_PUBLISHABLE_KEY;
const sarvamKey = process.env.KESAMI_SARVAM_API_KEY;
const sarvamEndpoint = process.env.KESAMI_SARVAM_REALTIME_URL || 'wss://api.sarvam.ai/speech-to-text-realtime/ws';
const model = process.env.KESAMI_SARVAM_REALTIME_MODEL || 'saaras:v3-realtime';
const MAX_STREAM_MS = 2 * 60 * 60 * 1000;
const MAX_AUDIO_BYTES = 16_000 * 2 * 60 * 60 * 2;
const MAX_DAILY_AUDIO_BYTES = MAX_AUDIO_BYTES * 4;
const active = new Map();
const dailyAudio = new Map();

function audioAllowance(userId, extraBytes = 0) {
    const day = new Date().toISOString().slice(0, 10);
    const current = dailyAudio.get(userId);
    const used = current?.day === day ? current.bytes : 0;
    if (used + extraBytes > MAX_DAILY_AUDIO_BYTES) return false;
    if (extraBytes) dailyAudio.set(userId, { day, bytes: used + extraBytes });
    return true;
}

setInterval(() => {
    const day = new Date().toISOString().slice(0, 10);
    for (const [userId, usage] of dailyAudio) if (usage.day !== day) dailyAudio.delete(userId);
}, 60 * 60 * 1000).unref();

function configured() {
    try {
        const url = new URL(authOrigin);
        return url.protocol === 'https:' && url.pathname === '/' && !url.username && !url.password
            && !url.search && !url.hash && publishableKey?.startsWith('sb_publishable_')
            && typeof sarvamKey === 'string' && sarvamKey.length > 0
            && new URL(sarvamEndpoint).protocol === 'wss:';
    } catch { return false; }
}

if (!configured()) {
    process.stderr.write('Kesami cloud relay needs a Supabase HTTPS origin, publishable key, and server-side Sarvam key.\n');
    process.exit(1);
}

function reject(socket, status, message) {
    if (socket.destroyed) return;
    const body = JSON.stringify({ error: message });
    socket.end(`HTTP/1.1 ${status}\r\nContent-Type: application/json\r\nCache-Control: no-store\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
}

async function identity(req) {
    const token = /^Bearer ([^\s]+)$/.exec(req.headers.authorization || '')?.[1];
    if (!token || token.length > 16_384) return null;
    const response = await fetch(new URL('/auth/v1/user', authOrigin), {
        headers: { apikey: publishableKey, Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) return null;
    const user = await response.json();
    return /^[0-9a-f]{8}-[0-9a-f-]{27,}$/.test(user.id || '') && !user.is_anonymous ? user.id : null;
}

function upstreamUrl(raw) {
    const request = new URL(raw, 'http://localhost');
    if (request.pathname !== '/v1/transcription/realtime') return null;
    const language = request.searchParams.get('language_code') || 'auto';
    const mode = request.searchParams.get('mode') || 'transcribe';
    if (!/^[a-zA-Z-]{2,24}$/.test(language)
        || !['transcribe', 'translate', 'verbatim', 'translit', 'codemix'].includes(mode)
        || request.searchParams.get('encoding') !== 'linear16'
        || request.searchParams.get('sample_rate') !== '16000'
        || request.searchParams.get('model') !== model) return null;
    const url = new URL(sarvamEndpoint);
    url.searchParams.set('model', model);
    url.searchParams.set('language_code', language);
    url.searchParams.set('mode', mode);
    url.searchParams.set('encoding', 'linear16');
    url.searchParams.set('sample_rate', '16000');
    url.searchParams.set('return_timestamps', 'true');
    return url;
}

const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'GET' && req.url === '/health') {
        res.end(JSON.stringify({ status: 'ok' }));
    } else if (req.method === 'GET' && req.url === '/v1/capabilities') {
        let userId;
        try { userId = await identity(req); } catch {
            res.writeHead(503).end(JSON.stringify({ error: 'Sign-in service unavailable' }));
            return;
        }
        if (!userId) res.writeHead(401).end(JSON.stringify({ error: 'Sign in with Google again' }));
        else if (!audioAllowance(userId)) res.writeHead(429).end(JSON.stringify({ error: 'Daily transcription limit reached' }));
        else res.end(JSON.stringify({ realtimeTranscription: true }));
    } else {
        res.writeHead(404).end(JSON.stringify({ error: 'Not found' }));
    }
});
const wss = new WebSocketServer({ noServer: true, maxPayload: 96 * 1024, perMessageDeflate: false });

server.on('upgrade', async (req, socket, head) => {
    const url = upstreamUrl(req.url || '');
    if (!url) return reject(socket, '400 Bad Request', 'Invalid transcription request');
    let userId;
    try { userId = await identity(req); } catch { return reject(socket, '503 Service Unavailable', 'Sign-in service unavailable'); }
    if (socket.destroyed) return;
    if (!userId) return reject(socket, '401 Unauthorized', 'Sign in with Google again');
    if ((active.get(userId) || 0) >= 2) return reject(socket, '429 Too Many Requests', 'Too many live transcription streams');
    if (!audioAllowance(userId)) return reject(socket, '429 Too Many Requests', 'Daily transcription limit reached');
    active.set(userId, (active.get(userId) || 0) + 1);
    wss.handleUpgrade(req, socket, head, client => {
        const provider = new WebSocket(url, { headers: { 'api-subscription-key': sarvamKey }, perMessageDeflate: false });
        let bytes = 0;
        let ended = false;
        const timer = setTimeout(() => client.close(1000, 'Meeting limit reached'), MAX_STREAM_MS);
        const finish = () => {
            if (ended) return;
            ended = true;
            clearTimeout(timer);
            const remaining = Math.max(0, (active.get(userId) || 1) - 1);
            if (remaining) active.set(userId, remaining);
            else active.delete(userId);
            if (client.readyState === WebSocket.OPEN) client.close();
            if (provider.readyState === WebSocket.OPEN || provider.readyState === WebSocket.CONNECTING) provider.close();
        };
        const pending = [];
        provider.on('open', () => { for (const message of pending) provider.send(message); pending.length = 0; });
        client.on('message', (message, binary) => {
            if (binary) return finish();
            let value;
            try { value = JSON.parse(message.toString()); } catch { return finish(); }
            if (value.event === 'audio_input') {
                if (typeof value.audio !== 'string' || value.audio.length > 48_000 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value.audio)) return finish();
                const chunkBytes = Buffer.from(value.audio, 'base64').length;
                bytes += chunkBytes;
                if (bytes > MAX_AUDIO_BYTES || !audioAllowance(userId, chunkBytes)) return finish();
            } else if (!['end', 'ping'].includes(value.event)) return finish();
            const text = message.toString();
            if (provider.readyState === WebSocket.OPEN) provider.send(text);
            else if (provider.readyState === WebSocket.CONNECTING && pending.length < 100) pending.push(text);
            else finish();
        });
        provider.on('message', (message, binary) => {
            if (!binary && client.readyState === WebSocket.OPEN) client.send(message);
        });
        client.on('close', finish);
        client.on('error', finish);
        provider.on('close', finish);
        provider.on('error', finish);
    });
});

server.listen(port, host, () => process.stdout.write(`Kesami cloud relay listening on ${host}:${port}\n`));
