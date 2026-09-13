const test = require('node:test');
const { afterEach } = test;
const assert = require('node:assert/strict');
const Module = require('node:module');

const handlers = new Map();
const shown = [];
let trays = [];

class FakeTray {
    constructor(image) {
        this.image = image;
        this.destroyed = false;
        this.title = null;
        this.titleOptions = null;
        this.tooltip = null;
        this.menu = null;
        this.ignoredDoubleClicks = false;
        trays.push(this);
    }

    isDestroyed() {
        return this.destroyed;
    }

    setTitle(title, options) {
        this.title = title;
        this.titleOptions = options;
    }

    setToolTip(tooltip) {
        this.tooltip = tooltip;
    }

    setContextMenu(menu) {
        this.menu = menu;
    }

    setIgnoreDoubleClickEvents(flag) {
        this.ignoredDoubleClicks = flag;
    }

    destroy() {
        this.destroyed = true;
    }
}

class FakeNotification {
    constructor(options) {
        this.options = options;
        this.listeners = new Map();
        shown.push(this);
    }

    static isSupported() {
        return true;
    }

    on(name, listener) {
        this.listeners.set(name, listener);
        return this;
    }

    show() {
        this.wasShown = true;
    }
}

const fakeImage = {
    isEmpty: () => false,
    resize() {
        return this;
    },
    setTemplateImage() {},
};

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
    if (request === 'electron') {
        return {
            Tray: FakeTray,
            Menu: { buildFromTemplate: template => ({ template, on() {} }) },
            Notification: FakeNotification,
            nativeImage: { createFromDataURL: () => fakeImage, createEmpty: () => fakeImage },
            shell: { openExternal() {} },
            ipcMain: {
                handle(channel, handler) {
                    handlers.set(channel, handler);
                },
            },
            powerMonitor: { on() {} },
        };
    }
    return originalLoad(request, parent, isMain);
};

const menubar = require('../apps/desktop/menubar');
Module._load = originalLoad;
menubar.registerHandlers();

const { truncateTitle, trayTitle, nextTickDelay, menuTemplate, takePendingCommand, PENDING_TTL_MS, PENDING_CHANNEL } = menubar._testing;

const dueNow = (id, secondsAhead = 30) => {
    const start = new Date(Date.now() + secondsAhead * 1000);
    return {
        id,
        provider: 'google',
        title: `Event ${id}`,
        attendees: [
            { name: null, email: 'a@example.com' },
            { name: null, email: 'b@example.com' },
        ],
        start: start.toISOString(),
        end: new Date(start.getTime() + 45 * 60000).toISOString(),
    };
};

const labels = template => template.map(row => row.label ?? row.type);

const noop = () => {};
const actions = { openMain: noop, join: noop, record: noop, newNote: noop, newMeeting: noop, settings: noop };

afterEach(() => menubar.destroy());

test('truncateTitle trims a long title to the glyph budget with an ellipsis', () => {
    assert.equal(truncateTitle('Frontend Refactoring and Optimization', 24), 'Frontend Refactoring an…');
    assert.equal(truncateTitle('Standup', 24), 'Standup');
    assert.equal(truncateTitle('  spaced    out  ', 24), 'spaced out');
    assert.equal(truncateTitle('', 24), 'Meeting');
    assert.equal(truncateTitle(null, 24), 'Meeting');
});

test('truncateTitle counts code points so an emoji title is never split', () => {
    const cut = truncateTitle('👨‍👩‍👧‍👦👍🏽🎉🎉🎉 sync', 6);
    assert.equal([...cut].length, 6);
    assert.ok(cut.endsWith('…'));
});

test('trayTitle pairs the truncated title with the countdown, and is blank with no meeting', () => {
    assert.equal(trayTitle({ title: 'Frontend Refactoring and Optimization' }, 'in 1h 14m'), 'Frontend Refactoring an… • in 1h 14m');
    assert.equal(trayTitle(null, 'now'), '');
});

