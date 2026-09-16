const { app, BrowserWindow, Menu, shell, nativeImage, nativeTheme } = require('electron');
const recorder = require('./recorder');
const podcast = require('./podcast');
const widget = require('./widget');
const menubar = require('./menubar');
const systemAudio = require('./systemAudio');
const micUsage = require('./micUsage');
const { showDockIcon } = require('./dock');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const BACKEND_HOST = process.env.CORE_BACKEND_HOST || '127.0.0.1';
const BACKEND_PORT = Number(process.env.CORE_BACKEND_PORT || 48900);

const HEALTH_TIMEOUT_MS = 800;
const BACKEND_START_TIMEOUT_MS = 90_000;

const CORE_BACKEND_DIR = path.resolve(__dirname, '..', 'core-backend');
const CORE_BACKEND_BINARY = path.join(CORE_BACKEND_DIR, 'target', 'release', 'alpha-core-backend');
const UI_DIST_INDEX = path.resolve(__dirname, '..', 'ui', 'dist', 'index.html');
const UI_DIST_WIDGET = path.resolve(__dirname, '..', 'ui', 'dist', 'widget.html');
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

function isCurrentBuild(status) {
    const running = status?.build;
    if (!running) return false;
    if (!running.executable || running.executable !== CORE_BACKEND_BINARY) return true;
    const onDisk = fs.statSync(CORE_BACKEND_BINARY, { throwIfNoEntry: false })?.mtimeMs;
    if (onDisk === undefined || typeof running.modifiedMs !== 'number') return true;
    return Math.abs(Math.floor(onDisk) - running.modifiedMs) <= 1;
}

async function startBackend() {
    // A backend someone already started (a terminal, another window) is reused
    // rather than fighting over the port.
    const existing = await health();
    if (existing) {
        if (!isCurrentBuild(existing)) {
            throw new Error(
                `a core backend from an earlier build is holding :${BACKEND_PORT}. Quit the app instance that started it (or kill the ` +
                    `alpha-core-backend process on that port), then relaunch.`
            );
        }
        console.log(`[Alpha] reusing the core backend already on :${BACKEND_PORT}`);
        return existing;
    }

    const env = {
        ...process.env,
        CORE_BACKEND_PORT: String(BACKEND_PORT),
        // The backend receives only relative recording paths. This trusted root
        // lets it resolve a completed recording for Sarvam batch STT without
        // accepting arbitrary local file paths from HTTP clients. It is also where
        // the backend writes one folder per meeting, so both values are the same
        // directory by design — the backend only moves a finished recording into a
        // meeting folder when they match.
        ALPHA_RECORDINGS_DIR: recorder.LIBRARY_ROOT,
        ALPHA_LIBRARY_DIR: recorder.LIBRARY_ROOT,
        // Podcast media follows the same trust model as recordings: renderer
        // requests carry project ids, while the backend receives one fixed root.
        ALPHA_PODCASTS_DIR: podcast.PODCASTS_ROOT,
        ALPHA_FFMPEG_PATH: podcast.mediaTool('ffmpeg'),
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
        title: 'KESAMI',
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

    // The renderer needs the microphone, the screen once recording is on, and
    // notifications for the pre-meeting reminder; everything else stays denied.
    mainWindow.webContents.session.setPermissionRequestHandler((_webContents, permission, callback) => {
        callback(permission === 'media' || permission === 'audioCapture' || permission === 'display-capture' || permission === 'notifications');
    });

    recorder.installDisplayMediaHandler(mainWindow.webContents.session);

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
        widget.setLive(false);
        // The widget is skipTaskbar and always-on-top, so on Windows and Linux it
        // would keep the app alive with no way back to it once the main window is
        // gone. macOS keeps running without windows by design, so it stays.
        if (process.platform !== 'darwin') widget.destroy();
    });
}

function showMainWindow() {
    if (!mainWindow || mainWindow.isDestroyed()) {
        createWindow();
        return;
    }
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
}

function createWidget() {
    const useDevServer = process.argv.includes('--dev') || !fs.existsSync(UI_DIST_WIDGET);
    widget.create({
        devUrl: useDevServer ? new URL('widget.html', DEV_UI_URL).href : null,
        distFile: UI_DIST_WIDGET,
        preload: path.join(__dirname, 'widgetPreload.js'),
        onActivateMain: showMainWindow,
        onCommand: action => {
            if (!mainWindow || mainWindow.isDestroyed()) return;
            mainWindow.webContents.send('shell:widget-command', action);
        },
    });
}

// Must run before `app.ready`: a scheme cannot be made privileged afterwards, and
// without that the player cannot stream or seek a recording.
recorder.registerMediaScheme();
// Podcast schemes and IPC are disabled; existing projects remain on disk.

if (!app.requestSingleInstanceLock()) {
    app.quit();
} else {
    app.on('second-instance', showMainWindow);

    app.whenReady().then(async () => {
        showDockIcon({ app, nativeImage }).catch(cause => console.error(`[Alpha] could not apply the Dock icon: ${cause.message}`));
        buildMenu();
        recorder.serveMediaScheme();
        recorder.registerHandlers();
        widget.registerHandlers();
        menubar.registerHandlers();
        systemAudio.registerHandlers();
        micUsage.registerHandlers();

        menubar.create({
            onActivateMain: showMainWindow,
            getMainWindow: () => mainWindow,
            version: app.getVersion(),
        });

        try {
            const status = await startBackend();
            console.log(`[Alpha] core backend ${status.version} ready on :${BACKEND_PORT}`);
        } catch (cause) {
            // The window still opens: the UI reports the backend as offline and
            // offers a retry, which is more useful than refusing to launch.
            console.error(`[Alpha] ${cause.message}`);
        }

        createWindow();
        createWidget();

        // Counting every window would include the floating widget, which is
        // always open — the dock icon would then never bring the app back.
        app.on('activate', () => {
            if (!mainWindow || mainWindow.isDestroyed()) createWindow();
        });
    });

    app.on('window-all-closed', () => {
        if (process.platform !== 'darwin') app.quit();
    });

    app.on('before-quit', async () => {
        // Close the recording file before the backend goes away, so quitting
        // mid-meeting still leaves something playable on disk.
        widget.destroy();
        menubar.destroy();
        systemAudio.shutdown();
        micUsage.shutdown();
        await recorder.shutdown();
        stopBackend();
    });
    process.on('exit', stopBackend);
}
