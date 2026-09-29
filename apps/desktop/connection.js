const fsp = require('node:fs/promises');
const fs = require('node:fs');
const path = require('node:path');
const { app, ipcMain, safeStorage } = require('electron');

let current = null;

const connectionFile = () => path.join(app.getPath('userData'), 'connection.bin');

function normalize(value) {
    return { url: String(value?.url || ''), token: String(value?.token || '') };
}

function load() {
    if (current) return current;
    current = normalize();
    try {
        if (safeStorage.isEncryptionAvailable()) current = normalize(JSON.parse(safeStorage.decryptString(fs.readFileSync(connectionFile()))));
    } catch {
        /* empty */
    }
    return current;
}

async function save(value) {
    const next = normalize(value);
    if (safeStorage.isEncryptionAvailable()) {
        await fsp.mkdir(path.dirname(connectionFile()), { recursive: true });
        await fsp.writeFile(connectionFile(), safeStorage.encryptString(JSON.stringify(next)), { mode: 0o600 });
    } else {
        await fsp.rm(connectionFile(), { force: true });
    }
    current = next;
    return current;
}

function registerHandlers() {
    ipcMain.on('connection:get', event => {
        event.returnValue = load();
    });
    ipcMain.handle('connection:save', (_event, value) => save(value));
}

module.exports = { registerHandlers };
