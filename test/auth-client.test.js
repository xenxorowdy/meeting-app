// The auth client: sessions are stored through the same connection plumbing
// the deployment token uses, and sign-out revokes before it clears.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const MODULE_URL = pathToFileURL(path.join(__dirname, '..', 'apps', 'ui', 'src', 'lib', 'auth.js')).href;

function withStubs(fetchLog, savedConnections, { storedToken = '', responses } = {}) {
    const originalFetch = globalThis.fetch;
    const originalConnection = globalThis.alphaConnection;
    globalThis.alphaConnection = {
        get: () => ({ url: 'http://127.0.0.1:48900', token: storedToken }),
        save: async connection => savedConnections.push(connection),
    };
    globalThis.fetch = async (url, options = {}) => {
        fetchLog.push({ url: String(url), options });
        const respond = responses ? responses[fetchLog.length - 1] : null;
        return respond || { ok: true, status: 200, text: async () => JSON.stringify({ success: true }) };
    };
    return () => {
        globalThis.fetch = originalFetch;
        globalThis.alphaConnection = originalConnection;
    };
}

test('sign-in sends credentials to the login route and stores the session', async () => {
    const { signIn } = await import(MODULE_URL);
    const fetches = [];
    const saved = [];
    const restore = withStubs(fetches, saved, {
        responses: [{
            ok: true, status: 200,
            text: async () => JSON.stringify({
                success: true, token: 'tok-123', expiresAt: 4102444800000,
                account: { id: 'a1', name: 'Asha Verma', email: 'asha@work.com' },
            }),
        }],
    });
    try {
        const account = await signIn({ email: 'asha@work.com', password: 'correct horse battery' });
        assert.equal(account.email, 'asha@work.com');
        assert.equal(fetches.length, 1);
        assert.equal(fetches[0].url, 'http://127.0.0.1:48900/api/auth/login');
        assert.deepEqual(
            JSON.parse(fetches[0].options.body),
            { email: 'asha@work.com', password: 'correct horse battery' },
        );
        assert.deepEqual(saved, [{ url: 'http://127.0.0.1:48900', token: 'tok-123' }]);
    } finally {
        restore();
    }
});

test('account creation uses the register route and stores its own session', async () => {
    const { createAccount } = await import(MODULE_URL);
    const fetches = [];
    const saved = [];
    const restore = withStubs(fetches, saved, {
        responses: [{
            ok: true, status: 200,
            text: async () => JSON.stringify({
                success: true, token: 'tok-new', expiresAt: 4102444800000,
                account: { id: 'a2', name: 'Asha Verma', email: 'asha@work.com' },
            }),
        }],
    });
    try {
        const account = await createAccount({ name: 'Asha Verma', email: 'asha@work.com', password: 'correct horse battery' });
        assert.equal(account.name, 'Asha Verma');
        assert.equal(fetches[0].url, 'http://127.0.0.1:48900/api/auth/register');
        assert.deepEqual(
            JSON.parse(fetches[0].options.body),
            { name: 'Asha Verma', email: 'asha@work.com', password: 'correct horse battery' },
        );
        assert.equal(saved[0].token, 'tok-new');
    } finally {
        restore();
    }
});

test('Google desktop authorization is exchanged through the backend and stores the session', async () => {
    const { signInWithGoogle } = await import(MODULE_URL);
    const fetches = [];
    const saved = [];
    const originalGoogle = globalThis.alphaGoogleSignIn;
    const authorization = { code: 'one-time-code', verifier: 'v'.repeat(48), redirectUri: 'http://127.0.0.1:54321', nonce: 'attempt-nonce' };
    globalThis.alphaGoogleSignIn = { start: async clientId => {
        assert.equal(clientId, 'client.apps.googleusercontent.com');
        return authorization;
    } };
    const restore = withStubs(fetches, saved, { responses: [{
        ok: true, status: 200, text: async () => JSON.stringify({ token: 'google-session', account: { id: 'g1', email: 'google@work.com', authProvider: 'google' } }),
    }] });
    try {
        const account = await signInWithGoogle('client.apps.googleusercontent.com');
        assert.equal(account.authProvider, 'google');
        assert.equal(fetches[0].url, 'http://127.0.0.1:48900/api/auth/google');
        assert.deepEqual(JSON.parse(fetches[0].options.body), authorization);
        assert.equal(saved[0].token, 'google-session');
    } finally {
        restore();
        globalThis.alphaGoogleSignIn = originalGoogle;
    }
});

test('Supabase desktop sign-in sends only its proof to the backend and stores the local session', async () => {
    const { signInWithGoogle } = await import(MODULE_URL);
    const fetches = [], saved = [];
    const originalGoogle = globalThis.alphaGoogleSignIn;
    const options = { provider: 'supabase', configured: true, url: 'https://project.supabase.co' };
    const authorization = { code: 'supabase-code', verifier: 'v'.repeat(64) };
    globalThis.alphaGoogleSignIn = { start: async input => { assert.deepEqual(input, options); return authorization; } };
    const restore = withStubs(fetches, saved, { responses: [{ ok: true, status: 200, text: async () => JSON.stringify({ token: 'local-session', account: { id: 'g1', authProvider: 'google' } }) }] });
    try {
        assert.equal((await signInWithGoogle(options)).authProvider, 'google');
        assert.equal(fetches[0].url, 'http://127.0.0.1:48900/api/auth/supabase/google');
        assert.deepEqual(JSON.parse(fetches[0].options.body), authorization);
        assert.equal(saved[0].token, 'local-session');
    } finally { restore(); globalThis.alphaGoogleSignIn = originalGoogle; }
});

