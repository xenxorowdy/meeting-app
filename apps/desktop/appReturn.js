const path = require('node:path');

// This link only raises the window. OAuth codes remain on the PKCE loopback flow.
function isAppReturn(url) {
    return url === 'kesami://open' || url === 'kesami://open/';
}

function registerAppReturn(app, showWindow) {
    const open = () => { void app.whenReady().then(showWindow); };
    app.on('open-url', (event, url) => {
        if (!isAppReturn(url)) return;
        event.preventDefault();
        open();
    });
    app.on('second-instance', (_event, args = []) => {
        if (args.some(isAppReturn)) open();
    });
    if (process.defaultApp && process.argv[1]) {
        app.setAsDefaultProtocolClient('kesami', process.execPath, [path.resolve(process.argv[1])]);
    } else if (app.isPackaged) {
        app.setAsDefaultProtocolClient('kesami');
    }
}

module.exports = { isAppReturn, registerAppReturn };
