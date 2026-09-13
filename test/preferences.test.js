const assert = require('node:assert/strict');
const { test } = require('node:test');
const load = () => import('../apps/ui/src/lib/preferences.js');

test('personal preferences normalize corrupt values and never persist unrelated data', async () => {
    const { normalizePreferences, DEFAULT_PREFERENCES } = await load();
    assert.deepEqual(normalizePreferences(null), DEFAULT_PREFERENCES);
    assert.deepEqual(normalizePreferences({ textSize: 'tiny', reducedMotion: 'false', workspaceName: '  ', apiKey: 'not-a-real-key' }), DEFAULT_PREFERENCES);
    assert.deepEqual(normalizePreferences({ displayName: '  Riya  ', workspaceName: 'Design', textSize: 'large', reducedMotion: true }), {
        displayName: 'Riya', workspaceName: 'Design', textSize: 'large', reducedMotion: true,
    });
    assert.equal(normalizePreferences({ workspaceName: 'a'.repeat(100) }).workspaceName.length, 60);
});

test('preferences apply immediately, report storage failure and support unsubscribe', async () => {
    const { setPreferences, getPreferences, subscribePreferences, applyPreferences } = await load();
    const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { setItem() { throw new Error('Storage disabled'); } } });
    try {
        let changes = 0;
        const unsubscribe = subscribePreferences(() => changes++);
        const result = setPreferences({ textSize: 'large', reducedMotion: true });
        assert.equal(result.persisted, false);
        assert.equal(getPreferences().textSize, 'large');
        const root = { dataset: {} };
        applyPreferences(getPreferences(), root);
        assert.deepEqual(root.dataset, { textSize: 'large', reducedMotion: 'true' });
        assert.equal(changes, 1);
        setPreferences({ textSize: 'large' });
        assert.equal(changes, 1);
        unsubscribe();
        setPreferences({ textSize: 'comfortable', reducedMotion: false });
        assert.equal(changes, 1);
    } finally {
        if (previous) Object.defineProperty(globalThis, 'localStorage', previous);
        else delete globalThis.localStorage;
    }
});
