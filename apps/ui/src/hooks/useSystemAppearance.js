import { useEffect } from 'react';

export function applySystemAppearance(isDark) {
    document.documentElement.classList.toggle('dark', isDark);
    document.documentElement.style.colorScheme = isDark ? 'dark' : 'light';
}

export function useSystemAppearance() {
    useEffect(() => {
        const query = window.matchMedia('(prefers-color-scheme: dark)');
        applySystemAppearance(query.matches);

        const handleChange = event => applySystemAppearance(event.matches);
        query.addEventListener('change', handleChange);
        return () => query.removeEventListener('change', handleChange);
    }, []);
}
