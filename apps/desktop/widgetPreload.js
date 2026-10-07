const { contextBridge, ipcRenderer } = require('electron');

// The floating widget reaches the core backend over HTTP and WebSocket like any
// other page. All it needs from the shell is control of its own window and a
// relay to the main window, which owns the meeting and executes the commands, so
// that is the whole surface: no filesystem, no recorder, no podcast tokens.
contextBridge.exposeInMainWorld('kesamiWidget', {
    setExpanded: expanded => ipcRenderer.invoke('widget:set-expanded', Boolean(expanded)),
    openMain: () => ipcRenderer.invoke('widget:open-main'),
    hide: () => ipcRenderer.invoke('widget:hide'),
    sendCommand: (action, promptId) => ipcRenderer.invoke('widget:command', action, promptId),
    onState: handler => {
        if (typeof handler !== 'function') return () => {};
        let subscribed = true;
        let received = false;
        const trackedListener = (_event, state) => { received = true; handler(state); };
        ipcRenderer.on('widget:state', trackedListener);
        ipcRenderer.invoke('widget:get-state').then(state => {
            if (subscribed && !received && state) handler(state);
        }).catch(() => {});
        return () => { subscribed = false; ipcRenderer.removeListener('widget:state', trackedListener); };
    },
});
