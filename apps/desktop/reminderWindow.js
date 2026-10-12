const { BrowserWindow, screen } = require('electron');

const windows = new Set();
const WIDTH = 360;
const HEIGHT = 224;
const LIFETIME_MS = 90_000;
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

function documentHtml({ title, body, join, cancel }) {
    return `<!doctype html><html><head><meta charset="utf-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
    <style>
    :root{color-scheme:light dark;--paper:#faf8f5;--ink:#292624;--muted:#68615c;--line:#ded7d1;--accent:#ad3c26;--tint:#f5e8df}
    @media(prefers-color-scheme:dark){:root{--paper:#292725;--ink:#f5f1ec;--muted:#c1b9b2;--line:#4d4742;--accent:#ffab90;--tint:#49342c}}
    *{box-sizing:border-box}html,body{margin:0;background:transparent;font:14px -apple-system,BlinkMacSystemFont,sans-serif;color:var(--ink)}
    main{height:224px;padding:20px;border:1px solid var(--line);border-radius:22px;background:var(--paper);display:flex;flex-direction:column}
    header{display:flex;align-items:center;justify-content:space-between;color:var(--accent);font-size:11px;font-weight:650;letter-spacing:.08em}
    h1{margin:14px 0 7px;font-size:19px;line-height:1.3;letter-spacing:-.025em;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
    p{margin:0;color:var(--muted);font-size:12px;line-height:1.5}nav{display:flex;gap:8px;margin-top:auto;padding-top:12px}
    a{display:inline-flex;align-items:center;justify-content:center;text-decoration:none;color:var(--ink);border:1px solid var(--line);border-radius:999px;padding:9px 13px;font-size:12px;white-space:nowrap}
    a:hover{background:var(--tint)}a:focus-visible{outline:2px solid var(--accent);outline-offset:2px}.primary{background:var(--tint);color:var(--accent);border-color:var(--accent)}
    .dismiss{padding:4px 8px;font-size:17px;border:0;color:var(--muted)}
    </style></head><body><main><header><span>KESAMI · MEETING REMINDER</span><a class="dismiss" aria-label="Dismiss reminder" href="kesami-reminder:dismiss">×</a></header>
    <h1>${escapeHtml(title)}</h1><p>${escapeHtml(body)}</p><nav><a class="primary" href="kesami-reminder:record">Open Kesami</a>${join ? '<a href="kesami-reminder:join">Join</a>' : ''}${cancel ? '<a href="kesami-reminder:cancel">Don’t Record</a>' : ''}</nav></main></body></html>`;
}

function show({ title, body, onRecord, onJoin, onCancel, onShown }) {
    const work = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
    const width = Math.min(WIDTH, work.width - 24);
    const height = Math.min(HEIGHT, work.height - 24);
    const window = new BrowserWindow({
        width, height, x: work.x + work.width - width - 16,
        y: Math.min(work.y + 16 + windows.size * (HEIGHT + 12), work.y + work.height - height - 16),
        show: false, frame: false, transparent: true, hasShadow: true,
        resizable: false, minimizable: false, maximizable: false, fullscreenable: false, skipTaskbar: true,
        title: 'Kesami meeting reminder',
        webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    windows.add(window);
    window.setAlwaysOnTop(true, 'floating');
    window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    let acted = false;
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-attach-webview', event => event.preventDefault());
    window.webContents.on('will-redirect', event => event.preventDefault());
    window.webContents.on('will-navigate', (event, url) => {
        event.preventDefault();
        const action = { 'kesami-reminder:record': onRecord, 'kesami-reminder:join': onJoin, 'kesami-reminder:cancel': onCancel, 'kesami-reminder:dismiss': () => {} }[url];
        if (!action || acted || window.isDestroyed()) return;
        acted = true;
        window.destroy();
        action();
    });
    window.once('ready-to-show', () => {
        if (window.isDestroyed()) return;
        window.showInactive();
        onShown?.();
    });
    const timer = setTimeout(() => { if (!window.isDestroyed()) window.destroy(); }, LIFETIME_MS);
    timer.unref?.();
    window.on('closed', () => { clearTimeout(timer); windows.delete(window); });
    void window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(documentHtml({ title, body, join: Boolean(onJoin), cancel: Boolean(onCancel) }))}`).catch(() => { if (!window.isDestroyed()) window.destroy(); });
    return window;
}

function destroy() { for (const window of windows) if (!window.isDestroyed()) window.destroy(); windows.clear(); }

module.exports = { show, destroy, _testing: { documentHtml, LIFETIME_MS } };
