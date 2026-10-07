const { app, BrowserWindow, Menu, shell, nativeImage, nativeTheme, ipcMain } = require('electron');
const legacy = require('./legacy');
legacy.adoptLegacyLocations(app);
const recorder = require('./recorder');
const podcast = require('./podcast');
const widget = require('./widget');
const menubar = require('./menubar');
const systemAudio = require('./systemAudio');
const micUsage = require('./micUsage');
const googleSignIn = require('./googleSignIn');
const connection = require('./connection');
const updater = require('./updater');
const { showDockIcon } = require('./dock');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { secureWindow, isTrustedFrame, permissionAllowed, trustedIpc } = require('./rendererSecurity');

const BACKEND_HOST = process.env.CORE_BACKEND_HOST || '127.0.0.1';
const BACKEND_PORT = Number(process.env.CORE_BACKEND_PORT || 48900);

const HEALTH_TIMEOUT_MS = 800;
const BACKEND_START_TIMEOUT_MS = 90_000;
const BACKEND_WATCH_MS = 10_000;

// A packaged build carries the backend and UI in Resources, and keeps backend
// data in Application Support rather than beside a source checkout.
const CORE_BACKEND_DIR = app.isPackaged ? app.getPath('userData') : path.resolve(__dirname, '..', 'core-backend');
const CORE_BACKEND_FILE = process.platform === 'win32' ? 'kesami-core-backend.exe' : 'kesami-core-backend';
const CORE_BACKEND_BINARY = app.isPackaged
    ? path.join(process.resourcesPath, CORE_BACKEND_FILE)
    : path.join(CORE_BACKEND_DIR, 'target', 'release', CORE_BACKEND_FILE);
const UI_DIST_DIR = app.isPackaged ? path.join(process.resourcesPath, 'ui') : path.resolve(__dirname, '..', 'ui', 'dist');
const UI_DIST_INDEX = path.join(UI_DIST_DIR, 'index.html');
const UI_DIST_WIDGET = path.join(UI_DIST_DIR, 'widget.html');
const DEV_UI_URL = process.env.MEETING_UI_URL || 'http://localhost:5173/';

function packagedAuthConfig() {
    if (!app.isPackaged) return null;
    try {
        const config = JSON.parse(fs.readFileSync(path.join(process.resourcesPath, 'auth-config.json'), 'utf8'));
        const url = new URL(config.url);
        if (config.provider !== 'supabase' || url.protocol !== 'https:' || url.username || url.password
            || url.pathname !== '/' || url.search || url.hash || !config.publishableKey?.startsWith('sb_publishable_')) {
            throw new Error('invalid public auth settings');
        }
        if (config.cloudUrl) {
            const cloud = new URL(config.cloudUrl);
            if (cloud.protocol !== 'https:' || cloud.username || cloud.password || cloud.pathname !== '/'
                || cloud.search || cloud.hash) throw new Error('invalid cloud service address');
        }
        return config;
    } catch (cause) {
        console.error(`[Kesami] bundled Google sign-in settings unavailable: ${cause.message}`);
        return null;
    }
}

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
                    `kesami-core-backend process on that port), then relaunch.`
            );
        }
        console.log(`[Kesami] reusing the core backend already on :${BACKEND_PORT}`);
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
        KESAMI_RECORDINGS_DIR: recorder.LIBRARY_ROOT,
        KESAMI_LIBRARY_DIR: recorder.LIBRARY_ROOT,
        // Podcast media follows the same trust model as recordings: renderer
        // requests carry project ids, while the backend receives one fixed root.
        KESAMI_PODCASTS_DIR: podcast.PODCASTS_ROOT,
        KESAMI_FFMPEG_PATH: podcast.mediaTool('ffmpeg'),
    };

    const auth = packagedAuthConfig();
    if (auth) {
        if (!env.KESAMI_AUTH_PROVIDER && !env.ALPHA_AUTH_PROVIDER) env.KESAMI_AUTH_PROVIDER = auth.provider;
        if (!env.KESAMI_SUPABASE_URL && !env.ALPHA_SUPABASE_URL) env.KESAMI_SUPABASE_URL = auth.url;
        if (!env.KESAMI_SUPABASE_PUBLISHABLE_KEY && !env.ALPHA_SUPABASE_PUBLISHABLE_KEY) {
            env.KESAMI_SUPABASE_PUBLISHABLE_KEY = auth.publishableKey;
        }
        if (auth.cloudUrl && !env.KESAMI_CLOUD_URL && !env.ALPHA_CLOUD_URL) env.KESAMI_CLOUD_URL = auth.cloudUrl;
    }

    const options = { cwd: CORE_BACKEND_DIR, env, stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true };
    if (fs.existsSync(CORE_BACKEND_BINARY)) {
        backendProcess = spawn(CORE_BACKEND_BINARY, [], options);
    } else {
        if (app.isPackaged) throw new Error('the packaged core backend is missing; reinstall Kesami');
        console.log('[Kesami] release binary not found, falling back to cargo run');
        backendProcess = spawn('cargo', ['run', '--release'], options);
    }

    let launchError = null;
    backendProcess.once('error', cause => {
        launchError = cause;
        backendProcess = null;
    });
    backendProcess.on('exit', code => {
        if (code !== 0 && code !== null) console.error(`[Kesami] core backend exited with code ${code}`);
        backendProcess = null;
    });

    const deadline = Date.now() + BACKEND_START_TIMEOUT_MS;
    while (Date.now() < deadline) {
        const status = await health();
        if (status) return status;
        if (!backendProcess) break;
        await wait(400);
    }

    throw new Error(launchError ? `the core backend could not start: ${launchError.message}` : `the core backend did not answer on :${BACKEND_PORT}`);
}

