// Real Rust HTTP routes for the account system: register, sign in, sessions
// that authorize the API, logout, and persistence across a restart.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

const BINARY = path.resolve(__dirname, '../apps/core-backend/target/debug/alpha-core-backend');
// A deployment token must be present so sessions are the *only* way in besides
// the token itself; without one a local backend answers every route.
const DEPLOYMENT_TOKEN = 'test-only-token-with-at-least-32-characters';

async function freePort() {
    const probe = net.createServer();
    probe.listen(0, '127.0.0.1');
    await once(probe, 'listening');
    const port = probe.address().port;
    await new Promise(resolve => probe.close(resolve));
    return port;
}

async function spawnBackend(root) {
    const port = await freePort();
    const backend = spawn(BINARY, [], {
        cwd: root,
        stdio: ['ignore', 'ignore', 'ignore'],
        env: {
            ...process.env,
            ALPHA_DATA_DIR: root,
            CORE_BACKEND_DATA_FILE: path.join(root, 'absent-settings.json'),
            CORE_BACKEND_PORT: String(port),
            ALPHA_BACKEND_TOKEN: DEPLOYMENT_TOKEN,
            // Unoptimized test builds make 600k PBKDF2 iterations crawl.
            ALPHA_PBKDF2_ITERATIONS: '1000',
            ALPHA_SUMMARY_PROVIDER: 'claude',
            ALPHA_GEMINI_API_KEY: '',
            ALPHA_SARVAM_API_KEY: '',
            ALPHA_CHAT_EMBEDDINGS: 'off',
        },
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
    const api = async (route, body, method = body === undefined ? 'GET' : 'POST', token) => {
        const headers = {};
        if (body !== undefined) headers['Content-Type'] = 'application/json';
        if (token) headers.Authorization = `Bearer ${token}`;
        const response = await fetch(`${base}${route}`, {
            method,
            headers,
            body: body === undefined ? undefined : JSON.stringify(body),
        });
        return { status: response.status, data: await response.json() };
    };
    return { backend, api };
}

test('accounts register, sign in, authorize the API, and die at logout', { timeout: 60000 }, async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'alpha-auth-flow-'));
    t.after(async () => {
        await fs.rm(root, { recursive: true, force: true });
    });
    const { backend, api } = await spawnBackend(root);
    t.after(async () => {
        if (backend.exitCode === null) { backend.kill('SIGTERM'); await once(backend, 'exit'); }
    });

    // The deployment token gates everything except health and credential minting.
    assert.equal((await api('/health')).status, 200);
    assert.equal((await api('/api/status')).status, 401);
    assert.equal((await api('/api/auth/session')).status, 401);

    const registered = await api('/api/auth/register', {
        name: 'Asha Verma', email: 'Asha@Work.com', password: 'correct horse battery',
    });
    assert.equal(registered.status, 200);
    assert.equal(registered.data.success, true);
    assert.equal(registered.data.account.email, 'asha@work.com');
    assert.equal(registered.data.account.name, 'Asha Verma');
    assert.ok(registered.data.token.length >= 32);
    const token = registered.data.token;

    // A session token authorizes ordinary API routes and identifies its account.
    assert.equal((await api('/api/status', undefined, 'GET', token)).status, 200);
    const session = await api('/api/auth/session', undefined, 'GET', token);
    assert.equal(session.status, 200);
    assert.equal(session.data.account.email, 'asha@work.com');

    const duplicate = await api('/api/auth/register', {
        name: 'Asha Again', email: 'asha@work.com', password: 'another fine password',
    });
    assert.equal(duplicate.status, 409);

    // Either wrong password or unknown email: the same 401, the same wording.
    for (const body of [
        { email: 'asha@work.com', password: 'not the right password' },
        { email: 'nobody@work.com', password: 'correct horse battery' },
    ]) {
        const failed = await api('/api/auth/login', body);
        assert.equal(failed.status, 401);
        assert.equal(failed.data.error, 'Email or password is incorrect.');
    }
    const login = await api('/api/auth/login', { email: 'asha@work.com', password: 'correct horse battery' });
    assert.equal(login.status, 200);
    assert.ok(login.data.token && login.data.token !== token);

    // Malformed input is a validation error, never a crash.
    assert.equal((await api('/api/auth/register', { name: '', email: 'nope', password: 'x' })).status, 400);
    assert.equal((await api('/api/auth/login', { email: '', password: '' })).status, 400);

    // Logout revokes exactly the token it was given; the other session survives.
    assert.equal((await api('/api/auth/logout', {}, 'POST', token)).status, 200);
    assert.equal((await api('/api/auth/session', undefined, 'GET', token)).status, 401);
    assert.equal((await api('/api/status', undefined, 'GET', token)).status, 401);
    const stillValid = await api('/api/auth/session', undefined, 'GET', login.data.token);
    assert.equal(stillValid.status, 200);
    assert.equal(stillValid.data.account.email, 'asha@work.com');
});

test('accounts and sessions survive a backend restart', { timeout: 60000 }, async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'alpha-auth-restart-'));
    t.after(async () => {
        await fs.rm(root, { recursive: true, force: true });
    });
    const first = await spawnBackend(root);
    const registered = await first.api('/api/auth/register', {
        name: 'Asha Verma', email: 'asha@work.com', password: 'correct horse battery',
    });
    assert.equal(registered.status, 200);
    first.backend.kill('SIGTERM');
    await once(first.backend, 'exit');

    const second = await spawnBackend(root);
    t.after(async () => {
        if (second.backend.exitCode === null) { second.backend.kill('SIGTERM'); await once(second.backend, 'exit'); }
    });
    // The session token minted before the restart still identifies the account.
    const session = await second.api('/api/auth/session', undefined, 'GET', registered.data.token);
    assert.equal(session.status, 200);
    assert.equal(session.data.account.email, 'asha@work.com');
    const login = await second.api('/api/auth/login', { email: 'asha@work.com', password: 'correct horse battery' });
    assert.equal(login.status, 200);
});
