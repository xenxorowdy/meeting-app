const { app, Tray, Menu, Notification, nativeImage, shell, ipcMain, powerMonitor } = require('electron');
const http = require('node:http');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { env } = require('./legacy');

const BACKEND_HOST = process.env.CORE_BACKEND_HOST || '127.0.0.1';
const BACKEND_PORT = Number(process.env.CORE_BACKEND_PORT || 48900);
const FETCH_TIMEOUT_MS = 1500;
const POLL_MS = Number(env('MENUBAR_POLL_MS') || 60_000);
// The tray is created before the backend finishes starting, so the first polls usually fail. Retrying on
// this short timer (instead of waiting a full POLL_MS) is what gets today's meetings into the menu at launch.
const OFFLINE_RETRY_MS = 5_000;
const STALE_EVENTS_MS = 600_000;
const NOTIFIED_TTL_MS = 43_200_000;
const PENDING_TTL_MS = 120_000;
// Auto-record fires on the first tick at or after the start time. Past this window the meeting is treated
// as missed (the Mac slept, the app was closed) rather than starting a recording of whatever comes next.
const AUTO_RECORD_GRACE_MS = 120_000;
// The menu bar is shared with every other status item, and the countdown is the part people glance at,
// so the name gets a very short budget (a first word or name) and is ellipsised past it.
const TITLE_MAX_CHARS = 6;
// The dropdown row gets more room than the menu bar title, but a full calendar name can still stretch the
// whole menu across the screen, so it is capped too; the untruncated name stays reachable as the tooltip.
const MENU_TITLE_MAX_CHARS = 32;
const COMMAND_CHANNEL = 'menubar:command';
const PENDING_CHANNEL = 'menubar:pending-command';
const RECORDING_CHANNEL = 'menubar:set-recording';
const REFRESH_CHANNEL = 'menubar:refresh';
const TEST_NOTIFICATION_CHANNEL = 'menubar:test-notification';
const NOTIFICATION_SETTINGS_CHANNEL = 'menubar:open-notification-settings';
const NOTIFICATION_SETTINGS_URL = 'x-apple.systempreferences:com.apple.Notifications-Settings.extension';
const COMMANDS = new Set(['record', 'new-note', 'new-meeting', 'settings']);

const HELPERS_PATH = app?.isPackaged
    ? path.join(process.resourcesPath, 'calendar', 'calendarEvents.mjs')
    : path.resolve(__dirname, '..', 'ui', 'src', 'lib', 'calendarEvents.js');

let trayIcon = null;
let tickTimer = null;
let pollTimer = null;
let retryTimer = null;
let events = [];
let remindersEnabled = true;
let autoRecordEnabled = true;
// reminderKey → { event, state: 'armed' | 'cancelled' | 'started' } for meetings inside the reminder window.
let autoRecords = new Map();
let backendOnline = false;
// 'ok' | 'none' (no calendar connected) | 'error' (connected, but every provider failed to answer).
let calendarState = 'ok';
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
let recording = false;
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

// PNGs, not inline SVG: nativeImage only decodes PNG and JPEG, so an SVG data URL produced an empty image
// and the menu bar showed nothing but its highlight. Electron picks up the @2x file on Retina screens.
const TRAY_ICON_PATH = path.join(__dirname, 'assets', 'trayTemplate.png');
const RECORDING_ICON_PATH = path.join(__dirname, 'assets', 'trayRecording.png');

function trayImage() {
    const image = nativeImage.createFromPath(TRAY_ICON_PATH);
    // Template images are drawn by macOS in the menu bar's own colour, so the glyph works in light and dark.
    image.setTemplateImage(true);
    return image;
}

