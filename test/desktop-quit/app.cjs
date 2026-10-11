const { app, BrowserWindow } = require('electron');
const { holdQuitUntil } = require('../../apps/desktop/shutdown');

const { WINDOW_STATE } = process.env;

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});

holdQuitUntil(app, () => Promise.allSettled([]), { beforeExit: () => process.stdout.write('cleaned up\n') });

app.whenReady().then(() => {
    const window = new BrowserWindow({ width: 320, height: 160, show: WINDOW_STATE !== 'never-shown' });
    window.loadURL('data:text/html,<p>Kesami quit test</p>');
    window.webContents.once('did-finish-load', () => {
        if (WINDOW_STATE === 'minimized') window.minimize();
        if (WINDOW_STATE === 'app-hidden') app.hide();
        setTimeout(() => process.stdout.write('ready\n'), 500);
    });
});
