const { BrowserWindow, ipcMain, screen } = require('electron');
const path = require('node:path');

const COLLAPSED = { width: 268, height: 48 };
const EXPANDED = { width: 396, height: 496 };
const SCREEN_MARGIN = 20;
const COMMANDS = new Set(['toggle-mic', 'toggle-system', 'toggle-pause', 'stop']);

let widgetWindow = null;
let expanded = false;
let hiddenByUser = false;
let enabled = true;
let live = false;
let activateMain = null;
let runCommand = null;
let lastState = null;

const alive = () => Boolean(widgetWindow) && !widgetWindow.isDestroyed();
const fromWidget = event => alive() && event.sender === widgetWindow.webContents;

// Resizing keeps the bottom-right corner pinned, so the panel grows up and to
// the left instead of walking off the edge of the display it was parked on. The
// clamp is what stops a widget dragged near an edge from expanding off-screen,
// where it would be unreachable — the window is not resizable by hand.
function cornerBounds(bounds, work, { width, height }) {
    const right = bounds.x + bounds.width;
    const bottom = bounds.y + bounds.height;
    const clamp = (value, min, max) => Math.min(Math.max(value, min), Math.max(min, max));
    return {
        x: clamp(right - width, work.x + SCREEN_MARGIN, work.x + work.width - width - SCREEN_MARGIN),
        y: clamp(bottom - height, work.y + SCREEN_MARGIN, work.y + work.height - height - SCREEN_MARGIN),
        width,
        height,
    };
}

function resizeKeepingCorner(size) {
    if (!alive()) return;
    const bounds = widgetWindow.getBounds();
    widgetWindow.setBounds(cornerBounds(bounds, screen.getDisplayMatching(bounds).workArea, size));
}

function applyVisibility() {
    if (!alive()) return;
    if (enabled && live && !hiddenByUser) {
        // showInactive, not show: an indicator that steals focus from the call
        // you are in is worse than no indicator.
        widgetWindow.showInactive();
    } else {
        widgetWindow.hide();
    }
}

function sendState() {
    if (!alive() || !lastState) return;
    widgetWindow.webContents.send('widget:state', lastState);
}

function create({ devUrl, distFile, preload, onActivateMain, onCommand }) {
    if (alive()) return widgetWindow;
    activateMain = onActivateMain;
    runCommand = onCommand;

    const work = screen.getPrimaryDisplay().workArea;
    widgetWindow = new BrowserWindow({
        width: COLLAPSED.width,
        height: COLLAPSED.height,
        x: work.x + work.width - COLLAPSED.width - SCREEN_MARGIN,
        y: work.y + work.height - COLLAPSED.height - SCREEN_MARGIN,
        show: false,
        frame: false,
        transparent: true,
        hasShadow: true,
        resizable: false,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        skipTaskbar: true,
        title: 'KESAMI Status',
        webPreferences: {
            preload,
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false,
        },
    });

    // A meeting is usually a full-screen call, often on another Space. An
    // indicator that disappears there is missing exactly when it is needed.
    widgetWindow.setAlwaysOnTop(true, 'floating');
    widgetWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

    widgetWindow.on('closed', () => {
        widgetWindow = null;
        expanded = false;
        lastState = null;
    });

    widgetWindow.once('ready-to-show', () => {
        applyVisibility();
        sendState();
    });

    if (devUrl) {
        widgetWindow.loadURL(devUrl);
    } else {
        widgetWindow.loadFile(distFile);
    }

    return widgetWindow;
}

function registerHandlers() {
    ipcMain.handle('widget:set-expanded', (event, next) => {
        if (!fromWidget(event)) return false;
        expanded = Boolean(next);
        resizeKeepingCorner(expanded ? EXPANDED : COLLAPSED);
        return expanded;
    });

    ipcMain.handle('widget:open-main', event => {
        if (!fromWidget(event)) return false;
        activateMain?.();
        return true;
    });

    ipcMain.handle('widget:hide', event => {
        if (!fromWidget(event)) return false;
        hiddenByUser = true;
        applyVisibility();
        return true;
    });

    ipcMain.handle('widget:command', (event, action) => {
        if (!fromWidget(event)) return false;
        if (!COMMANDS.has(action)) return false;
        runCommand?.(action);
        return true;
    });

    // Sent by the main window when the preference changes. Re-enabling clears the
    // per-session dismissal, otherwise the toggle would look broken to anyone who
    // had closed the widget earlier.
    ipcMain.handle('widget:set-visible', (_event, next) => {
        const wanted = next !== false;
        if (wanted && !enabled) hiddenByUser = false;
        enabled = wanted;
        applyVisibility();
        return enabled;
    });

    ipcMain.handle('widget:set-live', (_event, next) => {
        live = Boolean(next);
        applyVisibility();
        return live;
    });

    ipcMain.handle('widget:set-state', (_event, state) => {
        lastState = state ?? null;
        sendState();
        return true;
    });
}

function setLive(next) {
    live = Boolean(next);
    applyVisibility();
}

function destroy() {
    if (!alive()) return;
    widgetWindow.destroy();
    widgetWindow = null;
}

// ── Public API ──

module.exports = {
    create,
    registerHandlers,
    setLive,
    destroy,
    isOpen: alive,
    _testing: { COLLAPSED, EXPANDED, SCREEN_MARGIN, cornerBounds },
};
