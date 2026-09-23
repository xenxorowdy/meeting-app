const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../apps/desktop/googleSignIn.js'), 'utf8');
const options = { provider: 'supabase', url: 'https://project.supabase.co' };

function desktop(openExternal, { timeout = 5_000 } = {}) {
    let handler;
    const context = {
        require: name => name === 'electron' ? {
            shell: { openExternal }, ipcMain: { handle: (_channel, callback) => { handler = callback; } },
        } : require(name),
        module: { exports: {} }, URL, URLSearchParams,
        setTimeout: callback => setTimeout(callback, timeout), clearTimeout,
    };
    vm.runInNewContext(source, context);
    context.module.exports.registerHandlers();
    return input => handler({}, input);
}

test('Supabase desktop sign-in binds a loopback callback to PKCE and ignores unrelated requests', async () => {
    let auth, redirect;
    const start = desktop(async url => {
        auth = new URL(url);
        assert.equal(auth.origin, options.url);
        assert.equal(auth.pathname, '/auth/v1/authorize');
        assert.equal(auth.searchParams.get('provider'), 'google');
        assert.equal(auth.searchParams.get('code_challenge_method'), 's256');
        assert.equal(auth.searchParams.has('client_id'), false);
        assert.equal(auth.searchParams.has('apikey'), false);
        redirect = new URL(auth.searchParams.get('redirect_to'));
        assert.equal(redirect.hostname, '127.0.0.1');
        assert.match(redirect.pathname, /^\/auth\/callback\/[\w-]{32}$/);
        assert.equal((await fetch(`${redirect.origin}/auth/callback/wrong?code=forged`)).status, 400);
        assert.equal((await fetch(redirect, { method: 'POST' })).status, 400);
        const response = await fetch(`${redirect}?code=one-time-code`);
        assert.equal(response.headers.get('cache-control'), 'no-store');
        assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
        assert.match(await response.text(), /Return to Kesami/);
    });
    const authorization = await start(options);
    assert.equal(authorization.code, 'one-time-code');
    assert.equal(crypto.createHash('sha256').update(authorization.verifier).digest('base64url'), auth.searchParams.get('code_challenge'));
    assert.deepEqual(Object.keys(authorization).sort(), ['code', 'verifier']);
    await assert.rejects(fetch(redirect), /fetch failed/);
});

test('legacy direct Google sign-in still checks state and returns its original payload', async () => {
    let auth;
    const start = desktop(async url => {
        auth = new URL(url);
        assert.equal(auth.origin, 'https://accounts.google.com');
        const redirect = auth.searchParams.get('redirect_uri');
        assert.equal((await fetch(`${redirect}?code=forged&state=wrong`)).status, 400);
        await fetch(`${redirect}?code=legacy-code&state=${auth.searchParams.get('state')}`);
    });
    const result = await start('client.apps.googleusercontent.com');
    assert.equal(result.code, 'legacy-code');
    assert.equal(result.nonce, auth.searchParams.get('nonce'));
    assert.equal(result.redirectUri, auth.searchParams.get('redirect_uri'));
});

test('denied, missing-code, and timed-out attempts release the listener', async () => {
    for (const [query, message] of [['error=access_denied', /cancelled or denied/], ['', /authorization code/]]) {
        let redirect;
        const start = desktop(async url => {
            redirect = new URL(url).searchParams.get('redirect_to');
            await fetch(`${redirect}?${query}`);
        });
        await assert.rejects(start(options), message);
        await assert.rejects(fetch(redirect), /fetch failed/);
    }
    let redirect;
    const start = desktop(async url => { redirect = new URL(url).searchParams.get('redirect_to'); }, { timeout: 20 });
    await assert.rejects(start(options), /timed out/);
    await assert.rejects(fetch(redirect), /fetch failed/);
});

test('browser failures release the sign-in lock and concurrent attempts are refused', async () => {
    const start = desktop(async () => { throw new Error('Browser unavailable'); });
    await assert.rejects(start(options), /Browser unavailable/);
    await assert.rejects(start(options), /Browser unavailable/);
    let releaseBrowser, opened;
    const ready = new Promise(resolve => { opened = resolve; });
    const simultaneous = desktop(() => { opened(); return new Promise(resolve => { releaseBrowser = resolve; }); }, { timeout: 30 });
    const pending = simultaneous(options);
    const rejected = assert.rejects(pending, /timed out/);
    await ready;
    await assert.rejects(simultaneous(options), /already in progress/);
    releaseBrowser();
    await rejected;
});

test('untrusted URL forms are rejected before opening the browser', async () => {
    let opened = false;
    const start = desktop(async () => { opened = true; });
    for (const url of ['file:///tmp/test', 'http://project.supabase.co', 'https://user:secret@project.supabase.co', 'https://project.supabase.co/auth/v1', 'https://project.supabase.co?key=value']) {
        await assert.rejects(start({ ...options, url }), /URL is invalid/);
    }
    assert.equal(opened, false);
});
