const fs = require('node:fs');
const path = require('node:path');

const source = path.resolve(__dirname, '../ui/.env');
const output = path.resolve(__dirname, 'packaging/generated/auth-config.json');

function readSettings(file) {
    const settings = {};
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
        const match = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
        if (!match) continue;
        let value = match[2];
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
        }
        settings[match[1]] = value;
    }
    return settings;
}

try {
    const settings = readSettings(source);
    const provider = settings.KESAMI_AUTH_PROVIDER;
    const url = settings.KESAMI_SUPABASE_URL;
    const publishableKey = settings.KESAMI_SUPABASE_PUBLISHABLE_KEY;
    const cloudUrl = process.env.KESAMI_CLOUD_URL || settings.KESAMI_CLOUD_URL || '';
    const parsed = new URL(url);
    if (provider !== 'supabase' || parsed.protocol !== 'https:' || parsed.username || parsed.password
        || parsed.pathname !== '/' || parsed.search || parsed.hash || !/^sb_publishable_[A-Za-z0-9_-]+$/.test(publishableKey)) {
        throw new Error('apps/ui/.env needs a Supabase provider, bare HTTPS project URL, and sb_publishable_ key');
    }
    let publicCloudUrl = null;
    if (cloudUrl) {
        const cloud = new URL(cloudUrl);
        if (cloud.protocol !== 'https:' || cloud.username || cloud.password || cloud.pathname !== '/'
            || cloud.search || cloud.hash) throw new Error('KESAMI_CLOUD_URL must be a bare HTTPS origin');
        publicCloudUrl = cloud.origin;
    }
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, JSON.stringify({ provider, url: parsed.origin, publishableKey, cloudUrl: publicCloudUrl }), { mode: 0o600 });
    fs.chmodSync(output, 0o600);
    console.log('Prepared public Supabase sign-in settings for the desktop package.');
} catch (cause) {
    console.error(`Cannot prepare desktop sign-in settings: ${cause.message}`);
    process.exitCode = 1;
}
