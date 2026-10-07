const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

const BINARY = path.resolve(__dirname, '../apps/core-backend/target/debug/kesami-core-backend');
const DEPLOYMENT_TOKEN = 'test-only-token-with-at-least-32-characters';
const UNREACHABLE_PASSWORD = 'sup3r-secret-pw';
const UNREACHABLE_URL = `postgres://postgres:${UNREACHABLE_PASSWORD}@127.0.0.1:1/postgres`;

async function freePort() {
    const probe = net.createServer();
    probe.listen(0, '127.0.0.1');
    await once(probe, 'listening');
    const port = probe.address().port;
    await new Promise(resolve => probe.close(resolve));
    return port;
}

async function spawnBackend({ supabase = {}, local = true } = {}) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kesami-supabase-'));
    const port = await freePort();
    const backend = spawn(BINARY, [], {
        cwd: root,
        stdio: ['ignore', 'ignore', 'ignore'],
        env: {
            ...process.env,
            KESAMI_DATA_DIR: root,
            CORE_BACKEND_DATA_FILE: path.join(root, 'absent-settings.json'),
            CORE_BACKEND_PORT: String(port),
            CORE_BACKEND_HOST: '127.0.0.1',
            KESAMI_BACKEND_TOKEN: local ? '' : DEPLOYMENT_TOKEN,
            KESAMI_PBKDF2_ITERATIONS: '1000',
            KESAMI_SUMMARY_PROVIDER: 'claude',
            KESAMI_GEMINI_API_KEY: '',
            KESAMI_OPENAI_API_KEY: '',
            KESAMI_SARVAM_API_KEY: '',
            KESAMI_CHAT_EMBEDDINGS: 'off',
            KESAMI_SUPABASE_DB_URL: '',
            KESAMI_SUPABASE_URL: '',
            KESAMI_SUPABASE_PROJECT_REF: '',
            KESAMI_SUPABASE_DB_PASSWORD: '',
            KESAMI_SUPABASE_CONNECT_TIMEOUT_SECS: '5',
            ...supabase,
        },
    });
    let spawnError;
    backend.on('error', error => {
        spawnError = error;
    });
    const base = `http://127.0.0.1:${port}`;
    let ready = false;
    for (let i = 0; i < 100; i++) {
        if (spawnError) throw spawnError;
        if (backend.exitCode !== null) throw new Error('Test backend exited before becoming ready');
        try {
            if ((await fetch(`${base}/health`)).ok) {
                ready = true;
                break;
            }
        } catch {}
        await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.ok(ready, 'Build the Rust debug backend before this test: cargo build --manifest-path apps/core-backend/Cargo.toml');
    const api = async (route, { method = 'GET', token } = {}) => {
        const headers = {};
        if (token) headers.Authorization = `Bearer ${token}`;
        const response = await fetch(`${base}${route}`, { method, headers });
        return { status: response.status, data: await response.json() };
    };
    const stop = async () => {
        backend.kill('SIGKILL');
        await once(backend, 'exit').catch(() => {});
        await fs.rm(root, { recursive: true, force: true });
    };
    return { api, stop };
}

test('an unconfigured backend reports Supabase as absent and still serves every other route', async () => {
    const { api, stop } = await spawnBackend();
    try {
        const health = await api('/health');
        assert.equal(health.status, 200);
        assert.equal(health.data.status, 'ok');
        assert.deepEqual(health.data.supabase, { configured: false, status: 'unconfigured' });

        const status = await api('/api/supabase/status');
        assert.equal(status.status, 200);
        assert.equal(status.data.configured, false);
        assert.equal(status.data.status, 'unconfigured');
        assert.match(status.data.hint, /KESAMI_SUPABASE_DB_URL/);

        const check = await api('/api/supabase/check', { method: 'POST' });
        assert.equal(check.status, 503);
        assert.equal(check.data.configured, false);

        const overall = await api('/api/status');
        assert.equal(overall.status, 200);
        assert.equal(overall.data.supabase.configured, false);
    } finally {
        await stop();
    }
});

test('a project ref and password are assembled into the Supabase Postgres endpoint', async () => {
    const { api, stop } = await spawnBackend({
        supabase: { KESAMI_SUPABASE_URL: 'https://abcdefgh.supabase.co', KESAMI_SUPABASE_DB_PASSWORD: 'p@ss:word/1' },
    });
    try {
        const status = await api('/api/supabase/status');
        assert.equal(status.data.configured, true);
        assert.equal(status.data.host, 'db.abcdefgh.supabase.co');
        assert.equal(status.data.port, 5432);
        assert.equal(status.data.database, 'postgres');
        assert.equal(status.data.user, 'postgres');
        assert.equal(status.data.transactionPooler, false);
        assert.equal(status.data.source, 'KESAMI_SUPABASE_URL');
    } finally {
        await stop();
    }
});

test('the transaction pooler port is recognised so prepared statements stay off', async () => {
    const { api, stop } = await spawnBackend({
        supabase: { KESAMI_SUPABASE_DB_URL: 'postgres://postgres.abcdefgh:pw@aws-0-ap-south-1.pooler.supabase.com:6543/postgres' },
    });
    try {
        const status = await api('/api/supabase/status');
        assert.equal(status.data.configured, true);
        assert.equal(status.data.port, 6543);
        assert.equal(status.data.user, 'postgres.abcdefgh');
        assert.equal(status.data.transactionPooler, true);
    } finally {
        await stop();
    }
});

test('an unreachable database fails the check without taking the backend down or leaking the password', async () => {
    const { api, stop } = await spawnBackend({ supabase: { KESAMI_SUPABASE_DB_URL: UNREACHABLE_URL } });
    try {
        const check = await api('/api/supabase/check', { method: 'POST' });
        assert.equal(check.status, 503);
        assert.equal(check.data.configured, true);
        assert.equal(check.data.status, 'error');
        assert.ok(check.data.error, 'the failed check must say why');
        assert.ok(!JSON.stringify(check.data).includes(UNREACHABLE_PASSWORD), 'the password must never reach a response');

        const health = await api('/health');
        assert.equal(health.status, 200);
        assert.equal(health.data.status, 'ok');
        assert.deepEqual(health.data.supabase, { configured: true, status: 'error' });
    } finally {
        await stop();
    }
});

test('Supabase routes need the workspace token on a hosted backend', async () => {
    const { api, stop } = await spawnBackend({ local: false, supabase: { KESAMI_SUPABASE_DB_URL: UNREACHABLE_URL } });
    try {
        assert.equal((await api('/api/supabase/status')).status, 401);
        assert.equal((await api('/api/supabase/check', { method: 'POST' })).status, 401);
        assert.equal((await api('/api/supabase/status', { token: DEPLOYMENT_TOKEN })).status, 200);
    } finally {
        await stop();
    }
});

test(
    'a real Supabase project answers select version()',
    { skip: process.env.KESAMI_SUPABASE_DB_URL ? false : 'set KESAMI_SUPABASE_DB_URL to run the live check' },
    async () => {
        const { api, stop } = await spawnBackend({ supabase: { KESAMI_SUPABASE_DB_URL: process.env.KESAMI_SUPABASE_DB_URL } });
        try {
            const check = await api('/api/supabase/check', { method: 'POST' });
            assert.equal(check.status, 200, `live check failed: ${check.data.error}`);
            assert.equal(check.data.status, 'ok');
            assert.match(check.data.serverVersion, /PostgreSQL/);
            assert.ok(check.data.latencyMs >= 0);
        } finally {
            await stop();
        }
    }
);
