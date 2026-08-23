const { app, BrowserWindow, Menu, shell, nativeTheme } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const BACKEND_HOST = process.env.CORE_BACKEND_HOST || '127.0.0.1';
const BACKEND_PORT = Number(process.env.CORE_BACKEND_PORT || 48900);
// large-v3 is the only cached model that transcribes Hindi in Devanagari rather
// than romanising it or falling back to Urdu script; it costs ~30s to load once.
const STT_MODEL = process.env.CORE_BACKEND_STT_MODEL || 'large-v3-v20240930';
const STT_LANGUAGE = process.env.CORE_BACKEND_STT_LANGUAGE || 'auto';

const HEALTH_TIMEOUT_MS = 800;
const BACKEND_START_TIMEOUT_MS = 90_000;

const CORE_BACKEND_DIR = path.resolve(__dirname, '..', 'core-backend');
const CORE_BACKEND_BINARY = path.join(CORE_BACKEND_DIR, 'target', 'release', 'alpha-core-backend');
const UI_DIST_INDEX = path.resolve(__dirname, '..', 'ui', 'dist', 'index.html');
const DEV_UI_URL = process.env.MEETING_UI_URL || 'http://localhost:5173/';

let backendProcess = null;
let mainWindow = null;

function health() {
    return new Promise(resolve => {
        const request = http.get({ host: BACKEND_HOST, port: BACKEND_PORT, path: '/health', timeout: HEALTH_TIMEOUT_MS }, response => {
            let body = '';
            response.setEncoding('utf8');
            response.on('data', chunk => (body += chunk));
            response.on('end', () => {
                try {
                    const payload = JSON.parse(body);
                    resolve(response.statusCode === 200 ? payload : null);
                } catch {
                    resolve(null);
                }
            });
        });
        request.on('timeout', () => request.destroy());
        request.on('error', () => resolve(null));
    });
}

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function startBackend() {
    // A backend someone already started (a terminal, another window) is reused
    // rather than fighting over the port.
    const existing = await health();
    if (existing) {
        console.log(`[Alpha] reusing the core backend already on :${BACKEND_PORT}`);
        return existing;
    }

    const env = {
        ...process.env,
        CORE_BACKEND_PORT: String(BACKEND_PORT),
        CORE_BACKEND_STT_MODEL: STT_MODEL,
        CORE_BACKEND_STT_LANGUAGE: STT_LANGUAGE,
    };

    if (fs.existsSync(CORE_BACKEND_BINARY)) {
        backendProcess = spawn(CORE_BACKEND_BINARY, [], { cwd: CORE_BACKEND_DIR, env, stdio: ['ignore', 'inherit', 'inherit'] });
    } else {
        console.log('[Alpha] release binary not found, falling back to cargo run');
        backendProcess = spawn('cargo', ['run', '--release'], { cwd: CORE_BACKEND_DIR, env, stdio: ['ignore', 'inherit', 'inherit'] });
    }

    backendProcess.on('exit', code => {
        if (code !== 0 && code !== null) console.error(`[Alpha] core backend exited with code ${code}`);
        backendProcess = null;
    });

    const deadline = Date.now() + BACKEND_START_TIMEOUT_MS;
    while (Date.now() < deadline) {
        const status = await health();
        if (status) return status;
        if (!backendProcess) break;
        await wait(400);
    }

    throw new Error(`the core backend did not answer on :${BACKEND_PORT}`);
}

function stopBackend() {
    if (!backendProcess) return;
    backendProcess.removeAllListeners('exit');
    backendProcess.kill('SIGTERM');
    backendProcess = null;
}

function buildMenu() {
    const isMac = process.platform === 'darwin';

    // Without an explicit menu macOS loses Cut/Copy/Paste and the standard
    // window shortcuts, which a text-heavy app cannot do without.
    const template = [
        ...(isMac ? [{ role: 'appMenu' }] : []),
        {
            label: 'File',
            submenu: [
                {
                    label: 'Export Notes…',
                    accelerator: 'CmdOrCtrl+E',
                    click: () => mainWindow?.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'e', modifiers: ['cmd'] }),
                },
                { type: 'separator' },
                isMac ? { role: 'close' } : { role: 'quit' },
            ],
        },
        { role: 'editMenu' },
        {
            label: 'View',
            submenu: [{ role: 'reload' }, { role: 'forceReload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'togglefullscreen' }],
        },
        { role: 'windowMenu' },
    ];

    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow() {
    const dark = nativeTheme.shouldUseDarkColors;

    mainWindow = new BrowserWindow({
        width: 1280,
        height: 840,
        minWidth: 960,
        minHeight: 620,
        show: false,
        title: 'Alpha Meeting Assistant',
        // The toolbar in the UI is a drag region, so the window keeps the traffic
        // lights but drops the title bar.
        titleBarStyle: 'hiddenInset',
        trafficLightPosition: { x: 14, y: 18 },
        backgroundColor: dark ? '#1c1c1e' : '#f2f2f7',
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false,
        },
    });

    // The renderer needs the microphone; everything else stays denied.
    mainWindow.webContents.session.setPermissionRequestHandler((_webContents, permission, callback) => {
        callback(permission === 'media' || permission === 'audioCapture');
    });

    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
        shell.openExternal(url);
        return { action: 'deny' };
    });

    mainWindow.once('ready-to-show', () => mainWindow.show());

    const useDevServer = process.argv.includes('--dev') || !fs.existsSync(UI_DIST_INDEX);
    if (useDevServer) {
        console.log(`[Alpha] loading the dev server at ${DEV_UI_URL}`);
        mainWindow.loadURL(DEV_UI_URL);
    } else {
        mainWindow.loadFile(UI_DIST_INDEX);
    }

    mainWindow.on('closed', () => {
        mainWindow = null;
    });
}

if (!app.requestSingleInstanceLock()) {
    app.quit();
} else {
    app.on('second-instance', () => {
        if (mainWindow) {
            if (mainWindow.isMinimized()) mainWindow.restore();
            mainWindow.focus();
        }
    });

    app.whenReady().then(async () => {
        buildMenu();

        try {
            const status = await startBackend();
            console.log(`[Alpha] core backend ${status.version} ready · transcription: ${status.stt?.engine} (${status.stt?.model})`);
        } catch (cause) {
            // The window still opens: the UI reports the backend as offline and
            // offers a retry, which is more useful than refusing to launch.
            console.error(`[Alpha] ${cause.message}`);
        }

        createWindow();

        app.on('activate', () => {
            if (BrowserWindow.getAllWindows().length === 0) createWindow();
        });
    });

    app.on('window-all-closed', () => {
        if (process.platform !== 'darwin') app.quit();
    });

    app.on('before-quit', stopBackend);
    process.on('exit', stopBackend);
}
