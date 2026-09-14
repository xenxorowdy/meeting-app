// Sign-in and account creation ride the backend's own HTTP API and store the
// session through the same connection plumbing the deployment token uses, so
// the rest of the app never learns where the token came from.
import { apiRequest } from './backend.js';
import { DEFAULT_BACKEND_URL, getBackendConnection, getBackendUrl, saveBackendConnection } from './connection.js';

async function rememberSession(token) {
    if (!token) throw new Error('The backend did not return a session token.');
    await saveBackendConnection({ url: getBackendUrl(), token });
    rememberLocalMode(false);
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
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
        const result = await apiRequest('/api/auth/session', { signal: controller.signal });
        return result.account || null;
    } catch {
        return null;
    } finally {
        clearTimeout(timer);
    }
}

// Clear storage only after the revoke attempt; report failures truthfully.
export async function signOut() {
    let revoked = false;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
        await apiRequest('/api/auth/logout', { method: 'POST', body: {}, signal: controller.signal });
        revoked = true;
    } catch {
        // The caller tells the user that server revocation was not confirmed.
    } finally {
        clearTimeout(timer);
    }
    await saveBackendConnection({ url: getBackendUrl(), token: '' });
    rememberLocalMode(false);
    return { revoked };
}

const LOCAL_MODE_KEY = 'alpha.local-mode';
export function rememberLocalMode(enabled) {
    try {
        if (enabled) globalThis.localStorage?.setItem(LOCAL_MODE_KEY, 'true');
        else globalThis.localStorage?.removeItem(LOCAL_MODE_KEY);
    } catch { /* Local use still works if storage is unavailable. */ }
}
export function hasLocalMode() {
    try { return !getBackendConnection().remote && !getBackendConnection().token && globalThis.localStorage?.getItem(LOCAL_MODE_KEY) === 'true'; }
    catch { return false; }
}
export async function enterLocalMode() {
    const connection = getBackendConnection();
    await saveBackendConnection({ url: connection.remote ? DEFAULT_BACKEND_URL : connection.url, token: '' });
    rememberLocalMode(true);
}
export async function changePassword({ currentPassword, password }) {
    const result = await apiRequest('/api/auth/password', { method: 'POST', body: { currentPassword, password } });
    await rememberSession(result.token);
    return result.account;
}