let backendStarting = null;
let backendWatch = null;

function watchBackend() {
    if (backendWatch) return;
    backendWatch = setInterval(async () => {
        if (backendProcess || backendStarting) return;
        if (await health()) return;
        console.log(`[Kesami] no core backend on :${BACKEND_PORT}; starting one`);
        backendStarting = startBackend()
            .then(status => {
                console.log(`[Kesami] core backend ${status.version} ready on :${BACKEND_PORT}`);
                void menubar.refresh();
            })
            .catch(cause => console.error(`[Kesami] ${cause.message}`))
            .finally(() => {
                backendStarting = null;
            });
    }, BACKEND_WATCH_MS);
    backendWatch.unref?.();
}

function stopBackend() {
    clearInterval(backendWatch);
    backendWatch = null;
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
        ...(isMac
            ? [
                  {
                      role: 'appMenu',
                      submenu: [
                          { role: 'about' },
                          { label: 'Check for Updates…', click: () => updater.checkNow() },
                          { type: 'separator' },
                          { role: 'services' },
                          { type: 'separator' },
                          { role: 'hide' },
                          { role: 'hideOthers' },
                          { role: 'unhide' },
                          { type: 'separator' },
                          { role: 'quit' },
                      ],
                  },
              ]
            : []),
        {
            label: 'File',
            submenu: [
                {
                    label: 'Export Notes…',
                    accelerator: 'CmdOrCtrl+E',
                    click: () => mainWindow?.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'e', modifiers: ['cmd'] }),
                },
                { type: 'separator' },
                ...(isMac ? [] : [{ label: 'Check for Updates…', click: () => updater.checkNow() }, { type: 'separator' }]),
                isMac ? { role: 'close' } : { role: 'quit' },
            ],
        },
        { role: 'editMenu' },
        {
            label: 'View',
            submenu: app.isPackaged
                ? [{ role: 'togglefullscreen' }]
                : [{ role: 'reload' }, { role: 'forceReload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'togglefullscreen' }],
        },
        { role: 'windowMenu' },
    ];

    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow() {
    const dark = nativeTheme.shouldUseDarkColors;
    const useDevServer = !app.isPackaged && (process.argv.includes('--dev') || !fs.existsSync(UI_DIST_INDEX));

    mainWindow = new BrowserWindow({
        width: 1280,
        height: 840,
        minWidth: 960,
        minHeight: 620,
        show: false,
        title: 'KESAMI',
        // The toolbar in the UI is a drag region, so the window keeps the traffic
        // lights but drops the title bar.
        ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 14, y: 18 } } : { autoHideMenuBar: true }),
        backgroundColor: dark ? '#1c1c1e' : '#f2f2f7',
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
        },
    });

    // The renderer needs the microphone, the screen once recording is on, and
    // notifications for the pre-meeting reminder; everything else stays denied.
    secureWindow(mainWindow, {
        url: useDevServer ? DEV_UI_URL : pathToFileURL(UI_DIST_INDEX).href,
        role: 'main',
        openExternal: url => shell.openExternal(url),
    });
    mainWindow.webContents.session.setPermissionRequestHandler((contents, permission, callback, details) => {
        callback(permissionAllowed(contents, permission, details));
    });
    mainWindow.webContents.session.setPermissionCheckHandler((contents, permission, requestingOrigin, details) =>
        permissionAllowed(contents, permission, { ...details, securityOrigin: requestingOrigin })
    );

    recorder.installDisplayMediaHandler(mainWindow.webContents.session, request => isTrustedFrame(mainWindow?.webContents, request.frame));

    mainWindow.once('ready-to-show', () => mainWindow.show());

    if (useDevServer) {
        console.log(`[Kesami] loading the dev server at ${DEV_UI_URL}`);
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
    const useDevServer = !app.isPackaged && (process.argv.includes('--dev') || !fs.existsSync(UI_DIST_WIDGET));
    widget.create({
        devUrl: useDevServer ? new URL('widget.html', DEV_UI_URL).href : null,
        distFile: UI_DIST_WIDGET,
        preload: path.join(__dirname, 'widgetPreload.js'),
        onActivateMain: showMainWindow,
        onCommand: (action, promptId) => {
            if (!mainWindow || mainWindow.isDestroyed()) return;
            mainWindow.webContents.send('shell:widget-command', action, promptId);
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
        showDockIcon({ app, nativeImage }).catch(cause => console.error(`[Kesami] could not apply the Dock icon: ${cause.message}`));
        buildMenu();
        recorder.serveMediaScheme();
        const ipc = trustedIpc(ipcMain);
        recorder.registerHandlers(ipc);
        widget.registerHandlers(ipc);
        menubar.registerHandlers(ipc);
        systemAudio.registerHandlers(ipc);
        micUsage.registerHandlers(ipc);
        googleSignIn.registerHandlers(ipc);
        connection.registerHandlers(ipc);

        menubar.create({
            onActivateMain: showMainWindow,
            getMainWindow: () => mainWindow,
            version: app.getVersion(),
        });

        try {
            const status = await startBackend();
            console.log(`[Kesami] core backend ${status.version} ready on :${BACKEND_PORT}`);
            // The tray was created before the backend answered; load today's meetings now it can.
            void menubar.refresh();
        } catch (cause) {
            // The window still opens: the UI reports the backend as offline and
            // offers a retry, which is more useful than refusing to launch.
            console.error(`[Kesami] ${cause.message}`);
        }
        watchBackend();

        createWindow();
        createWidget();
        updater.start({ getWindow: () => mainWindow });

        // Counting every window would include the floating widget, which is
        // always open — the dock icon would then never bring the app back.
        app.on('activate', () => {
            if (!mainWindow || mainWindow.isDestroyed()) createWindow();
        });
    });

    app.on('window-all-closed', () => {
        if (process.platform !== 'darwin') app.quit();
    });

    let quitting = false;
    let shutdownComplete = false;
    app.on('before-quit', event => {
        if (shutdownComplete) return;
        // Electron does not await an async event listener. Hold the first quit
        // until writes are closed, then allow the second quit to proceed.
        event.preventDefault();
        if (quitting) return;
        quitting = true;
        updater.stop();
        // Close the recording file before the backend goes away, so quitting
        // mid-meeting still leaves something playable on disk.
        widget.destroy();
        menubar.destroy();
        systemAudio.shutdown();
        micUsage.shutdown();
        recorder.shutdown().catch(cause => console.error(`[Kesami] could not finish recording: ${cause.message}`)).finally(() => {
            stopBackend();
            shutdownComplete = true;
            app.quit();
        });
    });
    process.on('exit', stopBackend);
}
