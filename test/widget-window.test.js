const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

const WORK_AREA = { x: 0, y: 25, width: 1440, height: 875 };

const handlers = new Map();
const windows = [];

class FakeWindow {
    constructor(options) {
        this.options = options;
        this.bounds = { x: options.x, y: options.y, width: options.width, height: options.height };
        this.webContents = { id: windows.length + 1 };
        this.destroyed = false;
        this.visible = false;
        this.focusStolen = false;
        this.alwaysOnTop = null;
        this.workspaces = null;
        this.loaded = null;
        this.events = new Map();
        windows.push(this);
    }

    isDestroyed() {
        return this.destroyed;
    }

    getBounds() {
        return { ...this.bounds };
    }

    setBounds(next) {
        this.bounds = { ...next };
    }

    setAlwaysOnTop(flag, level) {
        this.alwaysOnTop = { flag, level };
    }

    setVisibleOnAllWorkspaces(flag, options) {
        this.workspaces = { flag, options };
    }

    on(name, listener) {
        this.events.set(name, listener);
    }

    once(name, listener) {
        this.events.set(name, listener);
    }

    emit(name) {
        this.events.get(name)?.();
    }

    loadURL(url) {
        this.loaded = url;
    }

    loadFile(file) {
        this.loaded = file;
    }

    showInactive() {
        this.visible = true;
    }

    show() {
        this.visible = true;
        this.focusStolen = true;
    }

    hide() {
        this.visible = false;
    }

    destroy() {
        this.destroyed = true;
        this.visible = false;
    }
}

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
    if (request === 'electron') {
        return {
            BrowserWindow: FakeWindow,
            ipcMain: {
                handle(channel, handler) {
                    handlers.set(channel, handler);
                },
            },
            screen: {
                getPrimaryDisplay: () => ({ workArea: WORK_AREA }),
                getDisplayMatching: () => ({ workArea: WORK_AREA }),
            },
        };
    }
    return originalLoad(request, parent, isMain);
};

const widget = require('../apps/desktop/widget');
Module._load = originalLoad;
widget.registerHandlers();

const { COLLAPSED, EXPANDED, SCREEN_MARGIN, cornerBounds } = widget._testing;

function open(onActivateMain = () => {}) {
    widget.destroy();
    const created = widget.create({ devUrl: null, distFile: '/dist/widget.html', preload: '/pre.js', onActivateMain });
    created.emit('ready-to-show');
    return created;
}

const invoke = (channel, sender, arg) => handlers.get(channel)({ sender }, arg);

test('expanding pins the bottom-right corner so the panel grows up and left', () => {
    const before = { x: 900, y: 700, width: COLLAPSED.width, height: COLLAPSED.height };
    const after = cornerBounds(before, WORK_AREA, EXPANDED);

    assert.equal(after.x + after.width, before.x + before.width);
    assert.equal(after.y + after.height, before.y + before.height);
    assert.equal(after.width, EXPANDED.width);
    assert.equal(after.height, EXPANDED.height);
});

test('expanding near an edge clamps inside the work area instead of going off-screen', () => {
    const nearTopLeft = { x: 4, y: WORK_AREA.y + 4, width: COLLAPSED.width, height: COLLAPSED.height };
    const after = cornerBounds(nearTopLeft, WORK_AREA, EXPANDED);

    assert.ok(after.x >= WORK_AREA.x + SCREEN_MARGIN, `x was ${after.x}`);
    assert.ok(after.y >= WORK_AREA.y + SCREEN_MARGIN, `y was ${after.y}`);
    assert.ok(after.x + after.width <= WORK_AREA.x + WORK_AREA.width - SCREEN_MARGIN);
    assert.ok(after.y + after.height <= WORK_AREA.y + WORK_AREA.height - SCREEN_MARGIN);
});

test('a work area smaller than the expanded panel still yields a reachable origin', () => {
    const tiny = { x: 0, y: 0, width: 320, height: 240 };
    const after = cornerBounds({ x: 0, y: 0, width: COLLAPSED.width, height: COLLAPSED.height }, tiny, EXPANDED);

    assert.equal(after.x, tiny.x + SCREEN_MARGIN);
    assert.equal(after.y, tiny.y + SCREEN_MARGIN);
});

test('the widget opens without stealing focus and survives a full-screen call', () => {
    const created = open();

    assert.equal(created.visible, true);
    assert.equal(created.focusStolen, false);
    assert.deepEqual(created.alwaysOnTop, { flag: true, level: 'floating' });
    assert.deepEqual(created.workspaces, { flag: true, options: { visibleOnFullScreen: true } });
    assert.equal(created.options.skipTaskbar, true);
    assert.equal(created.options.webPreferences.contextIsolation, true);
    assert.equal(created.options.webPreferences.nodeIntegration, false);
});

test('window-scoped channels refuse a sender that is not the widget', () => {
    const created = open();
    const impostor = { id: 'some-other-page' };

    assert.equal(invoke('widget:set-expanded', impostor, true), false);
    assert.equal(invoke('widget:hide', impostor), false);
    assert.equal(invoke('widget:open-main', impostor), false);
    assert.equal(created.bounds.width, COLLAPSED.width, 'geometry must not change');
    assert.equal(created.visible, true, 'an impostor must not be able to hide the indicator');
});

test('the widget expands and collapses on its own request', () => {
    const created = open();

    assert.equal(invoke('widget:set-expanded', created.webContents, true), true);
    assert.equal(created.bounds.height, EXPANDED.height);

    assert.equal(invoke('widget:set-expanded', created.webContents, false), false);
    assert.equal(created.bounds.height, COLLAPSED.height);
});

test('opening the main window from the widget goes through the shell callback', () => {
    let activated = 0;
    const created = open(() => (activated += 1));

    invoke('widget:open-main', created.webContents);
    assert.equal(activated, 1);
});

test('re-enabling the preference clears a dismissal from earlier in the session', () => {
    const created = open();

    invoke('widget:hide', created.webContents);
    assert.equal(created.visible, false);

    // Turning the preference off and on again is the only way back: otherwise the
    // toggle would look broken to anyone who had closed the widget by hand.
    invoke('widget:set-visible', created.webContents, false);
    assert.equal(created.visible, false);
    invoke('widget:set-visible', created.webContents, true);
    assert.equal(created.visible, true);
});

test('the preference hides the widget without destroying it', () => {
    const created = open();

    invoke('widget:set-visible', created.webContents, false);
    assert.equal(created.visible, false);
    assert.equal(created.isDestroyed(), false);
    assert.equal(widget.isOpen(), true);

    invoke('widget:set-visible', created.webContents, true);
    assert.equal(created.visible, true);
});

test('destroy closes the window so it cannot hold the app open at quit', () => {
    const created = open();
    widget.destroy();

    assert.equal(created.isDestroyed(), true);
    assert.equal(widget.isOpen(), false);
});
