import { useEffect, useSyncExternalStore } from 'react';
import { applyPreferences, DEFAULT_PREFERENCES, getPreferences, setPreferences, subscribePreferences } from '@/lib/preferences';

export function usePreferences() {
    const preferences = useSyncExternalStore(subscribePreferences, getPreferences, () => DEFAULT_PREFERENCES);
    useEffect(() => applyPreferences(preferences), [preferences]);
    return [preferences, setPreferences];
}
