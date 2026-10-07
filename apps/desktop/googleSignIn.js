const crypto = require('node:crypto');
const http = require('node:http');
const { ipcMain, shell } = require('electron');

const CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar.events';

let signingIn = false;

async function start(options) {
    if (signingIn) throw new Error('Google sign-in is already in progress.');
    const supabase = options?.provider === 'supabase';
    const clientId = typeof options === 'string' ? options : options?.clientId;
    const calendar = !supabase && options?.calendar === true;
    let project;
    if (supabase) {
        try { project = new URL(options.url); } catch { throw new Error('Supabase sign-in is not configured.'); }
        if (project.protocol !== 'https:' || project.username || project.password || project.pathname !== '/' || project.search || project.hash) {
            throw new Error('Supabase sign-in URL is invalid.');
        }
    } else if (typeof clientId !== 'string' || !/^\S+\.apps\.googleusercontent\.com$/.test(clientId)) {
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
        // Supabase owns Google's OAuth state. Bind its return to this attempt
        // with an unguessable callback path, in addition to the PKCE verifier.
        const callbackPath = supabase ? `/auth/callback/${state}` : '/';
        const redirectUri = `http://127.0.0.1:${server.address().port}${supabase ? callbackPath : ''}`;
        const callback = new Promise((resolve, reject) => {
            callbackTimer = setTimeout(() => reject(new Error('Google sign-in timed out.')), 5 * 60_000);
            server.on('request', (request, response) => {
                let incoming;
                try { incoming = new URL(request.url, redirectUri); } catch { response.writeHead(400).end(); return; }
                response.setHeader('Cache-Control', 'no-store');
                response.setHeader('Referrer-Policy', 'no-referrer');
                response.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
                if (request.method !== 'GET' || incoming.origin !== new URL(redirectUri).origin || incoming.pathname !== callbackPath || (!supabase && incoming.searchParams.get('state') !== state)) {
                    response.writeHead(400).end('Invalid sign-in callback.');
                    return;
                }
                response.setHeader('Content-Type', 'text/html; charset=utf-8');
                clearTimeout(callbackTimer);
                response.once('finish', () => {
                    if (incoming.searchParams.get('error')) reject(new Error('Google sign-in was cancelled or denied.'));
                    else if (!incoming.searchParams.get('code')) reject(new Error('Google did not return an authorization code.'));
                    else resolve(incoming.searchParams.get('code'));
                });
                response.end('<!doctype html><title>Return to Kesami</title><p>Return to Kesami to finish signing in.</p>');
            });
        });
        // Install a rejection handler before opening the browser, which can fail
        // or remain pending while the callback times out.
        callback.catch(() => {});
        const auth = supabase ? new URL('/auth/v1/authorize', project) : new URL('https://accounts.google.com/o/oauth2/v2/auth');
        auth.search = new URLSearchParams(supabase
            ? { provider: 'google', redirect_to: redirectUri, scopes: 'openid email profile', code_challenge: challenge, code_challenge_method: 's256' }
            : {
                client_id: clientId,
                redirect_uri: redirectUri,
                response_type: 'code',
                scope: calendar ? `openid email profile ${CALENDAR_SCOPE}` : 'openid email profile',
                code_challenge: challenge,
                code_challenge_method: 'S256',
                state,
                nonce,
                ...(calendar ? { access_type: 'offline', include_granted_scopes: 'true', prompt: 'consent' } : {}),
            }).toString();
        await shell.openExternal(auth.toString());
        const code = await callback;
        return supabase ? { code, verifier } : { code, verifier, redirectUri, nonce };
    } finally {
        clearTimeout(callbackTimer);
        if (server.listening) server.close();
        server.closeAllConnections();
        signingIn = false;
    }
}

function registerHandlers(ipc = ipcMain) {
    ipc.handle('google-sign-in:start', (_event, options) => start(options));
}

module.exports = { registerHandlers };
