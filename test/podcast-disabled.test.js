const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

const DESKTOP_DIR = path.resolve(__dirname, '../apps/desktop');

function runDesktopFile(name, mocks, globals = {}) {
    const filename = path.join(DESKTOP_DIR, name);
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
        __dirname: DESKTOP_DIR,
        require: request => {
            assert.ok(Object.hasOwn(mocks, request), `Unexpected dependency: ${request}`);
            return mocks[request];
        },
        ...globals,
    }, { filename });
}

test('preload keeps meeting recording available without exposing the podcast bridge', async () => {
    const bridges = new Map();
    const subscriptions = new Map();
    const invocations = [];
    runDesktopFile('preload.js', {
        electron: {
            contextBridge: { exposeInMainWorld: (name, bridge) => bridges.set(name, bridge) },
            ipcRenderer: {
                on: (name, listener) => subscriptions.set(name, listener),
                removeListener: name => subscriptions.delete(name),
                invoke: async (...args) => { invocations.push(args); return { available: true }; },
                sendSync: () => ({ url: '', token: '' }),
            },
        },
    });

    assert.equal(bridges.has('kesamiPodcast'), false);
    assert.ok(bridges.has('kesamiRecorder'));
    assert.ok(bridges.has('kesamiSystemAudio'));
    assert.ok(bridges.has('kesamiShell'));
    assert.equal([...subscriptions.keys()].some(channel => channel.startsWith('podcast:')), false);

    // Verify that disabling podcast does not also cut off meeting capture.
    const options = { meetingId: 'meeting-one' };
    await bridges.get('kesamiRecorder').start(options);
    await bridges.get('kesamiSystemAudio').available();
    assert.deepEqual(invocations, [['recorder:start', options], ['system-audio:available']]);
});

test('preload restores the saved backend connection and keeps saves in step', async () => {
    const bridges = new Map();
    const saved = [];
    runDesktopFile('preload.js', {
        electron: {
            contextBridge: { exposeInMainWorld: (name, bridge) => bridges.set(name, bridge) },
            ipcRenderer: {
                on() {},
                removeListener() {},
                sendSync: channel => (channel === 'connection:get' ? { url: 'http://127.0.0.1:48900', token: 'restored' } : assert.fail(channel)),
                invoke: async (channel, value) => {
                    saved.push([channel, value]);
                    return value;
                },
            },
        },
    });

    const connection = bridges.get('kesamiConnection');
    assert.deepEqual(connection.get(), { url: 'http://127.0.0.1:48900', token: 'restored' });
    await connection.save({ url: 'http://127.0.0.1:48900', token: '' });
    assert.deepEqual(saved, [['connection:save', { url: 'http://127.0.0.1:48900', token: '' }]]);
    assert.deepEqual(connection.get(), { url: 'http://127.0.0.1:48900', token: '' });
});

test('desktop startup and shutdown do not register or activate podcast capabilities', async () => {
    const calls = [];
    const events = new Map();
    const errors = [];
    let ready;
    const recordCall = name => () => { calls.push(name); };
    const recorder = {
        LIBRARY_ROOT: '/test/recordings',
        registerMediaScheme: recordCall('recorder:register-scheme'),
        serveMediaScheme: recordCall('recorder:serve-scheme'),
        registerHandlers: recordCall('recorder:register-handlers'),
        installDisplayMediaHandler: recordCall('recorder:display-media'),
        shutdown: recordCall('recorder:shutdown'),
    };
    const podcast = {
        PODCASTS_ROOT: '/test/podcasts',
        mediaTool: () => '/test/ffmpeg',
        registerMediaScheme: recordCall('podcast:register-scheme'),
        serveMediaScheme: recordCall('podcast:serve-scheme'),
        registerHandlers: recordCall('podcast:register-handlers'),
        shutdown: recordCall('podcast:shutdown'),
    };
    class Window {
        constructor() {
            this.webContents = {
                session: { setPermissionRequestHandler() {} },
                setWindowOpenHandler() {},
            };
        }
        once() {}
        on() {}
        loadFile() { calls.push('window:load'); }
    }
    runDesktopFile('main.js', {
        electron: {
            app: {
                requestSingleInstanceLock: () => true,
                on: (name, listener) => events.set(name, listener),
                whenReady: () => ({ then: callback => { ready = Promise.resolve().then(callback); } }),
                getVersion: () => 'test',
            },
            BrowserWindow: Window,
            Menu: { buildFromTemplate: template => template, setApplicationMenu() {} },
            shell: {},
            nativeImage: {},
            nativeTheme: { shouldUseDarkColors: false },
        },
        './recorder': recorder,
        './podcast': podcast,
        './widget': { registerHandlers() {}, create() {}, destroy() {} },
        './menubar': { registerHandlers() {}, create() {}, destroy() {} },
        './systemAudio': { registerHandlers() {}, shutdown() {} },
        './dock': { showDockIcon: async () => {} },
        './connection': { registerHandlers: recordCall('connection:register-handlers') },
        'node:child_process': { spawn: () => assert.fail('The healthy existing backend should be reused') },
        'node:fs': { existsSync: () => true },
        'node:path': path,
        'node:http': {
            get: (_options, callback) => {
                const request = new EventEmitter();
                queueMicrotask(() => {
                    const response = new EventEmitter();
                    response.statusCode = 200;
                    response.setEncoding = () => {};
                    callback(response);
                    response.emit('data', JSON.stringify({ version: 'test', build: { executable: '/test/existing-backend' } }));
                    response.emit('end');
                });
                return request;
            },
        },
    }, {
        process: { env: {}, argv: [], platform: 'linux', on() {} },
        console: { log() {}, error: message => errors.push(message) },
        setTimeout,
        URL,
    });
    await ready;
    await events.get('before-quit')();

    assert.deepEqual(errors, []);
    assert.ok(calls.includes('window:load'));
    assert.ok(calls.includes('recorder:register-scheme'));
    assert.ok(calls.includes('recorder:serve-scheme'));
    assert.ok(calls.includes('recorder:register-handlers'));
    assert.ok(calls.includes('recorder:display-media'));
    assert.ok(calls.includes('recorder:shutdown'));
    assert.deepEqual(calls.filter(name => name.startsWith('podcast:')), []);
});
