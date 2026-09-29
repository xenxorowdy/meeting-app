export function adoptLegacyKey(storageName, legacyKey, key) {
    try {
        const storage = globalThis[storageName];
        if (!storage) return;
        const legacy = storage.getItem(legacyKey);
        if (legacy === null) return;
        if (storage.getItem(key) === null) storage.setItem(key, legacy);
        storage.removeItem(legacyKey);
    } catch {
        return;
    }
}