test('nextTickDelay lands just past the minute boundary and stays inside its clamp', () => {
    assert.equal(nextTickDelay(4_470_000), 30_250);
    assert.equal(nextTickDelay(120_000), 1_000);
    assert.equal(nextTickDelay(90_000), 5_000);
    assert.equal(nextTickDelay(15_000), 5_000);
    assert.equal(nextTickDelay(0), 30_000);
    assert.equal(nextTickDelay(NaN), 60_000);
    for (const ms of [91_000, 150_000, 3_600_000, 86_400_000]) {
        const delay = nextTickDelay(ms);
        assert.ok(delay >= 1_000 && delay <= 60_000, `${ms} produced ${delay}`);
    }
});

test('the menu leads with three disabled information rows and gives every action a click', () => {
    const template = menuTemplate(
        {
            event: { title: 'Frontend Refactoring and Optimization' },
            starts: 'Starts in 1h 12m',
            range: '17:00 – 17:45',
            link: 'https://meet.google.com/abc-defg-hij',
            version: '1.0.0',
            backendOnline: true,
        },
        actions
    );

    assert.deepEqual(labels(template).slice(0, 3), ['Starts in 1h 12m', 'Frontend Refactoring and Optimization', '17:00 – 17:45']);
    for (const row of template.slice(0, 3)) {
        assert.equal(row.enabled, false);
        assert.equal('click' in row, false);
    }
    for (const row of template) {
        if (row.enabled === false || row.type === 'separator' || row.role) continue;
        assert.equal(typeof row.click, 'function', `${row.label} has no click`);
    }
    assert.equal(template.at(-1).role, 'quit');
    assert.ok(labels(template).includes('Alpha 1.0.0'));
});

test('with no meeting the menu collapses to one row and drops join and record', () => {
    const template = menuTemplate(
        { event: null, starts: 'No upcoming meetings', range: '', link: null, version: '1.0.0', backendOnline: true },
        actions
    );
    const rows = labels(template);
    assert.equal(rows[0], 'No upcoming meetings');
    assert.equal(rows.filter(label => label === 'separator').length, 2);
    assert.equal(rows.includes('Join Meeting'), false);
    assert.equal(rows.includes('Record This Meeting'), false);
    assert.ok(rows.includes('New Meeting…'));
});

test('an offline backend says so rather than claiming the calendar is empty', () => {
    const template = menuTemplate(
        { event: null, starts: 'No upcoming meetings', range: '', link: null, version: '1.0.0', backendOnline: false },
        actions
    );
    assert.equal(labels(template)[0], 'Waiting for Alpha…');
});

test('a meeting with no join link omits the join row instead of greying it', () => {
    const template = menuTemplate(
        { event: { title: 'Focus' }, starts: 'Starts in 5m', range: '17:00', link: null, version: '1.0.0', backendOnline: true },
        actions
    );
    assert.equal(labels(template).includes('Join Meeting'), false);
    assert.ok(labels(template).includes('Record This Meeting'));
});

test('a notification click queues the recording when no window is there to receive it', async () => {
    menubar._testing.reset();
    shown.length = 0;

    const soon = dueNow('queued');
    const fetch = path => Promise.resolve(path === '/api/settings' ? { settings: {} } : { events: [soon] });
    menubar.create({ onActivateMain: noop, getMainWindow: () => null, version: '1.0.0', fetch });
    await menubar._testing.poll();
    menubar.destroy();

    assert.equal(shown.length, 1);
    shown[0].listeners.get('click')();

    const queued = takePendingCommand();
    assert.equal(queued.type, 'record');
    assert.equal(queued.event.id, 'queued');
    assert.equal(takePendingCommand(), null);
});

test('a queued command past its time to live is dropped rather than replayed late', async () => {
    menubar._testing.reset();
    shown.length = 0;

    const soon = dueNow('stale');
    const fetch = path => Promise.resolve(path === '/api/settings' ? { settings: {} } : { events: [soon] });
    menubar.create({ onActivateMain: noop, getMainWindow: () => null, version: '1.0.0', fetch });
    await menubar._testing.poll();
    menubar.destroy();

    shown[0].listeners.get('click')();
    assert.equal(takePendingCommand(Date.now() + PENDING_TTL_MS + 1), null);
});

