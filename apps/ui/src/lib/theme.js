import { useEffect, useSyncExternalStore } from 'react';

const STORAGE_KEY = 'alpha.appearance';
const listeners = new Set();

function storedChoice() {
    try {
        const saved = window.localStorage.getItem(STORAGE_KEY);
        return saved === 'light' || saved === 'dark' ? saved : null;
    } catch {
        return null;
    }
}

function systemTheme() {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

let current = storedChoice() ?? systemTheme();

export function applyTheme(theme) {
    document.documentElement.classList.toggle('dark', theme === 'dark');
    document.documentElement.style.colorScheme = theme;
}

export function getTheme() {
    return current;
}

function adopt(next) {
    if (next === current) return;
    current = next;
    applyTheme(current);
    listeners.forEach(listener => listener());
}

export function setTheme(next) {
    if (next !== 'light' && next !== 'dark') return;
    try {
        window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
        // A choice that cannot be persisted still applies for this session.
    }
    adopt(next);
}

window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (!storedChoice()) adopt(systemTheme());
});

function subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

export function useTheme() {
    const theme = useSyncExternalStore(subscribe, getTheme, getTheme);

    useEffect(() => {
        if (!storedChoice()) adopt(systemTheme());
    }, []);

    useEffect(() => {
        applyTheme(theme);
    }, [theme]);

    return [theme, setTheme];
}
