const DEFAULT_PORT = 48900;
const DEFAULTS = { port: DEFAULT_PORT, enabled: true, activityFallback: true };
const STALE_MS = 15000;
// Observations are serialized so a stale snapshot can never land after a
// newer one. The queue is capped for ordinary reports, but a report that
// carries the end of the meeting is always let through.
const MAX_QUEUE = 10;

let queued = 0;
let queue = Promise.resolve();

function backendUrl(port, path) {
    return `http://127.0.0.1:${port}${path}`;
}

async function settings() {
    return chrome.storage.local.get(DEFAULTS);
}

function sessionArea() {
    return chrome.storage.session || chrome.storage.local;
}

async function remember(report) {
    await sessionArea().set({ report });
}

async function lastReport() {
    const stored = await sessionArea().get({ report: null });
    return stored.report;
}

async function badge(state) {
    const colours = { on: '#16a34a', idle: '#64748b', error: '#dc2626', off: '#94a3b8' };
    const text = { on: '●', idle: '○', error: '!', off: '' };
    await chrome.action.setBadgeBackgroundColor({ color: colours[state] || colours.idle });
    await chrome.action.setBadgeText({ text: text[state] ?? '' });
}

async function sendReport(payload, sender) {
    const { port, enabled } = await settings();
    if (!enabled) {
        await badge('off');
        return { ok: false, reason: 'paused' };
    }
    try {
        const response = await fetch(backendUrl(port, '/api/session/participants'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });
        const data = response.ok ? await response.json() : { error: `backend replied ${response.status}` };
        await remember({ ...payload, ...data, tabId: sender?.tab?.id ?? null, at: Date.now() });
        await badge(data.accepted ? 'on' : 'idle');
        return { ok: response.ok, ...data };
    } catch (cause) {
        await remember({
            ...payload,
            error: `the Alpha backend is not answering on port ${port}`,
            detail: String(cause?.message || cause),
            tabId: sender?.tab?.id ?? null,
            at: Date.now(),
        });
        await badge('error');
        return { ok: false, error: String(cause?.message || cause) };
    }
}

function report(payload, sender) {
    if (queued >= MAX_QUEUE && !payload?.ended) {
        return Promise.resolve({ ok: false, reason: 'busy' });
    }
    queued += 1;
    const run = queue.then(() => sendReport(payload, sender));
    queue = run.then(() => {}, () => {});
    return run.finally(() => {
        queued -= 1;
    });
}

async function status() {
    const stored = await settings();
    const report = await lastReport();
    return {
        settings: stored,
        report,
        stale: !report || Date.now() - report.at > STALE_MS,
    };
}

async function probe() {
    const { port } = await settings();
    try {
        const response = await fetch(backendUrl(port, '/api/status'));
        if (!response.ok) return { ok: false, error: `backend replied ${response.status}` };
        const data = await response.json();
        return { ok: true, state: data.state, meetingTitle: data.meetingTitle, participants: data.participants };
    } catch (cause) {
        return { ok: false, error: String(cause?.message || cause) };
    }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type === 'alpha:observation') {
        report(message.payload, sender).then(sendResponse);
        return true;
    }
    if (message?.type === 'alpha:status') {
        status().then(sendResponse);
        return true;
    }
    if (message?.type === 'alpha:probe') {
        probe().then(sendResponse);
        return true;
    }
    return false;
});

chrome.runtime.onInstalled.addListener(async () => {
    const stored = await settings();
    await chrome.storage.local.set(stored);
    await badge(stored.enabled ? 'idle' : 'off');
});
