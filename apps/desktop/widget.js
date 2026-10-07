const { BrowserWindow, ipcMain, screen } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { secureWindow } = require('./rendererSecurity');

// The collapsed window is exactly the pill: no transparent margin. macOS draws the window shadow from
// the content's alpha, so a CSS shadow inside a padded window was clipped at the window edge and read
// as a second outline, and a transparent margin would still swallow clicks meant for the app beneath.
const COLLAPSED = { width: 288, height: 52 };
const EXPANDED = { width: 460, height: 500 };
// Six pixels around the card leave room for its small wobble without clipping.
const PROMPT = { width: 212, height: 252 };
const SCREEN_MARGIN = 20;
const COMMANDS = new Set(['toggle-mic', 'toggle-system', 'toggle-pause', 'stop']);
const PROMPT_COMMANDS = new Set(['start-call', 'dismiss-call']);

let widgetWindow = null;
let expanded = false;
let hiddenByUser = false;
let enabled = true;
let live = false;
let activateMain = null;
let runCommand = null;
let lastState = null;
let shadowTimer = null;
let promptTimer = null;

const alive = () => Boolean(widgetWindow) && !widgetWindow.isDestroyed();
const fromWidget = event => alive() && event.sender === widgetWindow.webContents;
const hasPrompt = () => Boolean(lastState?.callPrompt?.id) && ['idle', 'completed', 'error'].includes(lastState?.sessionState);
const windowSize = () => hasPrompt() ? PROMPT : expanded ? EXPANDED : COLLAPSED;

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
    const work = screen.getDisplayMatching(bounds).workArea;
    const fitted = {
        width: Math.min(size.width, Math.max(1, work.width - SCREEN_MARGIN * 2)),
        height: Math.min(size.height, Math.max(1, work.height - SCREEN_MARGIN * 2)),
    };
    widgetWindow.setBounds(cornerBounds(bounds, work, fitted));
    // The shadow is computed from the last frame, which is still the previous shape right after a resize;
    // recompute once the renderer has painted the new one or the expanded card's shadow lingers behind the pill.
    clearTimeout(shadowTimer);
    shadowTimer = setTimeout(() => {
        if (alive() && typeof widgetWindow.invalidateShadow === 'function') widgetWindow.invalidateShadow();
    }, 120);
}

function applyVisibility() {
    if (!alive()) return;
    if (hasPrompt() || (enabled && live && !hiddenByUser)) {
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

function schedulePromptExpiry() {
    clearTimeout(promptTimer);
    promptTimer = null;
    if (!hasPrompt() || lastState.callPrompt.status === 'starting') return;
    const id = lastState.callPrompt.id;
    promptTimer = setTimeout(() => {
        if (lastState?.callPrompt?.id !== id) return;
        lastState = { ...lastState, callPrompt: null };
        resizeKeepingCorner(windowSize());
        sendState();
        applyVisibility();
    }, Math.max(0, lastState.callPrompt.expiresAt - Date.now()));
    promptTimer.unref?.();
}

function create({ devUrl, distFile, preload, onActivateMain, onCommand }) {
    if (alive()) return widgetWindow;
    expanded = false;
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
            sandbox: true,
        },
    });
    secureWindow(widgetWindow, { url: devUrl || pathToFileURL(distFile).href, role: 'widget' });

    // A meeting is usually a full-screen call, often on another Space. An
    // indicator that disappears there is missing exactly when it is needed.
    widgetWindow.setAlwaysOnTop(true, 'floating');
    widgetWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

    widgetWindow.on('closed', () => {
        clearTimeout(promptTimer);
        clearTimeout(shadowTimer);
        widgetWindow = null;
        expanded = false;
        lastState = null;
    });

    widgetWindow.once('ready-to-show', () => {
        resizeKeepingCorner(windowSize());
        applyVisibility();
        sendState();
        schedulePromptExpiry();
    });

    if (devUrl) {
        widgetWindow.loadURL(devUrl);
    } else {
        widgetWindow.loadFile(distFile);
    }

    return widgetWindow;
}

function registerHandlers(ipc = ipcMain) {
    ipc.handle('widget:get-state', event => fromWidget(event) ? lastState : null);
    ipc.handle('widget:set-expanded', (event, next) => {
        if (!fromWidget(event)) return false;
        expanded = Boolean(next);
        resizeKeepingCorner(windowSize());
        return expanded;
    });

    ipc.handle('widget:open-main', event => {
        if (!fromWidget(event)) return false;
        activateMain?.();
        return true;
    });

    ipc.handle('widget:hide', event => {
        if (!fromWidget(event)) return false;
        hiddenByUser = true;
        applyVisibility();
        return true;
    });

    ipc.handle('widget:command', (event, action, promptId) => {
        if (!fromWidget(event)) return false;
        if (PROMPT_COMMANDS.has(action)) {
            const prompt = lastState?.callPrompt;
            if (!hasPrompt() || promptId !== prompt.id || prompt.status === 'starting' || Date.now() >= prompt.expiresAt) return false;
            runCommand?.(action, promptId);
            return true;
        }
        if (!COMMANDS.has(action)) return false;
        if (hasPrompt()) return false;
        runCommand?.(action);
        return true;
    });

    // Sent by the main window when the preference changes. Re-enabling clears the
    // per-session dismissal, otherwise the toggle would look broken to anyone who
    // had closed the widget earlier.
    ipc.handle('widget:set-visible', (_event, next) => {
        const wanted = next !== false;
        if (wanted && !enabled) hiddenByUser = false;
        enabled = wanted;
        applyVisibility();
        return enabled;
    });

    ipc.handle('widget:set-live', (_event, next) => {
        live = Boolean(next);
        applyVisibility();
        return live;
    });

    ipc.handle('widget:set-state', (_event, state) => {
        const previousPromptId = lastState?.callPrompt?.id;
        lastState = state ?? null;
        if (lastState?.callPrompt?.status !== 'starting' && lastState?.callPrompt?.expiresAt <= Date.now()) lastState = { ...lastState, callPrompt: null };
        if (previousPromptId !== lastState?.callPrompt?.id) {
            expanded = false;
            resizeKeepingCorner(windowSize());
        }
        sendState();
        schedulePromptExpiry();
        applyVisibility();
        return true;
    });
}

function setLive(next) {
    live = Boolean(next);
    // Called by the shell when the main window closes: its prompt coordinator is gone.
    if (!live && lastState?.callPrompt) {
        lastState = { ...lastState, callPrompt: null };
        clearTimeout(promptTimer);
        resizeKeepingCorner(windowSize());
        sendState();
    }
    applyVisibility();
}

function destroy() {
    clearTimeout(promptTimer);
    clearTimeout(shadowTimer);
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
    _testing: { COLLAPSED, EXPANDED, PROMPT, SCREEN_MARGIN, cornerBounds },
};
