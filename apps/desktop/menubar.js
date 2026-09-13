const { Tray, Menu, Notification, nativeImage, shell, ipcMain, powerMonitor } = require('electron');
const http = require('node:http');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const BACKEND_HOST = process.env.CORE_BACKEND_HOST || '127.0.0.1';
const BACKEND_PORT = Number(process.env.CORE_BACKEND_PORT || 48900);
const FETCH_TIMEOUT_MS = 1500;
const POLL_MS = Number(process.env.ALPHA_MENUBAR_POLL_MS || 120_000);
const STALE_EVENTS_MS = 600_000;
const NOTIFIED_TTL_MS = 43_200_000;
const PENDING_TTL_MS = 120_000;
const TITLE_MAX_CHARS = 24;
const COMMAND_CHANNEL = 'menubar:command';
const PENDING_CHANNEL = 'menubar:pending-command';
const COMMANDS = new Set(['record', 'new-note', 'new-meeting', 'settings']);

const HELPERS_PATH = path.resolve(__dirname, '..', 'ui', 'src', 'lib', 'calendarEvents.js');

let trayIcon = null;
let tickTimer = null;
let pollTimer = null;
let events = [];
let remindersEnabled = true;
let backendOnline = false;
let lastGoodFetchAt = 0;
let offlineLogged = false;
let menuOpen = false;
let menuSignature = '';
let rebuildQueued = false;
let pendingCommand = null;
let notified = new Map();
let helpersPromise = null;
let activateMain = null;
let mainWindowFor = () => null;
let appVersion = '';
let fetchJson = requestJson;

const alive = () => Boolean(trayIcon) && !trayIcon.isDestroyed();

const helpers = () => (helpersPromise ??= import(pathToFileURL(HELPERS_PATH).href).catch(() => null));

function requestJson(pathname) {
    return new Promise(resolve => {
        const request = http.get({ host: BACKEND_HOST, port: BACKEND_PORT, path: pathname, timeout: FETCH_TIMEOUT_MS }, response => {
            let body = '';
            response.setEncoding('utf8');
            response.on('data', chunk => (body += chunk));
            response.on('end', () => {
                try {
                    resolve(response.statusCode === 200 ? JSON.parse(body) : null);
                } catch {
                    resolve(null);
                }
            });
        });
        request.on('timeout', () => request.destroy());
        request.on('error', () => resolve(null));
    });
}

function iconDataUrl(size) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 16 16"><g fill="#000"><rect x="1.5" y="6" width="2" height="4" rx="1"/><rect x="5" y="3" width="2" height="10" rx="1"/><rect x="8.5" y="1" width="2" height="14" rx="1"/><rect x="12" y="5" width="2" height="6" rx="1"/></g></svg>`;
    return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}

function trayImage() {
    const rendered = nativeImage.createFromDataURL(iconDataUrl(32));
    const image = rendered.isEmpty() ? rendered : rendered.resize({ width: 16, height: 16, quality: 'best' });
    image.setTemplateImage(true);
    return image;
}

function truncateTitle(value, max = TITLE_MAX_CHARS) {
    const text = String(value ?? '')
        .replace(/\s+/g, ' ')
        .trim();
    if (!text) return 'Meeting';
    const glyphs = [...text];
    if (glyphs.length <= max) return text;
    return `${glyphs
        .slice(0, max - 1)
        .join('')
        .trimEnd()}…`;
}

function trayTitle(event, countdown) {
    if (!event) return '';
    return `${truncateTitle(event.title)} • ${countdown}`;
}

function nextTickDelay(msUntilStart) {
    if (!Number.isFinite(msUntilStart)) return 60_000;
    if (msUntilStart <= 0) return 30_000;
    if (msUntilStart <= 90_000) return 5_000;
    return Math.min(Math.max((msUntilStart % 60_000) + 250, 1_000), 60_000);
}

