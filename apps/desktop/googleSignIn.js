const crypto = require('node:crypto');
const http = require('node:http');
const { ipcMain, shell } = require('electron');

const CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar.events';

let signingIn = false;

async function start(options, onReturn = () => {}) {
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
                    try { onReturn(); } catch { /* The browser link remains available. */ }
                    if (incoming.searchParams.get('error')) reject(new Error('Google sign-in was cancelled or denied.'));
                    else if (!incoming.searchParams.get('code')) reject(new Error('Google did not return an authorization code.'));
                    else resolve(incoming.searchParams.get('code'));
                });
                const cancelled = incoming.searchParams.has('error');
                const missingCode = !incoming.searchParams.get('code');
                response.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
                response.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Return to Kesami</title><style>
                    :root{color-scheme:light dark}body{margin:0;min-height:100vh;display:grid;place-items:center;background:light-dark(#f8f7f5,#22211f);color:light-dark(#292723,#f5f4f1);font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}main{max-width:440px;padding:40px}h1{font-size:30px;line-height:1.2}a{display:inline-block;margin-top:16px;padding:12px 24px;background:#bd462e;color:#fff;border-radius:12px;text-decoration:none;font-weight:600}a:hover{background:#a83c26}a:focus-visible{outline:3px solid currentColor;outline-offset:4px}small{display:block;margin-top:24px;opacity:.8}
                    </style></head><body><main><strong>KESAMI</strong><h1>${cancelled ? 'Sign-in was cancelled' : missingCode ? 'Sign-in could not continue' : 'Return to Kesami'}</h1><p>${cancelled || missingCode ? 'Open Kesami to try signing in again.' : 'Continue in Kesami to finish signing in. If the app hasn’t appeared, use the button below.'}</p><a href="kesami://open">Open Kesami</a><small>Your browser may ask you to confirm opening Kesami. You can close this tab after returning to the app.</small></main></body></html>`);
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

function registerHandlers(ipc = ipcMain, { onReturn } = {}) {
    ipc.handle('google-sign-in:start', (_event, options) => start(options, onReturn));
}

module.exports = { registerHandlers };
