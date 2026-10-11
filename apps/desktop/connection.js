const fsp = require('node:fs/promises');
const path = require('node:path');
const { app, ipcMain, safeStorage } = require('electron');

let current = null;
let loading = null;
let replaced = false;

const connectionFile = () => path.join(app.getPath('userData'), 'connection.bin');

function normalize(value) {
    return { url: String(value?.url || ''), token: String(value?.token || '') };
}

async function write(value) {
    if (await safeStorage.isAsyncEncryptionAvailable()) {
        await fsp.mkdir(path.dirname(connectionFile()), { recursive: true });
        await fsp.writeFile(connectionFile(), await safeStorage.encryptStringAsync(JSON.stringify(value)), { mode: 0o600 });
    } else {
        await fsp.rm(connectionFile(), { force: true });
    }
}

async function read() {
    let encrypted;
    try {
        encrypted = await fsp.readFile(connectionFile());
    } catch {
        return normalize();
    }
    try {
        const { result, shouldReEncrypt } = await safeStorage.decryptStringAsync(encrypted);
        const value = normalize(JSON.parse(result));
        if (shouldReEncrypt && !replaced) await write(value).catch(() => {});
        return value;
    } catch {
        return normalize();
    }
}

function load() {
    if (current) return Promise.resolve(current);
    loading ??= read().then(value => {
        current ??= value;
        return current;
    });
    return loading;
}

async function save(value) {
    const next = normalize(value);
    replaced = true;
    await write(next);
    current = next;
    return current;
}

function registerHandlers(ipc = ipcMain) {
    ipc.handle('connection:get', () => load());
    ipc.handle('connection:save', (_event, value) => save(value));
}

module.exports = { registerHandlers, load };
