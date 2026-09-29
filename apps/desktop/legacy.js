const fs = require('node:fs');
const path = require('node:path');

const PREFIX = 'KESAMI_';
const LEGACY_PREFIX = 'ALPHA_';
const LEGACY_USER_DATA = ['@alpha', 'meeting-desktop'];
const LEGACY_BACKEND_DATA = '.alpha-meeting-assistant';
const BACKEND_DATA = '.kesami';
const LEGACY_LIBRARY = 'Alpha Meetings';
const LIBRARY = 'Kesami Meetings';

function env(name, source = process.env) {
    const value = source[`${PREFIX}${name}`];
    if (value !== undefined && value !== '') return value;
    const legacy = source[`${LEGACY_PREFIX}${name}`];
    return legacy !== undefined && legacy !== '' ? legacy : undefined;
}

function pidAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    } catch (cause) {
        return cause.code === 'EPERM';
    }
}

function lockHeld(dir) {
    try {
        const target = fs.readlinkSync(path.join(dir, 'SingletonLock'));
        const pid = Number(String(target).split('-').pop());
        return Number.isInteger(pid) && pid > 0 && pidAlive(pid);
    } catch {
        return false;
    }
}

function adoptDir(oldDir, newDir, { skipIfLocked = false } = {}) {
    if (fs.existsSync(newDir) || !fs.existsSync(oldDir)) return false;
    if (skipIfLocked && lockHeld(oldDir)) return false;
    fs.mkdirSync(path.dirname(newDir), { recursive: true });
    fs.renameSync(oldDir, newDir);
    return true;
}

function adoptLegacyLocations(app, { log = console.log, source = process.env } = {}) {
    const moved = [];
    const attempt = (label, oldDir, newDir, options) => {
        try {
            if (adoptDir(oldDir, newDir, options)) moved.push(label);
        } catch (cause) {
            log(`[Kesami] could not move ${oldDir} to ${newDir}: ${cause.message}`);
        }
    };

    const userData = app.getPath('userData');
    const legacyUserData = path.join(app.getPath('appData'), ...LEGACY_USER_DATA);
    attempt('app data', legacyUserData, userData, { skipIfLocked: true });
    attempt('backend data', path.join(legacyUserData, LEGACY_BACKEND_DATA), path.join(userData, BACKEND_DATA));
    attempt('backend data', path.join(userData, LEGACY_BACKEND_DATA), path.join(userData, BACKEND_DATA));

    if (!env('LIBRARY_DIR', source)) {
        const documents = app.getPath('documents');
        attempt('meeting library', path.join(documents, LEGACY_LIBRARY), path.join(documents, LIBRARY));
    }

    for (const label of moved) log(`[Kesami] moved the ${label} from its old location`);
    return moved;
}

module.exports = { env, adoptLegacyLocations, LIBRARY };
