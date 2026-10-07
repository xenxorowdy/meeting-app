// Isolated widget fixture. Never connects to a real meeting or backend.
const meeting = { id: 'widget-fixture', title: 'Friday product sync', startedAt: Date.now() - 325000 };

window.fixtureRequests = [];
window.fixtureCommands = [];
window.fixturePromptCommands = [];
// Only the prompt's 15-second motion timer is controlled; chat fixtures keep real time.
const nativeTimeout = window.setTimeout.bind(window);
const nativeClearTimeout = window.clearTimeout.bind(window);
const motionTimers = new Map();
let motionTimerId = 1_000_000;
window.setTimeout = (fn, ms, ...args) => {
    if (ms >= 14000 && ms <= 15100) { const id = ++motionTimerId; motionTimers.set(id, () => fn(...args)); return id; }
    return nativeTimeout(fn, ms, ...args);
};
window.clearTimeout = id => { if (!motionTimers.delete(id)) nativeClearTimeout(id); };
window.fixtureFireWobble = () => { const callbacks = [...motionTimers.values()]; motionTimers.clear(); callbacks.forEach(fn => fn()); };
window.fixtureMotionTimerCount = () => motionTimers.size;
let shellHandler;
let shellState = { sessionState: 'recording', title: meeting.title, canControl: true, micMuted: false, systemAudioMuted: false };
window.fixtureSetState = patch => { shellState = { ...shellState, ...patch }; shellHandler?.(shellState); };
window.kesamiConnection = { get: () => ({ url: 'http://127.0.0.1:48900', token: '' }) };
window.kesamiWidget = {
    onState: handler => {
        shellHandler = handler;
        setTimeout(() => handler(shellState), 20);
        return () => { shellHandler = null; };
    },
    setExpanded: () => {},
    openMain: () => {},
    hide: () => {},
    sendCommand: (action, promptId) => {
        if (promptId) window.fixturePromptCommands.push({ action, promptId });
        else window.fixtureCommands.push(action);
        return true;
    },
};

window.WebSocket = class {
    constructor() {
        window.fixtureEvent = (type, data) => this.onmessage?.({ data: JSON.stringify({ type, data }) });
        window.fixtureDisconnect = () => this.onerror?.();
        window.fixtureReconnect = () => this.onopen?.();
        setTimeout(() => {
            this.onopen?.();
            this.onmessage?.({ data: JSON.stringify({ type: 'meeting_started', data: meeting }) });
            this.onmessage?.({ data: JSON.stringify({ type: 'transcript_turn', data: { id: 'turn-1', speaker: 'Maya', text: 'We agreed to ship the new search by Friday.', startMs: 10000, stream: 'system' } }) });
        }, 40);
    }
    close() {}
};

window.fetch = async (url, options = {}) => {
    const path = new URL(url).pathname;
    const body = options.body ? JSON.parse(options.body) : null;
    window.fixtureRequests.push({ path, method: options.method || 'GET', body });
    let data = {};
    if (path === '/api/chat/threads') {
        if (!body && window.fixtureThreadDelay) await new Promise(resolve => setTimeout(resolve, window.fixtureThreadDelay));
        data = body ? { id: 'widget-thread', scope: body.scope } : { threads: [] };
    }
    if (path === '/api/chat/index/status') data = { mode: 'keyword' };
    if (path === '/api/chat/threads/widget-thread/messages') {
        if (body) await new Promise(resolve => setTimeout(resolve, window.fixtureAnswerDelay || 150));
        if (body && window.fixtureChatError) return new Response(JSON.stringify({ error: window.fixtureChatError }), { status: 503, headers: { 'Content-Type': 'application/json' } });
        data = { answer: 'The team agreed to ship the new search by Friday [1].',
            citations: [{ number: 1, title: meeting.title, excerpt: 'We agreed to ship the new search by Friday.', startMs: 10000 }],
            coverage: { live: true, capturedThroughMs: 15000 } };
    }
    return new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
};
