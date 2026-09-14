// Sign-in and account creation ride the backend's own HTTP API and store the
// session through the same connection plumbing the deployment token uses, so
// the rest of the app never learns where the token came from.
import { apiRequest } from './backend.js';
import { getBackendUrl, saveBackendConnection } from './connection.js';

async function rememberSession(token) {
    if (!token) throw new Error('The backend did not return a session token.');
    await saveBackendConnection({ url: getBackendUrl(), token });
    return token;
}

export async function createAccount({ name, email, password }) {
    const result = await apiRequest('/api/auth/register', {
        method: 'POST',
        body: { name, email, password },
    });
    await rememberSession(result.token);
    return result.account;
}

export async function signIn({ email, password }) {
    const result = await apiRequest('/api/auth/login', {
        method: 'POST',
        body: { email, password },
    });
    await rememberSession(result.token);
    return result.account;
}

/**
 * Returns the signed-in account, or null when nobody is signed in. A backend
 * that cannot be reached counts as signed out: the sign-in screen decides what
 * to tell the user, and the workspace still opens.
 */
export async function fetchSession() {
    try {
        const result = await apiRequest('/api/auth/session');
        return result.account || null;
    } catch {
        return null;
    }
}

/**
 * Revokes the session server-side, then drops the local token so reconnects
 * and sockets stop presenting it. Both halves are best effort.
 */
export async function signOut() {
    try {
        await apiRequest('/api/auth/logout', { method: 'POST', body: {} });
    } catch {
        // The local drop below is what actually matters to the UI.
    }
    try {
        await saveBackendConnection({ url: getBackendUrl(), token: '' });
    } catch {
        // Nothing to recover: without a stored token the next launch asks for
        // credentials again anyway.
    }
}
