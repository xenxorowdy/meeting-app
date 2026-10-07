const trustedContents = new WeakMap();
const WIDGET_CHANNELS = new Set(['widget:set-expanded', 'widget:open-main', 'widget:hide', 'widget:command', 'widget:get-state']);
const PERMISSIONS = new Set(['media', 'audioCapture', 'display-capture', 'notifications']);

function sameDocument(value, expected) {
    try {
        const url = new URL(value);
        const target = new URL(expected);
        return url.protocol === target.protocol && url.host === target.host && url.pathname === target.pathname
            && !url.username && !url.password;
    } catch {
        return false;
    }
}

function externalUrl(value) {
    try {
        const url = new URL(value);
        return ['https:', 'http:', 'mailto:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
    } catch {
        return null;
    }
}

function secureWindow(window, { url, role, openExternal }) {
    const contents = window.webContents;
    trustedContents.set(contents, { url, role });
    const navigate = (event, destination) => {
        if (!sameDocument(destination, url)) event.preventDefault();
    };
    contents.on('will-navigate', navigate);
    contents.on('will-redirect', navigate);
    contents.on('will-attach-webview', event => event.preventDefault());
    contents.setWindowOpenHandler(({ url: destination }) => {
        const safe = externalUrl(destination);
        if (role === 'main' && safe && openExternal) {
            Promise.resolve().then(() => openExternal(safe)).catch(() => {});
        }
        return { action: 'deny' };
    });
}

function isTrustedFrame(contents, frame, role = 'main') {
    const trusted = contents && trustedContents.get(contents);
    return Boolean(trusted && trusted.role === role && !contents.isDestroyed()
        && frame && frame === contents.mainFrame && sameDocument(frame.url, trusted.url));
}

function permissionAllowed(contents, permission, details = {}) {
    if (!PERMISSIONS.has(permission) || details.isMainFrame === false
        || !isTrustedFrame(contents, contents?.mainFrame)) return false;
    const requestingUrl = details.requestingUrl || details.securityOrigin;
    if (!requestingUrl) return true;
    const trusted = trustedContents.get(contents);
    // Permission-check callbacks may provide an origin rather than a document URL.
    try {
        const requesting = new URL(requestingUrl);
        const target = new URL(trusted.url);
        if (requesting.protocol !== target.protocol || requesting.host !== target.host) return false;
        return !details.requestingUrl || sameDocument(details.requestingUrl, trusted.url);
    } catch {
        return false;
    }
}

function trustedIpc(ipcMain) {
    const allowed = (channel, event) => isTrustedFrame(event.sender, event.senderFrame, WIDGET_CHANNELS.has(channel) ? 'widget' : 'main');
    return {
        handle(channel, handler) {
            ipcMain.handle(channel, (event, ...args) => {
                if (!allowed(channel, event)) throw new Error('Untrusted desktop request.');
                return handler(event, ...args);
            });
        },
        on(channel, handler) {
            ipcMain.on(channel, (event, ...args) => {
                if (!allowed(channel, event)) {
                    event.returnValue = null;
                    return;
                }
                handler(event, ...args);
            });
        },
    };
}

module.exports = { secureWindow, isTrustedFrame, permissionAllowed, trustedIpc, externalUrl };