function recordingTrayImage() {
    const image = nativeImage.createFromPath(RECORDING_ICON_PATH);
    image.setTemplateImage(false);
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

function emptyLabel(online, calendar) {
    if (!online) return 'Waiting for Kesami…';
    if (calendar === 'none') return 'No calendar connected';
    if (calendar === 'error') return 'Couldn’t load your calendar';
    return 'No upcoming meetings';
}

function menuTemplate({ event, starts, range, link, version, backendOnline: online, recording, calendarState: calendar = 'ok' }, actions) {
    const recordingStatus = recording
        ? [{ label: 'Recording in progress', enabled: false, icon: recordingTrayImage() }]
        : [];
    const info = event
        ? [
              { label: starts, enabled: false },
              {
                  label: event.title ? truncateTitle(event.title, MENU_TITLE_MAX_CHARS) : 'Untitled meeting',
                  ...(event.title && [...event.title.trim()].length > MENU_TITLE_MAX_CHARS ? { toolTip: event.title.trim() } : {}),
                  enabled: false,
              },
              ...(range ? [{ label: range, enabled: false }] : []),
          ]
        : [
              { label: emptyLabel(online, calendar), enabled: false },
              ...(online && calendar !== 'ok' ? [{ label: calendar === 'none' ? 'Connect a Calendar…' : 'Check Calendar Settings…', click: actions.settings }] : []),
          ];

    const meeting = event
        ? [
              { type: 'separator' },
              ...(link ? [{ label: 'Join Meeting', click: actions.join }] : []),
              { label: 'Record This Meeting', click: actions.record },
          ]
        : [];

    return [
        ...recordingStatus,
        ...info,
        ...meeting,
        { type: 'separator' },
        { label: 'Open Kesami', click: actions.openMain },
        { label: 'New Note', click: actions.newNote },
        { label: 'New Meeting…', click: actions.newMeeting },
        { label: 'Settings…', click: actions.settings },
        { type: 'separator' },
        { label: `Kesami ${version}`, enabled: false },
        { label: 'Quit Kesami', role: 'quit' },
    ];
}

function deliver(command, { focus = true } = {}) {
    if (!COMMANDS.has(command?.type)) return;
    const target = mainWindowFor();
    const contents = target && !target.isDestroyed() ? target.webContents : null;
    // An automatic start shouldn't pull Kesami in front of the call someone just joined; it only needs a
    // window to exist, so focus is skipped when one is already there to receive the command.
    if (focus || !contents) activateMain?.();
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

function notify(event, lib, key) {
    if (!Notification.isSupported()) return null;
    const invited = Array.isArray(event.attendees) ? event.attendees.length : 0;
    const link = lib.calendarEventLink(event);
    const auto = autoRecords.get(key)?.state === 'armed';
    const next = auto ? 'Recording starts automatically.' : 'Click to record it.';
    const body = `Starts in 1 minute${invited > 0 ? ` · ${invited} invited` : ''}. ${next}`;
    const notification = new Notification({
        title: event.title || 'Meeting starting',
        body,
        ...(link ? { actions: [{ type: 'button', text: 'Join' }] } : {}),
        ...(auto ? { closeButtonText: 'Don’t Record' } : {}),
    });
    const metadata = lib.calendarEventMetadata(event);
    // Clicking the notification or Join is someone choosing to be in the meeting now, so record straight away
    // (and open the call for Join) instead of waiting for the start time.
    const recordNow = () => {
        const entry = autoRecords.get(key);
        if (entry) entry.state = 'started';
        deliver({ type: 'record', event: metadata });
    };
    const join = () => {
        if (link) void shell.openExternal(link);
        recordNow();
    };
    notification.on('click', join);
    notification.on('action', join);
    notification.on('close', () => {
        const entry = autoRecords.get(key);
        if (entry?.state === 'armed') entry.state = 'cancelled';
    });
    notification.show();
    return notification;
}

function runAutoRecord(lib, nowMs) {
    for (const [key, entry] of autoRecords) {
        const startMs = Date.parse(entry.event?.start);
        if (!Number.isFinite(startMs) || nowMs - startMs > AUTO_RECORD_GRACE_MS) {
            autoRecords.delete(key);
            continue;
        }
        if (entry.state !== 'armed' || nowMs < startMs) continue;
        entry.state = 'started';
        // Already recording (someone clicked Record, or the previous call ran over): leave it alone.
        if (recording || !autoRecordEnabled) continue;
        deliver({ type: 'record', event: lib.calendarEventMetadata(entry.event), auto: true }, { focus: false });
    }
}

function runReminders(lib, nowMs) {
    for (const [key, firedAt] of notified) {
        if (nowMs - firedAt > NOTIFIED_TTL_MS) notified.delete(key);
    }
    for (const event of lib.dueForReminder(events, nowMs)) {
        const key = lib.reminderKey(event);
        if (autoRecordEnabled && !autoRecords.has(key)) autoRecords.set(key, { event, state: 'armed' });
        if (!remindersEnabled || notified.has(key)) continue;
        notified.set(key, nowMs);
        notify(event, lib, key);
    }
    runAutoRecord(lib, nowMs);
}

function applyMenu(view) {
    const signature = JSON.stringify([view.starts, view.range, view.event?.title ?? null, Boolean(view.link), view.backendOnline, view.recording, view.calendarState]);
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
        // Opening the menu is the moment someone looks at the schedule, so fetch it now. A change lands
        // after the menu closes (rebuilding an open menu is unsafe), so the next open is current.
        void poll();
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
            calendarState,
        };
        if (process.platform === 'darwin') {
            trayIcon.setTitle(recording ? 'Recording' : trayTitle(event, lib.countdownLabel(untilStart)), { fontType: 'monospacedDigit' });
        } else {
            trayIcon.setToolTip(recording ? 'Recording' : trayTitle(event, lib.countdownLabel(untilStart)) || 'Kesami');
        }
        view.recording = recording;
        applyMenu(view);
    }

    return untilStart;
}

