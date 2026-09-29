import { adoptLegacyKey } from './legacyStorage.js';
export const DEFAULT_BACKEND_URL = 'http://127.0.0.1:48900';
const URL_KEY = 'kesami.backend.url';
const TOKEN_KEY = 'kesami.backend.session-token';
adoptLegacyKey('localStorage', 'alpha.backend.url', URL_KEY);
adoptLegacyKey('sessionStorage', 'alpha.backend.session-token', TOKEN_KEY);
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

export function normalizeBackendUrl(value) {
    let url;
    try { url = new URL(String(value || '').trim()); } catch { throw new Error('Enter a complete backend URL, such as https://meetings.example.com.'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
        throw new Error('Use an HTTP or HTTPS URL without credentials, a query, or a fragment.');
    }
    if (url.protocol !== 'https:' && !LOOPBACK_HOSTS.has(url.hostname)) {
        throw new Error('Remote connections require HTTPS to protect meeting audio and your access token.');
    }
    return url.href.replace(/\/+$/, '');
}

function stored(storage, key) {
    try { return globalThis[storage]?.getItem(key) || ''; } catch { return ''; }
}

export function getBackendConnection() {
    const desktop = globalThis.kesamiConnection?.get?.();
    const candidate = desktop?.url || stored('localStorage', URL_KEY) || import.meta.env?.VITE_BACKEND_URL || DEFAULT_BACKEND_URL;
    // Invalid configuration must not silently redirect private meeting data to a different server.
    const url = normalizeBackendUrl(candidate);
    const token = desktop?.token || (desktop ? '' : stored('sessionStorage', TOKEN_KEY));
    return { url, token, remote: !LOOPBACK_HOSTS.has(new URL(url).hostname) };
}

export const getBackendUrl = () => getBackendConnection().url;
export const isRemoteBackend = () => getBackendConnection().remote;

export function backendHeaders(headers = {}, connection = getBackendConnection()) {
    const result = new Headers(headers);
    if (connection.token) result.set('Authorization', `Bearer ${connection.token}`);
    return result;
}

export function backendSocketProtocols(connection = getBackendConnection()) {
    if (!connection.token) return ['kesami'];
    const bytes = new TextEncoder().encode(connection.token);
    const encoded = btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join(''))
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    return ['kesami', `kesami-token.${encoded}`];
}

export async function saveBackendConnection({ url, token = '' }) {
    const normalized = normalizeBackendUrl(url);
    const secret = String(token).trim();
    if (/[\r\n]/.test(secret)) throw new Error('The access token must fit on one line.');
    if (globalThis.kesamiConnection?.save) {
        await globalThis.kesamiConnection.save({ url: normalized, token: secret });
    } else {
        // Provider credentials belong on the backend. The connection token lives only for this browser session.
        globalThis.localStorage?.setItem(URL_KEY, normalized);
        if (secret) globalThis.sessionStorage?.setItem(TOKEN_KEY, secret);
        else globalThis.sessionStorage?.removeItem(TOKEN_KEY);
    }
    return { url: normalized, token: secret, remote: !LOOPBACK_HOSTS.has(new URL(normalized).hostname) };
}