function menuTemplate({ event, starts, range, link, version, backendOnline: online }, actions) {
    const info = event
        ? [
              { label: starts, enabled: false },
              { label: event.title || 'Untitled meeting', enabled: false },
              ...(range ? [{ label: range, enabled: false }] : []),
          ]
        : [{ label: online ? 'No upcoming meetings' : 'Waiting for Alpha…', enabled: false }];

    const meeting = event
        ? [
              { type: 'separator' },
              ...(link ? [{ label: 'Join Meeting', click: actions.join }] : []),
              { label: 'Record This Meeting', click: actions.record },
          ]
        : [];

    return [
        ...info,
        ...meeting,
        { type: 'separator' },
        { label: 'Open Alpha', click: actions.openMain },
        { label: 'New Note', click: actions.newNote },
        { label: 'New Meeting…', click: actions.newMeeting },
        { label: 'Settings…', click: actions.settings },
        { type: 'separator' },
        { label: `Alpha ${version}`, enabled: false },
        { label: 'Quit Alpha', role: 'quit' },
    ];
}

function deliver(command) {
    if (!COMMANDS.has(command?.type)) return;
    activateMain?.();
    const target = mainWindowFor();
    const contents = target && !target.isDestroyed() ? target.webContents : null;
    if (contents && !contents.isLoadingMainFrame()) {
        contents.send(COMMAND_CHANNEL, command);
        return;
    }
    pendingCommand = { ...command, queuedAt: Date.now() };
}

function takePendingCommand(nowMs = Date.now()) {
    const queued = pendingCommand;
    pendingCommand = null;
    if (!queued || nowMs - queued.queuedAt > PENDING_TTL_MS) return null;
    const { queuedAt, ...command } = queued;
    return command;
}

function notify(event, lib) {
    if (!Notification.isSupported()) return null;
    const invited = Array.isArray(event.attendees) ? event.attendees.length : 0;
    const body = invited > 0 ? `Starts in under a minute · ${invited} invited. Click to record it.` : 'Starts in under a minute. Click to record it.';
    const notification = new Notification({ title: event.title || 'Meeting starting', body });
    notification.on('click', () => deliver({ type: 'record', event: lib.calendarEventMetadata(event) }));
    notification.show();
    return notification;
}

function runReminders(lib, nowMs) {
    for (const [key, firedAt] of notified) {
        if (nowMs - firedAt > NOTIFIED_TTL_MS) notified.delete(key);
    }
    if (!remindersEnabled) return;
    for (const event of lib.dueForReminder(events, nowMs)) {
        const key = lib.reminderKey(event);
        if (notified.has(key)) continue;
        notified.set(key, nowMs);
        notify(event, lib);
    }
}

function applyMenu(view) {
    const signature = JSON.stringify([view.starts, view.range, view.event?.title ?? null, Boolean(view.link), view.backendOnline]);
    if (signature === menuSignature) return;
    if (menuOpen) {
        rebuildQueued = true;
        return;
    }
    menuSignature = signature;
    rebuildQueued = false;

    const built = Menu.buildFromTemplate(
        menuTemplate(view, {
            openMain: () => activateMain?.(),
            join: () => view.link && shell.openExternal(view.link),
            record: () => deliver({ type: 'record', event: view.metadata }),
            newNote: () => deliver({ type: 'new-note' }),
            newMeeting: () => deliver({ type: 'new-meeting' }),
            settings: () => deliver({ type: 'settings' }),
        })
    );
    built.on?.('menu-will-show', () => {
        menuOpen = true;
    });
    built.on?.('menu-will-close', () => {
        menuOpen = false;
        if (rebuildQueued) {
            menuSignature = '';
            schedule(0);
        }
    });
    trayIcon.setContextMenu(built);
}