function schedule(delay) {
    clearTimeout(tickTimer);
    tickTimer = setTimeout(tick, delay);
}

// The countdown follows the current or next meeting, which during back-to-back calls is the one still running,
// so its cadence alone could start the next meeting's recording up to 30s late. Wake for an armed start too.
function autoRecordDelay(nowMs = Date.now()) {
    let soonest = Infinity;
    for (const entry of autoRecords.values()) {
        if (entry.state !== 'armed') continue;
        const startMs = Date.parse(entry.event?.start);
        if (Number.isFinite(startMs) && startMs > nowMs) soonest = Math.min(soonest, startMs - nowMs + 250);
    }
    return soonest;
}

async function tick() {
    const untilStart = await render();
    schedule(Math.min(nextTickDelay(untilStart), autoRecordDelay()));
}

function scheduleRetry() {
    if (retryTimer) return;
    retryTimer = setTimeout(() => {
        retryTimer = null;
        void poll();
    }, OFFLINE_RETRY_MS);
    retryTimer.unref?.();
}

// Empty events alone can't tell "nothing scheduled" from "no calendar" or "the calendar failed",
// and the menu used to say "No upcoming meetings" for all three.
function classifyCalendar(calendar, status) {
    const providers = Array.isArray(status?.providers) ? status.providers : null;
    if (providers && !providers.some(provider => provider?.connected)) return 'none';
    const found = Array.isArray(calendar?.events) ? calendar.events.length : 0;
    const warned = Array.isArray(calendar?.warnings) ? calendar.warnings.length : 0;
    const connected = providers ? providers.filter(provider => provider?.connected).length : warned;
    return found === 0 && warned > 0 && warned >= connected ? 'error' : 'ok';
}

