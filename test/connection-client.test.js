const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const MODULE_URL = pathToFileURL(path.join(__dirname, '..', 'apps', 'ui', 'src', 'lib', 'connection.js')).href;

async function withGlobals(values, run) {
    const previous = Object.fromEntries(Object.keys(values).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    for (const [key, value] of Object.entries(values)) {
        Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
    }
    try {
        await run();
    } finally {
        for (const [key, descriptor] of Object.entries(previous)) {
            if (descriptor) Object.defineProperty(globalThis, key, descriptor);
            else delete globalThis[key];
        }
    }
}

const storage = values => ({ getItem: key => values[key] ?? null, setItem() {}, removeItem() {} });

test('while the desktop shell is still reading the keychain, browser storage never stands in for it', async () => {
    const { getBackendConnection } = await import(MODULE_URL);
    await withGlobals(
        {
            kesamiConnection: { get: () => null, ready: () => new Promise(() => {}) },
            sessionStorage: storage({ 'kesami.backend.session-token': 'browser-token' }),
            localStorage: storage({}),
        },
        () => {
            assert.deepEqual(getBackendConnection(), { url: 'http://127.0.0.1:48900', token: '', remote: false });
        }
    );
});

test('a browser without the desktop shell keeps its session token in session storage', async () => {
    const { getBackendConnection } = await import(MODULE_URL);
    await withGlobals(
        {
            kesamiConnection: undefined,
            sessionStorage: storage({ 'kesami.backend.session-token': 'browser-token' }),
            localStorage: storage({}),
        },
        () => {
            assert.equal(getBackendConnection().token, 'browser-token');
        }
    );
});

test('restore waits for the desktop shell, and a missing or failed keychain read never blocks it', async () => {
    const { whenConnectionReady } = await import(MODULE_URL);
    let release;
    const order = [];
    await withGlobals(
        {
            kesamiConnection: {
                get: () => null,
                ready: () =>
                    new Promise(resolve => {
                        release = resolve;
                    }),
            },
        },
        async () => {
            const waiting = whenConnectionReady().then(() => order.push('ready'));
            await new Promise(resolve => setImmediate(resolve));
            assert.deepEqual(order, []);
            release({ url: 'http://127.0.0.1:48900', token: 'saved' });
            await waiting;
            assert.deepEqual(order, ['ready']);
        }
    );
    await withGlobals({ kesamiConnection: { get: () => null, ready: () => Promise.reject(new Error('keychain denied')) } }, async () => {
        assert.equal(await whenConnectionReady(), undefined);
    });
    await withGlobals({ kesamiConnection: { get: () => ({ url: '', token: '' }) } }, async () => {
        assert.equal(await whenConnectionReady(), undefined);
    });
    await withGlobals({ kesamiConnection: undefined }, async () => {
        assert.equal(await whenConnectionReady(), undefined);
    });
});
