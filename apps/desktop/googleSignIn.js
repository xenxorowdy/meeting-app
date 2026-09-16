const crypto = require('node:crypto');
const http = require('node:http');
const { ipcMain, shell } = require('electron');

let signingIn = false;

async function start(clientId) {
    if (signingIn) throw new Error('Google sign-in is already in progress.');
    if (typeof clientId !== 'string' || !/^\S+\.apps\.googleusercontent\.com$/.test(clientId)) {
        throw new Error('Add a Google Desktop app OAuth client ID in Calendar settings first.');
    }
    signingIn = true;
    const verifier = crypto.randomBytes(48).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    const state = crypto.randomBytes(24).toString('base64url');
    const nonce = crypto.randomBytes(24).toString('base64url');
    const server = http.createServer();
    let callbackTimer;
    try {
        await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
        const redirectUri = `http://127.0.0.1:${server.address().port}`;
        const callback = new Promise((resolve, reject) => {
            callbackTimer = setTimeout(() => reject(new Error('Google sign-in timed out.')), 5 * 60_000);
            server.on('request', (request, response) => {
                const incoming = new URL(request.url, redirectUri);
                response.setHeader('Content-Type', 'text/html; charset=utf-8');
                response.end('<!doctype html><title>Sign-in complete</title><p>You can return to Kesami.</p>');
                if (incoming.pathname !== '/' || incoming.searchParams.get('state') !== state) return;
                clearTimeout(callbackTimer);
                if (incoming.searchParams.get('error')) reject(new Error('Google sign-in was cancelled or denied.'));
                else if (!incoming.searchParams.get('code')) reject(new Error('Google did not return an authorization code.'));
                else resolve(incoming.searchParams.get('code'));
            });
        });
        const auth = new URL('https://accounts.google.com/o/oauth2/v2/auth');
        auth.search = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, response_type: 'code', scope: 'openid email profile', code_challenge: challenge, code_challenge_method: 'S256', state, nonce }).toString();
        await shell.openExternal(auth.toString());
        const code = await callback;
        return { code, verifier, redirectUri, nonce };
    } finally {
        clearTimeout(callbackTimer);
        if (server.listening) server.close();
        signingIn = false;
    }
}

function registerHandlers() {
    ipcMain.handle('google-sign-in:start', (_event, clientId) => start(clientId));
}

module.exports = { registerHandlers };
