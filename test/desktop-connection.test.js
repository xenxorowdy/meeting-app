const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const CONNECTION = require.resolve('../apps/desktop/connection');
const SEAL = 'sealed:';

function sealed(value) {
    return Buffer.from(`${SEAL}${JSON.stringify(value)}`);
}

function keychain(overrides = {}) {
    const calls = { decrypt: 0, encrypt: 0 };
    const safeStorage = {
        decryptString: () => assert.fail('the keychain is never read synchronously'),
        encryptString: () => assert.fail('the keychain is never written synchronously'),
        isEncryptionAvailable: () => assert.fail('keychain availability is never checked synchronously'),
        isAsyncEncryptionAvailable: async () => true,
        encryptStringAsync: async text => {
            calls.encrypt += 1;
            return Buffer.from(`${SEAL}${text}`);
        },
        decryptStringAsync: async data => {
            calls.decrypt += 1;
            return { result: data.toString().slice(SEAL.length), shouldReEncrypt: false };
        },
        ...overrides,
    };
    return { safeStorage, calls };
}

function loadConnection(t, safeStorage) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kesami-connection-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const handlers = new Map();
    const electron = {
        app: {
            getPath: name => {
                assert.equal(name, 'userData');
                return dir;
            },
        },
        ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
        safeStorage,
    };
    const originalLoad = Module._load;
    Module._load = function load(request, ...rest) {
        return request === 'electron' ? electron : originalLoad.call(this, request, ...rest);
    };
    let connection;
    try {
        delete require.cache[CONNECTION];
        connection = require(CONNECTION);
    } finally {
        Module._load = originalLoad;
    }
    connection.registerHandlers();
    const file = path.join(dir, 'connection.bin');
    return {
        connection,
        file,
        get: () => handlers.get('connection:get')({}),
        save: value => handlers.get('connection:save')({}, value),
    };
}

async function waitFor(condition) {
    for (let turn = 0; turn < 200 && !condition(); turn += 1) await new Promise(resolve => setTimeout(resolve, 5));
    assert.ok(condition());
}

function deferred() {
    let resolve;
    const promise = new Promise(yes => {
        resolve = yes;
    });
    return { promise, resolve };
}

test('the saved connection is read without blocking on the keychain', async t => {
    const { safeStorage } = keychain();
    const store = loadConnection(t, safeStorage);
    fs.writeFileSync(store.file, sealed({ url: 'http://127.0.0.1:48900', token: 'saved-session' }));

    assert.deepEqual(await store.get(), { url: 'http://127.0.0.1:48900', token: 'saved-session' });
});

test('startup and the window share one keychain read', async t => {
    const answer = deferred();
    const { safeStorage, calls } = keychain({
        decryptStringAsync: async () => {
            calls.decrypt += 1;
            await answer.promise;
            return { result: JSON.stringify({ url: 'http://127.0.0.1:48900', token: 'shared' }), shouldReEncrypt: false };
        },
    });
    const store = loadConnection(t, safeStorage);
    fs.writeFileSync(store.file, sealed({ url: 'http://127.0.0.1:48900', token: 'shared' }));

    const startup = store.connection.load();
    const window = store.get();
    await waitFor(() => calls.decrypt === 1);

    answer.resolve();
    assert.deepEqual(await startup, { url: 'http://127.0.0.1:48900', token: 'shared' });
    assert.deepEqual(await window, { url: 'http://127.0.0.1:48900', token: 'shared' });
    assert.deepEqual(await store.get(), { url: 'http://127.0.0.1:48900', token: 'shared' });
    assert.equal(calls.decrypt, 1);
});

test('a connection sealed with a retired key is sealed again with the current one', async t => {
    const { safeStorage } = keychain({
        decryptStringAsync: async () => ({ result: JSON.stringify({ url: 'http://127.0.0.1:48900', token: 'kept' }), shouldReEncrypt: true }),
    });
    const store = loadConnection(t, safeStorage);
    fs.writeFileSync(store.file, Buffer.from('retired-key-ciphertext'));

    assert.deepEqual(await store.get(), { url: 'http://127.0.0.1:48900', token: 'kept' });
    assert.equal(fs.readFileSync(store.file, 'utf8'), `${SEAL}${JSON.stringify({ url: 'http://127.0.0.1:48900', token: 'kept' })}`);
});

test('no saved file reads as signed out without touching the keychain', async t => {
    const { safeStorage, calls } = keychain();
    const store = loadConnection(t, safeStorage);

    assert.deepEqual(await store.get(), { url: '', token: '' });
    assert.equal(calls.decrypt, 0);
});

test('a connection the keychain will not open reads as signed out', async t => {
    const { safeStorage } = keychain({
        decryptStringAsync: async () => {
            throw new Error('safeStorage.decryptStringAsync is temporarily unavailable. Please try again.');
        },
    });
    const store = loadConnection(t, safeStorage);
    fs.writeFileSync(store.file, sealed({ url: 'http://127.0.0.1:48900', token: 'locked' }));

    assert.deepEqual(await store.get(), { url: '', token: '' });
});

test('a sign-in saved while the keychain is still answering is what the app keeps', async t => {
    const answer = deferred();
    const { safeStorage, calls } = keychain({
        decryptStringAsync: async () => {
            calls.decrypt += 1;
            await answer.promise;
            return { result: JSON.stringify({ url: 'http://127.0.0.1:48900', token: 'stale' }), shouldReEncrypt: true };
        },
    });
    const store = loadConnection(t, safeStorage);
    fs.writeFileSync(store.file, sealed({ url: 'http://127.0.0.1:48900', token: 'stale' }));

    const reading = store.get();
    await waitFor(() => calls.decrypt === 1);
    assert.deepEqual(await store.save({ url: 'http://127.0.0.1:48900', token: 'fresh' }), { url: 'http://127.0.0.1:48900', token: 'fresh' });
    answer.resolve();

    assert.deepEqual(await reading, { url: 'http://127.0.0.1:48900', token: 'fresh' });
    assert.equal(fs.readFileSync(store.file, 'utf8'), `${SEAL}${JSON.stringify({ url: 'http://127.0.0.1:48900', token: 'fresh' })}`);
});

test('without keychain encryption a sign-in is kept in memory and never written in the clear', async t => {
    const { safeStorage, calls } = keychain({ isAsyncEncryptionAvailable: async () => false });
    const store = loadConnection(t, safeStorage);
    fs.writeFileSync(store.file, sealed({ url: 'http://127.0.0.1:48900', token: 'old' }));

    assert.deepEqual(await store.save({ url: 'http://127.0.0.1:48900', token: 'memory-only' }), {
        url: 'http://127.0.0.1:48900',
        token: 'memory-only',
    });
    assert.equal(fs.existsSync(store.file), false);
    assert.deepEqual(await store.get(), { url: 'http://127.0.0.1:48900', token: 'memory-only' });
    assert.equal(calls.encrypt, 0);
});