async function render(nowMs = Date.now()) {
    const lib = await helpers();
    if (!lib) return NaN;

    const event = lib.currentOrNextEvent(events, nowMs);
    const untilStart = event ? event.startMs - nowMs : NaN;

    runReminders(lib, nowMs);

    if (alive()) {
        const view = {
            event,
            metadata: event ? lib.calendarEventMetadata(event) : null,
            starts: lib.startsLabel(untilStart),
            range: event ? lib.formatEventRange(event) : '',
            link: event ? lib.calendarEventLink(event) : null,
            version: appVersion,
            backendOnline,
        };
        if (process.platform === 'darwin') {
            trayIcon.setTitle(trayTitle(event, lib.countdownLabel(untilStart)), { fontType: 'monospacedDigit' });
        } else {
            trayIcon.setToolTip(trayTitle(event, lib.countdownLabel(untilStart)) || 'Alpha');
        }
        applyMenu(view);
    }

    return untilStart;
}

function schedule(delay) {
    clearTimeout(tickTimer);
    tickTimer = setTimeout(tick, delay);
}

async function tick() {
    const untilStart = await render();
    schedule(nextTickDelay(untilStart));
}

async function poll() {
    const [calendar, stored] = await Promise.all([fetchJson('/api/calendar/events'), fetchJson('/api/settings')]);
    const now = Date.now();

    if (calendar) {
        events = Array.isArray(calendar.events) ? calendar.events : [];
        lastGoodFetchAt = now;
        if (!backendOnline && offlineLogged) console.log('[Alpha] menu bar reconnected to the core backend');
        backendOnline = true;
        offlineLogged = false;
    } else {
        backendOnline = false;
        if (!offlineLogged) {
            console.log('[Alpha] menu bar cannot reach the core backend; keeping the last known schedule');
            offlineLogged = true;
        }
        if (lastGoodFetchAt && now - lastGoodFetchAt > STALE_EVENTS_MS) events = [];
    }

    if (stored) remindersEnabled = stored.settings?.meetingReminders !== false;

    await render(now);
}

function create({ onActivateMain, getMainWindow, version, fetch } = {}) {
    activateMain = onActivateMain ?? null;
    mainWindowFor = getMainWindow ?? (() => null);
    appVersion = String(version ?? '');
    if (typeof fetch === 'function') fetchJson = fetch;

    if (process.platform === 'darwin' && !alive()) {
        trayIcon = new Tray(trayImage());
        trayIcon.setIgnoreDoubleClickEvents(true);
    }

    pollTimer = setInterval(poll, POLL_MS);
    powerMonitor.on?.('resume', () => {
        void poll();
    });
    void poll();
    schedule(0);
    return trayIcon;
}

function registerHandlers() {
    ipcMain.handle(PENDING_CHANNEL, event => {
        const target = mainWindowFor();
        if (!target || target.isDestroyed() || event.sender !== target.webContents) return null;
        return takePendingCommand();
    });
}

function destroy() {
    clearTimeout(tickTimer);
    clearInterval(pollTimer);
    tickTimer = null;
    pollTimer = null;
    notified.clear();
    pendingCommand = null;
    menuSignature = '';
    helpersPromise = null;
    if (!alive()) return;
    trayIcon.destroy();
    trayIcon = null;
}

module.exports = {
    create,
    registerHandlers,
    destroy,
    isActive: alive,
    _testing: {
        TITLE_MAX_CHARS,
        PENDING_TTL_MS,
        COMMAND_CHANNEL,
        PENDING_CHANNEL,
        truncateTitle,
        trayTitle,
        nextTickDelay,
        menuTemplate,
        takePendingCommand,
        poll,
        render,
        state: () => ({
            events,
            remindersEnabled,
            backendOnline,
            notified,
            pendingCommand,
            ticking: tickTimer !== null,
            polling: pollTimer !== null,
        }),
        reset: () => {
            events = [];
            remindersEnabled = true;
            backendOnline = false;
            lastGoodFetchAt = 0;
            offlineLogged = false;
            menuOpen = false;
            menuSignature = '';
            rebuildQueued = false;
            pendingCommand = null;
            notified = new Map();
        },
    },
};
