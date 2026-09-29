import { adoptLegacyKey } from './legacyStorage.js';
// Personal preferences belong to this device, never to the shared service.
const STORAGE_KEY = 'kesami.preferences.v1';
adoptLegacyKey('localStorage', 'alpha.preferences.v1', STORAGE_KEY);
export const DEFAULT_PREFERENCES = Object.freeze({
    displayName: '',
    workspaceName: 'My workspace',
    textSize: 'comfortable',
    reducedMotion: false,
});

export function normalizePreferences(value = {}) {
    const input = value && typeof value === 'object' ? value : {};
    const text = (key, fallback) => typeof input[key] === 'string' ? input[key].trim().slice(0, 60) || fallback : fallback;
    return Object.freeze({
        displayName: text('displayName', ''),
        workspaceName: text('workspaceName', DEFAULT_PREFERENCES.workspaceName),
        textSize: input.textSize === 'large' ? 'large' : 'comfortable',
        reducedMotion: input.reducedMotion === true,
    });
}

function readPreferences() {
    try {
        return normalizePreferences(JSON.parse(globalThis.localStorage?.getItem(STORAGE_KEY) || '{}'));
    } catch {
        return DEFAULT_PREFERENCES;
    }
}

let current = readPreferences();
const listeners = new Set();

export function getPreferences() { return current; }

export function subscribePreferences(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

function adopt(next) {
    if (JSON.stringify(next) === JSON.stringify(current)) return;
    current = next;
    listeners.forEach(listener => listener());
}

export function setPreferences(patch) {
    const next = normalizePreferences({ ...current, ...patch });
    let persisted = false;
    try {
        if (globalThis.localStorage) {
            globalThis.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
            persisted = true;
        }
    } catch { /* The preference still applies when device storage is unavailable. */ }
    adopt(next);
    return { preferences: current, persisted };
}

globalThis.addEventListener?.('storage', event => {
    if (event.key === STORAGE_KEY || event.key === null) adopt(readPreferences());
});

export function applyPreferences(preferences, root = globalThis.document?.documentElement) {
    if (!root) return;
    root.dataset.textSize = preferences.textSize;
    root.dataset.reducedMotion = String(preferences.reducedMotion);
}