test('Supabase verification failure does not persist a session', async () => {
    const { signInWithGoogle } = await import(MODULE_URL);
    const saved = [], originalGoogle = globalThis.alphaGoogleSignIn;
    globalThis.alphaGoogleSignIn = { start: async () => ({ code: 'bad', verifier: 'v'.repeat(64) }) };
    const restore = withStubs([], saved, { responses: [{ ok: false, status: 401, text: async () => '{"error":"Identity rejected"}' }] });
    try {
        await assert.rejects(signInWithGoogle({ provider: 'supabase' }), /Identity rejected/);
        assert.equal(saved.length, 0);
    } finally { restore(); globalThis.alphaGoogleSignIn = originalGoogle; }
});

test('sign-out revokes the stored token server-side, then clears it locally', async () => {
    const { signOut } = await import(MODULE_URL);
    const fetches = [];
    const saved = [];
    const restore = withStubs(fetches, saved, { storedToken: 'tok-123' });
    try {
        await signOut();
        assert.equal(fetches[0].url, 'http://127.0.0.1:48900/api/auth/logout');
        assert.equal(new Headers(fetches[0].options.headers).get('Authorization'), 'Bearer tok-123');
        assert.equal(saved.at(-1).token, '');
    } finally {
        restore();
    }
});

test('sign-out still drops the local token when the backend is unreachable', async () => {
    const { signOut } = await import(MODULE_URL);
    const fetches = [];
    const saved = [];
    const restore = withStubs(fetches, saved, {
        storedToken: 'tok-123',
        responses: [{ ok: false, status: 0, text: async () => '' }],
    });
    try {
        await signOut();
        assert.equal(fetches.length, 1, 'the revoke attempt happened');
        assert.equal(saved.at(-1).token, '', 'the local token was dropped anyway');
    } finally {
        restore();
    }
});

test('a failed or empty session check reads as signed out', async () => {
    const { fetchSession } = await import(MODULE_URL);
    const fetches = [];
    const saved = [];
    const restore = withStubs(fetches, saved, {
        responses: [{ ok: true, status: 200, text: async () => JSON.stringify({ account: null }) }],
    });
    try {
        assert.equal(await fetchSession(), null);
        assert.equal(fetches[0].url, 'http://127.0.0.1:48900/api/auth/session');
    } finally {
        restore();
    }
});

test('local entry switches a remote connection to loopback and persists the choice', async () => {
    const { enterLocalMode, hasLocalMode, rememberLocalMode } = await import(MODULE_URL);
    const previous = { connection: globalThis.alphaConnection, storage: globalThis.localStorage };
    const data = new Map();
    let connection = { url: 'https://workspace.example.com', token: 'remote-session' };
    globalThis.alphaConnection = { get: () => connection, save: async value => { connection = value; } };
    globalThis.localStorage = { getItem: key => data.get(key), setItem: (key, value) => data.set(key, value), removeItem: key => data.delete(key) };
    try {
        assert.equal(hasLocalMode(), false);
        await enterLocalMode();
        assert.deepEqual(connection, { url: 'http://127.0.0.1:48900', token: '' });
        assert.equal(hasLocalMode(), true);
        connection = { url: 'https://workspace.example.com', token: '' };
        assert.equal(hasLocalMode(), false, 'local preference never bypasses remote sign-in');
        connection = { url: 'http://localhost:49900', token: '' };
        await enterLocalMode();
        assert.equal(connection.url, 'http://localhost:49900', 'a configured local port is preserved');
        rememberLocalMode(false);
        assert.equal(data.size, 0);
    } finally {
        globalThis.alphaConnection = previous.connection;
        globalThis.localStorage = previous.storage;
    }
});

test('sign-out reports unconfirmed revocation and never hides storage failures', async () => {
    const { signOut } = await import(MODULE_URL);
    const restore = withStubs([], [], { responses: [{ ok: false, status: 503, text: async () => '{"error":"unavailable"}' }] });
    try { assert.equal((await signOut()).revoked, false); }
    finally { restore(); }
    const restoreAgain = withStubs([], []);
    globalThis.alphaConnection.save = async () => { throw new Error('Storage locked'); };
    try { await assert.rejects(signOut(), /Storage locked/); }
    finally { restoreAgain(); }
});

test('password changes rotate the locally saved session', async () => {
    const { changePassword } = await import(MODULE_URL);
    const fetches = [], saved = [];
    const restore = withStubs(fetches, saved, { storedToken: 'old', responses: [{ ok: true, status: 200, text: async () => JSON.stringify({ token: 'rotated', account: { id: 'a1' } }) }] });
    try {
        assert.deepEqual(await changePassword({ currentPassword: 'first password', password: 'new password' }), { id: 'a1' });
        assert.equal(fetches[0].url, 'http://127.0.0.1:48900/api/auth/password');
        assert.equal(saved[0].token, 'rotated');
    } finally { restore(); }
});