test('the pending-command channel refuses a sender that is not the main window', async () => {
    const handler = handlers.get(PENDING_CHANNEL);
    assert.equal(typeof handler, 'function');
    assert.equal(await handler({ sender: { id: 'impostor' } }), null);
});

test('a reminder fires once per meeting and never twice for the same occurrence', async () => {
    menubar._testing.reset();
    shown.length = 0;
    trays = [];

    const soon = dueNow('soon');
    const fetch = path => Promise.resolve(path === '/api/settings' ? { settings: { meetingReminders: true } } : { events: [soon] });
    menubar.create({ onActivateMain: noop, getMainWindow: () => null, version: '1.0.0', fetch });
    await menubar._testing.poll();
    await menubar._testing.render();
    menubar.destroy();

    assert.equal(shown.length, 1);
    assert.match(shown[0].options.title, /Event soon/);
    assert.match(shown[0].options.body, /2 invited/);
});

test('turning the reminder preference off silences the notification', async () => {
    menubar._testing.reset();
    shown.length = 0;

    const soon = dueNow('quiet');
    const fetch = path => Promise.resolve(path === '/api/settings' ? { settings: { meetingReminders: false } } : { events: [soon] });
    menubar.create({ onActivateMain: noop, getMainWindow: () => null, version: '1.0.0', fetch });
    await menubar._testing.poll();
    menubar.destroy();

    assert.equal(shown.length, 0);
});

test('an absent preference still counts as on, because the default lives in the renderer', async () => {
    menubar._testing.reset();
    shown.length = 0;

    const soon = dueNow('default-on');
    const fetch = path => Promise.resolve(path === '/api/settings' ? { settings: {} } : { events: [soon] });
    menubar.create({ onActivateMain: noop, getMainWindow: () => null, version: '1.0.0', fetch });
    await menubar._testing.poll();
    menubar.destroy();

    assert.equal(shown.length, 1);
});

test('an unreachable backend keeps the last known schedule instead of blanking it', async () => {
    menubar._testing.reset();

    const soon = dueNow('kept', 1800);
    let online = true;
    const fetch = path => {
        if (!online) return Promise.resolve(null);
        return Promise.resolve(path === '/api/settings' ? { settings: {} } : { events: [soon] });
    };

    menubar.create({ onActivateMain: noop, getMainWindow: () => null, version: '1.0.0', fetch });
    await menubar._testing.poll();
    assert.equal(menubar._testing.state().events.length, 1);

    online = false;
    await menubar._testing.poll();
    assert.equal(menubar._testing.state().backendOnline, false);
    assert.equal(menubar._testing.state().events.length, 1);
    menubar.destroy();
});

test('the menu bar title carries the countdown in monospaced digits so it stops twitching', async t => {
    if (process.platform !== 'darwin') return t.skip('setTitle is macOS only');
    menubar._testing.reset();
    trays = [];

    const soon = dueNow('titled', 4_440);
    const fetch = path => Promise.resolve(path === '/api/settings' ? { settings: {} } : { events: [soon] });
    menubar.create({ onActivateMain: noop, getMainWindow: () => null, version: '1.0.0', fetch });
    await menubar._testing.poll();

    const tray = trays.at(-1);
    assert.match(tray.title, /^Event titled • in 1h 1[34]m$/);
    assert.deepEqual(tray.titleOptions, { fontType: 'monospacedDigit' });
    assert.equal(tray.ignoredDoubleClicks, true);
    assert.deepEqual(labels(tray.menu.template).slice(1, 2), ['Event titled']);

    menubar.destroy();
    assert.equal(tray.destroyed, true);
});

test('creating the menu bar starts the countdown loop and destroying it stops both timers', async () => {
    menubar._testing.reset();

    const soon = dueNow('ticking', 4_440);
    const fetch = path => Promise.resolve(path === '/api/settings' ? { settings: {} } : { events: [soon] });
    menubar.create({ onActivateMain: noop, getMainWindow: () => null, version: '1.0.0', fetch });

    assert.equal(menubar._testing.state().ticking, true, 'the countdown never started');
    assert.equal(menubar._testing.state().polling, true);

    menubar.destroy();
    assert.equal(menubar._testing.state().ticking, false);
    assert.equal(menubar._testing.state().polling, false);
});
