const { contextBridge, ipcRenderer } = require('electron');

// The floating widget reaches the core backend over HTTP and WebSocket like any
// other page. All it needs from the shell is control of its own window and a
// relay to the main window, which owns the meeting and executes the commands, so
// that is the whole surface: no filesystem, no recorder, no podcast tokens.
contextBridge.exposeInMainWorld('alphaWidget', {
    setExpanded: expanded => ipcRenderer.invoke('widget:set-expanded', Boolean(expanded)),
    openMain: () => ipcRenderer.invoke('widget:open-main'),
    hide: () => ipcRenderer.invoke('widget:hide'),
    sendCommand: action => ipcRenderer.invoke('widget:command', action),
    onState: handler => {
        if (typeof handler !== 'function') return () => {};
        const listener = (_event, state) => handler(state);
        ipcRenderer.on('widget:state', listener);
        return () => ipcRenderer.removeListener('widget:state', listener);
    },
});
