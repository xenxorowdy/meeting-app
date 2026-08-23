const { contextBridge, ipcRenderer } = require('electron');

// The renderer talks to the core backend over HTTP and WebSocket, so it needs
// nothing from Node for that. Screen recording is the one exception: enumerating
// capture sources and writing a video file are main-process jobs, so this bridge
// exposes exactly those calls and nothing else. Everything here is a named,
// argument-checked channel — no `ipcRenderer` and no module loader reach the page.
contextBridge.exposeInMainWorld('alphaRecorder', {
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
    mediaUrl: relativePath => `alpha-media://recordings/${String(relativePath).split('/').filter(Boolean).map(encodeURIComponent).join('/')}`,
});

// Podcast projects can contain large media files and private publishing tokens.
// The renderer gets task-shaped IPC methods, never filesystem or OAuth access.
contextBridge.exposeInMainWorld('alphaPodcast', {
    list: () => ipcRenderer.invoke('podcast:list'),
    create: options => ipcRenderer.invoke('podcast:create', options),
    get: id => ipcRenderer.invoke('podcast:get', id),
    save: project => ipcRenderer.invoke('podcast:save', project),
    remove: id => ipcRenderer.invoke('podcast:delete', id),
    importFile: id => ipcRenderer.invoke('podcast:import-file', id),
    addAsset: (id, assetId, options) => ipcRenderer.invoke('podcast:add-asset', id, assetId, options),
    inspectRss: url => ipcRenderer.invoke('podcast:rss-inspect', url),
    importRss: (id, feed, episode) => ipcRenderer.invoke('podcast:rss-import', id, feed, episode),
    waveform: (id, assetId) => ipcRenderer.invoke('podcast:waveform', id, assetId),
    cleanSpeech: (id, assetId) => ipcRenderer.invoke('podcast:clean-speech', id, assetId),
    render: (id, format) => ipcRenderer.invoke('podcast:render', id, format),
    cancelJob: id => ipcRenderer.invoke('podcast:cancel-job', id),
    settings: () => ipcRenderer.invoke('podcast:settings'),
    saveSettings: patch => ipcRenderer.invoke('podcast:settings-save', patch),
    connectYouTube: () => ipcRenderer.invoke('podcast:youtube-connect'),
    disconnectYouTube: () => ipcRenderer.invoke('podcast:youtube-disconnect'),
    listYouTube: () => ipcRenderer.invoke('podcast:youtube-list'),
    importYouTube: (id, video) => ipcRenderer.invoke('podcast:youtube-import', id, video),
    publishYouTube: (id, exportId) => ipcRenderer.invoke('podcast:youtube-publish', id, exportId),
    startCapture: (projectId, options) => ipcRenderer.invoke('podcast:capture-start', projectId, options),
    writeCapture: (id, chunk) => ipcRenderer.invoke('podcast:capture-write', id, chunk),
    stopCapture: id => ipcRenderer.invoke('podcast:capture-stop', id),
    mediaUrl: (projectId, relativePath) =>
        `alpha-podcast://${encodeURIComponent(projectId)}/${String(relativePath).split('/').filter(Boolean).map(encodeURIComponent).join('/')}`,
});