async function poll() {
    const [calendar, stored, status] = await Promise.all([
        fetchJson('/api/calendar/events'),
        fetchJson('/api/settings'),
        fetchJson('/api/calendar/status'),
    ]);
    const now = Date.now();

    if (calendar) {
        events = Array.isArray(calendar.events) ? calendar.events : [];
        calendarState = classifyCalendar(calendar, status);
        lastGoodFetchAt = now;
        if (!backendOnline && offlineLogged) console.log('[Kesami] menu bar reconnected to the core backend');
        backendOnline = true;
        offlineLogged = false;
    } else {
        backendOnline = false;
        if (!offlineLogged) {
            console.log('[Kesami] menu bar cannot reach the core backend; keeping the last known schedule');
            offlineLogged = true;
        }
        if (lastGoodFetchAt && now - lastGoodFetchAt > STALE_EVENTS_MS) events = [];
        scheduleRetry();
    }

    if (stored) {
        remindersEnabled = stored.settings?.meetingReminders !== false;
        autoRecordEnabled = stored.settings?.autoRecordMeetings !== false;
    }

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

function refresh() {
    return poll();
}

function setRecording(next) {
    recording = Boolean(next);
    if (alive()) trayIcon.setImage(recording ? recordingTrayImage() : trayImage());
    void render();
    return recording;
}

function fromMainWindow(event) {
    const target = mainWindowFor();
    return Boolean(target && !target.isDestroyed() && event.sender === target.webContents);
}

function registerHandlers() {
    ipcMain.handle(PENDING_CHANNEL, event => {
        if (!fromMainWindow(event)) return null;
        return takePendingCommand();
    });
    // The main window asks for a refresh after it connects a calendar or creates an event, so the menu
    // doesn't lag the app by a poll interval.
    ipcMain.handle(REFRESH_CHANNEL, async event => {
        if (!fromMainWindow(event)) return false;
        await poll();
        return true;
    });
    ipcMain.handle(RECORDING_CHANNEL, (event, active) => {
        if (!fromMainWindow(event)) return false;
        return setRecording(active);
    });
    ipcMain.handle(TEST_NOTIFICATION_CHANNEL, event => {
        if (!fromMainWindow(event)) return { shown: false };
        if (!Notification.isSupported()) return { shown: false, reason: 'Notifications are not supported on this system.' };
        new Notification({
            title: 'Kesami notifications are on',
            body: 'Meeting reminders and call prompts will appear like this.',
        }).show();
        return { shown: true, backendOnline, calendarState };
    });
    ipcMain.handle(NOTIFICATION_SETTINGS_CHANNEL, event => {
        if (!fromMainWindow(event)) return false;
        if (process.platform !== 'darwin') return false;
        void shell.openExternal(NOTIFICATION_SETTINGS_URL);
        return true;
    });
}

function destroy() {
    clearTimeout(tickTimer);
    clearInterval(pollTimer);
    clearTimeout(retryTimer);
    tickTimer = null;
    pollTimer = null;
    retryTimer = null;
    notified.clear();
    autoRecords.clear();
    pendingCommand = null;
    recording = false;
    menuSignature = '';
    helpersPromise = null;
    if (!alive()) return;
    trayIcon.destroy();
    trayIcon = null;
}

module.exports = {
    create,
    refresh,
    setRecording,
    registerHandlers,
    destroy,
    isActive: alive,
    _testing: {
        TITLE_MAX_CHARS,
        MENU_TITLE_MAX_CHARS,
        PENDING_TTL_MS,
        AUTO_RECORD_GRACE_MS,
        COMMAND_CHANNEL,
        PENDING_CHANNEL,
        RECORDING_CHANNEL,
        REFRESH_CHANNEL,
        TEST_NOTIFICATION_CHANNEL,
        classifyCalendar,
        autoRecordDelay,
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
            autoRecordEnabled,
            autoRecords,
            backendOnline,
            calendarState,
            recording,
            notified,
            pendingCommand,
            ticking: tickTimer !== null,
            polling: pollTimer !== null,
        }),
        reset: () => {
            events = [];
            remindersEnabled = true;
            autoRecordEnabled = true;
            autoRecords = new Map();
            backendOnline = false;
            calendarState = 'ok';
            lastGoodFetchAt = 0;
            offlineLogged = false;
            menuOpen = false;
            menuSignature = '';
            rebuildQueued = false;
            pendingCommand = null;
            recording = false;
            notified = new Map();
        },
    },
};
