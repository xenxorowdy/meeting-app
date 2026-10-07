const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('kesamiGoogleSignIn', {
    start: options => ipcRenderer.invoke('google-sign-in:start', options),
});

let connection = ipcRenderer.sendSync('connection:get');
contextBridge.exposeInMainWorld('kesamiConnection', {
    get: () => connection,
    save: async value => {
        connection = await ipcRenderer.invoke('connection:save', value);
    },
});

// The renderer talks to the core backend over HTTP and WebSocket, so it needs
// nothing from Node for that. Screen recording is the one exception: enumerating
// capture sources and writing a video file are main-process jobs, so this bridge
// exposes exactly those calls and nothing else. Everything here is a named,
// argument-checked channel — no `ipcRenderer` and no module loader reach the page.
contextBridge.exposeInMainWorld('kesamiRecorder', {
    /** Displays and windows that can be captured, each with a preview thumbnail. */
    listSources: () => ipcRenderer.invoke('recorder:list-sources'),

    /** macOS TCC state for screen capture: 'granted' | 'denied' | 'restricted' | 'not-determined'. */
    screenPermission: () => ipcRenderer.invoke('recorder:screen-permission'),

    /** Choose which source the display-media handler hands back; null means the primary screen. */
    selectSource: sourceId => ipcRenderer.invoke('recorder:select-source', sourceId),

    /** Open a file for this meeting. Resolves to { id, path }. */
    start: options => ipcRenderer.invoke('recorder:start', options),

    /** Append one encoded chunk. The ArrayBuffer is copied across, not shared. */
    writeChunk: (id, chunk) => ipcRenderer.invoke('recorder:write-chunk', id, chunk),

    /** Close the file. Resolves to { path, bytes }. */
    stop: id => ipcRenderer.invoke('recorder:stop', id),

    /** Remove a meeting's recording directory, after its record has been deleted. */
    remove: meetingId => ipcRenderer.invoke('recorder:remove', meetingId),

    /** Bytes currently used by all stored recordings, for the settings screen. */
    usage: () => ipcRenderer.invoke('recorder:usage'),

    /** A URL the player can load. Recordings are served over a dedicated scheme.
        The path arrives already `/`-separated from the main process. */
    mediaUrl: relativePath => `kesami-media://recordings/${String(relativePath).split('/').filter(Boolean).map(encodeURIComponent).join('/')}`,
});

// Podcast is disabled; no project, publishing or capture bridge is exposed.

const systemAudioListeners = { data: new Set(), status: new Set() };

const fanOut = (listeners, value) => {
    for (const listener of listeners) {
        try {
            listener(value);
        } catch {
            /* empty */
        }
    }
};

ipcRenderer.on('system-audio:data', (_event, chunk) => {
    if (!chunk || !chunk.byteLength) return;
    fanOut(systemAudioListeners.data, new Uint8Array(chunk));
});

ipcRenderer.on('system-audio:status', (_event, status) => {
    if (!status || typeof status.state !== 'string') return;
    fanOut(systemAudioListeners.status, Object.freeze({ state: status.state, message: status.message ?? null }));
});

const subscribe = (listeners, listener) => {
    if (typeof listener !== 'function') return () => {};
    listeners.add(listener);
    return () => listeners.delete(listener);
};

contextBridge.exposeInMainWorld('kesamiSystemAudio', {
    available: () => ipcRenderer.invoke('system-audio:available'),
    start: () => ipcRenderer.invoke('system-audio:start'),
    stop: () => ipcRenderer.invoke('system-audio:stop'),
    onData: listener => subscribe(systemAudioListeners.data, listener),
    onStatus: listener => subscribe(systemAudioListeners.status, listener),
});

const micUsageListeners = new Set();

ipcRenderer.on('mic-usage:event', (_event, usage) => {
    if (!usage || typeof usage.active !== 'boolean') return;
    fanOut(micUsageListeners, Object.freeze({ active: usage.active, at: usage.at ?? null }));
});

// Lets the app notice a call that Kesami is not part of: any process opening
// the microphone. The watcher keeps running across reloads; subscribing again
// is what pulls the current state into the fresh page.
contextBridge.exposeInMainWorld('kesamiMicUsage', {
    available: () => ipcRenderer.invoke('mic-usage:available'),
    start: () => ipcRenderer.invoke('mic-usage:start'),
    stop: () => ipcRenderer.invoke('mic-usage:stop'),
    onEvent: listener => subscribe(micUsageListeners, listener),
});

const MENUBAR_COMMANDS = new Set(['record', 'new-note', 'new-meeting', 'settings']);
const menuBarListeners = new Set();

const normalizeCommand = command =>
    command && MENUBAR_COMMANDS.has(command.type)
        ? Object.freeze({ type: command.type, event: command.event ?? null, auto: command.auto === true })
        : null;

ipcRenderer.on('menubar:command', (_event, command) => {
    const normalized = normalizeCommand(command);
    if (!normalized) return;
    for (const listener of menuBarListeners) {
        try {
            listener(normalized);
        } catch {
            /* empty */
        }
    }
});

// The main window owns the floating-widget preference; the shell owns the window.
contextBridge.exposeInMainWorld('kesamiShell', {
    setWidgetVisible: visible => ipcRenderer.invoke('widget:set-visible', Boolean(visible)),

    setWidgetLive: live => ipcRenderer.invoke('widget:set-live', Boolean(live)),

    setWidgetState: state => ipcRenderer.invoke('widget:set-state', state),

    onWidgetCommand: listener => {
        if (typeof listener !== 'function') return () => {};
        const forward = (_event, action, promptId) => listener(action, promptId);
        ipcRenderer.on('shell:widget-command', forward);
        return () => ipcRenderer.removeListener('shell:widget-command', forward);
    },

    setRecordingIndicator: active => ipcRenderer.invoke('menubar:set-recording', Boolean(active)),

    refreshMenuBar: () => ipcRenderer.invoke('menubar:refresh'),

    testNotification: () => ipcRenderer.invoke('menubar:test-notification'),

    openNotificationSettings: () => ipcRenderer.invoke('menubar:open-notification-settings'),

    ownsMeetingReminders: true,

    onMenuBarCommand: listener => {
        if (typeof listener !== 'function') return () => {};
        menuBarListeners.add(listener);
        return () => menuBarListeners.delete(listener);
    },

    pendingMenuBarCommand: () => ipcRenderer.invoke('menubar:pending-command'),
});
