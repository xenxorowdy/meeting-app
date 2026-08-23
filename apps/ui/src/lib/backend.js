const DEFAULT_BACKEND_URL = 'http://127.0.0.1:48900';

export const BACKEND_URL = (import.meta.env?.VITE_BACKEND_URL || DEFAULT_BACKEND_URL).replace(/\/+$/, '');
export const BACKEND_WS_URL = `${BACKEND_URL.replace(/^http/, 'ws')}/ws`;

export const STREAM_MIC = 0;
export const STREAM_SYSTEM = 1;

const PACKET_HEADER_SIZE = 16;

export class BackendError extends Error {
    constructor(message, status) {
        super(message);
        this.name = 'BackendError';
        this.status = status;
    }
}

async function parseResponse(response) {
    const text = await response.text();
    if (!text) return {};
    try {
        return JSON.parse(text);
    } catch {
        return { raw: text };
    }
}

export async function apiRequest(path, { method = 'GET', body, signal } = {}) {
    let response;
    try {
        response = await fetch(`${BACKEND_URL}${path}`, {
            method,
            headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
            body: body === undefined ? undefined : JSON.stringify(body),
            signal,
        });
    } catch (cause) {
        throw new BackendError(`Cannot reach the backend at ${BACKEND_URL}`, 0);
    }

    const data = await parseResponse(response);
    if (!response.ok) {
        throw new BackendError(data.error || `${method} ${path} failed with ${response.status}`, response.status);
    }
    return data;
}

export async function apiText(path, { signal } = {}) {
    const response = await fetch(`${BACKEND_URL}${path}`, { signal });
    if (!response.ok) {
        throw new BackendError(`GET ${path} failed with ${response.status}`, response.status);
    }
    return response.text();
}

/**
 * Frame PCM for the backend's 16-byte little-endian audio packet protocol:
 * u32 streamId, i64 timestampMs, u32 payloadLength, then signed 16-bit LE samples.
 */
export function encodeAudioPacket(streamId, timestampMs, pcm) {
    const payload = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
    const packet = new ArrayBuffer(PACKET_HEADER_SIZE + payload.byteLength);
    const view = new DataView(packet);

    view.setUint32(0, streamId, true);
    view.setBigInt64(4, BigInt(Math.trunc(timestampMs)), true);
    view.setUint32(12, payload.byteLength, true);
    new Uint8Array(packet, PACKET_HEADER_SIZE).set(payload);

    return packet;
}

const RECONNECT_DELAYS_MS = [500, 1000, 2000, 4000, 8000];

/**
 * WebSocket to the core backend. Reconnects on its own so the UI can report a
 * truthful connection state instead of pretending a session is live.
 */
export function createBackendSocket({ onEvent, onConnectionChange } = {}) {
    let socket = null;
    let attempt = 0;
    let reconnectTimer = null;
    let disposed = false;

    const notify = state => {
        if (onConnectionChange) onConnectionChange(state);
    };

    const scheduleReconnect = () => {
        if (disposed) return;
        const delay = RECONNECT_DELAYS_MS[Math.min(attempt, RECONNECT_DELAYS_MS.length - 1)];
        attempt += 1;
        reconnectTimer = setTimeout(connect, delay);
    };

    function connect() {
        if (disposed) return;
        notify('connecting');

        try {
            socket = new WebSocket(BACKEND_WS_URL);
        } catch {
            scheduleReconnect();
            return;
        }

        socket.binaryType = 'arraybuffer';

        socket.onopen = () => {
            attempt = 0;
            notify('online');
        };

        socket.onmessage = event => {
            if (typeof event.data !== 'string') return;
            try {
                const message = JSON.parse(event.data);
                if (onEvent) onEvent(message);
            } catch {
                // A malformed frame is not worth tearing the session down for.
            }
        };

        socket.onclose = () => {
            socket = null;
            notify('offline');
            scheduleReconnect();
        };

        socket.onerror = () => {
            notify('offline');
        };
    }

    connect();

    const isOpen = () => Boolean(socket) && socket.readyState === WebSocket.OPEN;

    return {
        isOpen,
        send(action, payload = {}) {
            if (!isOpen()) return false;
            socket.send(JSON.stringify({ action, payload }));
            return true;
        },
        sendAudio(streamId, pcm, timestampMs = Date.now()) {
            if (!isOpen()) return false;
            socket.send(encodeAudioPacket(streamId, timestampMs, pcm));
            return true;
        },
        close() {
            disposed = true;
            if (reconnectTimer) clearTimeout(reconnectTimer);
            if (socket) {
                socket.onclose = null;
                socket.close();
                socket = null;
            }
        },
    };
}

/**
 * The backend reports uppercase engine states; the UI works in its own vocabulary.
 */
export const BACKEND_STATE_MAP = {
    IDLE: 'idle',
    STARTING: 'processing',
    RECORDING: 'recording',
    PAUSED: 'paused',
    PROCESSING_STT: 'processing',
    SUMMARIZING: 'processing',
    COMPLETED: 'completed',
    ERROR: 'error',
};

export function mapBackendState(state) {
    return BACKEND_STATE_MAP[state] || 'idle';
}

/**
 * Backend transcript turns use `channel`; the views were written against `stream`.
 */
export function normalizeTurn(turn, index = 0) {
    const stream = turn.stream || turn.channel || 'system';
    // The physical channel is authoritative. A stale speaker label must never
    // make system audio appear as the local user (or vice versa).
    const speaker = stream === 'mic' ? 'You' : turn.speaker === 'You' ? 'Speaker 1' : turn.speaker || 'Speaker 1';
    return {
        id: turn.id || `turn-${index}-${turn.startMs ?? 0}`,
        speaker,
        stream,
        startMs: turn.startMs ?? 0,
        endMs: turn.endMs ?? turn.startMs ?? 0,
        text: (turn.text || '').trim(),
        confidence: turn.confidence,
        // What the engine decoded this turn in. Absent on meetings recorded
        // before the backend reported it.
        language: turn.language || null,
    };
}

export function normalizeMeeting(meeting) {
    if (!meeting) return null;
    const transcript = Array.isArray(meeting.transcript) ? meeting.transcript.map(normalizeTurn) : [];
    const participants = Array.from(new Set(transcript.map(turn => turn.speaker)));

    return {
        ...meeting,
        transcript,
        participants,
        actionItems: Array.isArray(meeting.actionItems) ? meeting.actionItems : [],
        keyDecisions: Array.isArray(meeting.keyDecisions) ? meeting.keyDecisions : [],
        summaryMarkdown: meeting.summaryMarkdown || '',
        // The screen recording descriptor, when the shell made one.
        recording: meeting.recording || null,
    };
}
