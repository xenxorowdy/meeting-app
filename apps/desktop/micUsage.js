const { ipcMain } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const HELPER_NAME = 'mic-watch';
const EVENT_CHANNEL = 'mic-usage:event';
// A microphone that stays open this long is a call rather than a Siri tap or
// a dictation blip; that is the whole difference between an event and noise.
const ACTIVE_AFTER_MS = 8000;
// Brief dropouts — a device switch, a call restarting — must not flap the
// reported state, so going quiet is confirmed a little sooner than going live.
const INACTIVE_AFTER_MS = 1500;

/**
 * The watcher reports raw transitions; callers only care about sustained
 * ones. This turns `active`/`inactive` lines into debounced emissions:
 * nothing fires until the microphone has been live for ACTIVE_AFTER_MS, and
 * a retraction waits out INACTIVE_AFTER_MS in case the dropout is momentary.
 */
function createDebounce({ onEmit, activeAfterMs, inactiveAfterMs, setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout }) {
    let timer = null;
    let emitted = false;

    return {
        line(text) {
            if (timer) {
                clearTimeoutFn(timer);
                timer = null;
            }
            if (text === 'active') {
                if (emitted) return;
                timer = setTimeoutFn(() => {
                    timer = null;
                    emitted = true;
                    onEmit(true);
                }, activeAfterMs);
            } else if (text === 'inactive' && emitted) {
                timer = setTimeoutFn(() => {
                    timer = null;
                    emitted = false;
                    onEmit(false);
                }, inactiveAfterMs);
            }
        },
        isEmitted: () => emitted,
        reset() {
            if (timer) clearTimeoutFn(timer);
            timer = null;
            emitted = false;
        },
    };
}

function helperPath() {
    if (process.env.ALPHA_MIC_WATCH_PATH) return process.env.ALPHA_MIC_WATCH_PATH;
    const packaged = process.resourcesPath ? path.join(process.resourcesPath, HELPER_NAME) : null;
    if (packaged && fs.existsSync(packaged)) return packaged;
    return path.join(__dirname, 'assets', HELPER_NAME);
}

function availability(platform = process.platform) {
    if (platform !== 'darwin') {
        return {
            available: false,
            platform,
            reason: 'Watching microphone use from every app needs the macOS helper.',
        };
    }
    const helper = helperPath();
    if (!fs.existsSync(helper)) {
        return { available: false, platform, reason: `The microphone watcher is missing from this build (${helper}).` };
    }
    return { available: true, platform, reason: null };
}

let child = null;
let target = null;
let debounce = null;

function send(active) {
    if (!target || target.isDestroyed?.()) return;
    target.send(EVENT_CHANNEL, { active, at: Date.now() });
}

function stop() {
    debounce?.reset();
    if (!child) return { stopped: false };
    const running = child;
    child = null;
    target = null;
    running.stdout?.removeAllListeners('data');
    running.removeAllListeners('close');
    try {
        running.kill('SIGTERM');
    } catch {
        return { stopped: false };
    }
    return { stopped: true };
}

function start(sender, { spawnFn = spawn } = {}) {
    const state = availability();
    if (!state.available) return Promise.resolve({ started: false, reason: state.reason });

    // Re-targeting an already-running watcher is the whole start contract:
    // the renderer subscribes on mount and must learn the current state even
    // if no transition ever comes.
    if (child) {
        target = sender;
        if (debounce?.isEmitted()) send(true);
        return Promise.resolve({ started: true, helper: child.helperPath });
    }

    const helper = helperPath();
    const started = spawnFn(helper, [], { stdio: ['pipe', 'pipe', 'pipe'] });
    if (!started || (!started.pid && started.pid !== 0)) {
        return Promise.resolve({ started: false, reason: `The microphone watcher did not start (${helper}).` });
    }
    started.helperPath = helper;
    child = started;
    target = sender;
    debounce = createDebounce({ onEmit: send, activeAfterMs: ACTIVE_AFTER_MS, inactiveAfterMs: INACTIVE_AFTER_MS });

    let carry = '';
    started.stdout.on('data', data => {
        carry += String(data);
        const lines = carry.split('\n');
        carry = lines.pop() || '';
        for (const line of lines) {
            if (line.trim()) debounce.line(line.trim());
        }
    });

    started.stderr.on('data', data => {
        const text = String(data).trim();
        if (text) console.error(`[Alpha] ${HELPER_NAME}: ${text}`);
    });

    started.on('error', cause => {
        if (child === started) child = null;
        console.error(`[Alpha] the microphone watcher failed: ${cause.message}`);
    });

    started.on('close', () => {
        if (child === started) {
            child = null;
            target = null;
            debounce?.reset();
            debounce = null;
        }
    });

    sender?.once?.('destroyed', () => {
        if (target === sender) target = null;
    });

    return Promise.resolve({ started: true, helper });
}

function registerHandlers() {
    ipcMain.handle('mic-usage:available', () => {
        const state = availability();
        return { available: state.available, platform: state.platform, reason: state.reason };
    });
    ipcMain.handle('mic-usage:start', event => start(event.sender));
    ipcMain.handle('mic-usage:stop', () => stop());
}

module.exports = {
    EVENT_CHANNEL,
    ACTIVE_AFTER_MS,
    INACTIVE_AFTER_MS,
    availability,
    createDebounce,
    registerHandlers,
    start,
    stop,
    shutdown: stop,
    _testing: {
        helperPath,
        isRunning: () => Boolean(child),
        activeTarget: () => target,
    },
};
