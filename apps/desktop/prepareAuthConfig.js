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

function buildConfig(settings, environment = process.env) {
    settings = { ...settings };
    for (const name of ['KESAMI_AUTH_PROVIDER', 'KESAMI_SUPABASE_URL', 'KESAMI_SUPABASE_PUBLISHABLE_KEY', 'KESAMI_CLOUD_URL']) {
        if (environment[name]) settings[name] = environment[name];
    }
    const provider = settings.KESAMI_AUTH_PROVIDER;
    const url = settings.KESAMI_SUPABASE_URL;
    const publishableKey = settings.KESAMI_SUPABASE_PUBLISHABLE_KEY;
    const cloudUrl = settings.KESAMI_CLOUD_URL || '';
    if (!cloudUrl) throw new Error('Release builds require KESAMI_CLOUD_URL: the public HTTPS origin of the Kesami cloud relay. Provider keys belong on that server.');
    const parsed = new URL(url);
    if (provider !== 'supabase' || parsed.protocol !== 'https:' || parsed.username || parsed.password
        || parsed.pathname !== '/' || parsed.search || parsed.hash || !/^sb_publishable_[A-Za-z0-9_-]+$/.test(publishableKey)) {
        throw new Error('apps/ui/.env needs a Supabase provider, bare HTTPS project URL, and sb_publishable_ key');
    }
    const cloud = new URL(cloudUrl);
    if (cloud.protocol !== 'https:' || cloud.username || cloud.password || cloud.pathname !== '/'
        || cloud.search || cloud.hash) throw new Error('KESAMI_CLOUD_URL must be a bare HTTPS origin');
    return { provider, url: parsed.origin, publishableKey, cloudUrl: cloud.origin };
}

if (require.main === module) try {
    const config = buildConfig(fs.existsSync(source) ? readSettings(source) : {});
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, JSON.stringify(config), { mode: 0o600 });
    fs.chmodSync(output, 0o600);
    console.log('Prepared public Supabase sign-in settings for the desktop package.');
} catch (cause) {
    console.error(`Cannot prepare desktop sign-in settings: ${cause.message}`);
    process.exitCode = 1;
}

module.exports = { buildConfig };
