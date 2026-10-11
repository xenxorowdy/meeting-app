const assert = require('node:assert/strict');
const { test } = require('node:test');
const { buildConfig } = require('../apps/desktop/prepareAuthConfig');
const settings = {
    KESAMI_AUTH_PROVIDER: 'supabase', KESAMI_SUPABASE_URL: 'https://project.supabase.co',
    KESAMI_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test', KESAMI_CLOUD_URL: 'https://api.example.com',
    KESAMI_GOOGLE_CALENDAR_CLIENT_ID: 'desktop.apps.googleusercontent.com',
};

test('release builds require a cloud origin rather than shipping a client that needs provider keys', () => {
    assert.throws(() => buildConfig({ ...settings, KESAMI_CLOUD_URL: '' }, {}), /Release builds require KESAMI_CLOUD_URL/);
    assert.throws(() => buildConfig({ ...settings, KESAMI_GOOGLE_CALENDAR_CLIENT_ID: '' }, {}), /Release builds require KESAMI_GOOGLE_CALENDAR_CLIENT_ID/);
    for (const url of ['http://api.example.com', 'https://secret@api.example.com', 'https://api.example.com/v1', 'https://api.example.com?key=secret']) {
        assert.throws(() => buildConfig({ ...settings, KESAMI_CLOUD_URL: url }, {}), /bare HTTPS origin/);
    }
});

test('the client package contains only allowlisted public configuration', () => {
    const config = buildConfig({ ...settings, KESAMI_GOOGLE_CALENDAR_CLIENT_SECRET: 'private-google', KESAMI_SARVAM_API_KEY: 'private-sarvam', KESAMI_GEMINI_API_KEY: 'private-gemini', KESAMI_SUPABASE_SECRET_KEY: 'private-admin' }, {});
    assert.deepEqual(config, { provider: 'supabase', url: settings.KESAMI_SUPABASE_URL, publishableKey: settings.KESAMI_SUPABASE_PUBLISHABLE_KEY, cloudUrl: settings.KESAMI_CLOUD_URL, googleCalendarClientId: settings.KESAMI_GOOGLE_CALENDAR_CLIENT_ID });
    assert(!JSON.stringify(config).includes('private-'));
});

test('CI and packaging environment override local public configuration', () => {
    assert.equal(buildConfig(settings, { KESAMI_CLOUD_URL: 'https://release.example.com' }).cloudUrl, 'https://release.example.com');
    assert.equal(buildConfig(settings, { KESAMI_GOOGLE_CALENDAR_CLIENT_ID: 'release.apps.googleusercontent.com' }).googleCalendarClientId, 'release.apps.googleusercontent.com');
    assert.deepEqual(buildConfig({}, settings), buildConfig(settings, {}));
});
