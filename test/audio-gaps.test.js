const assert = require('node:assert/strict');
const { test } = require('node:test');
const load = () => import('../apps/ui/src/lib/backend.js');

function fakeSockets() {
    const sockets = [];
    class FakeSocket {
        static OPEN = 1;

        constructor() {
            this.readyState = 0;
            this.bufferedAmount = 0;
            this.sent = [];
            sockets.push(this);
        }

        open() {
            this.readyState = FakeSocket.OPEN;
            this.onopen?.();
        }

        send(packet) {
            this.sent.push(packet);
        }

        close() {}
    }
    return { FakeSocket, sockets };
}

function decode(packet) {
    const view = new DataView(packet);
    const length = view.getUint32(12, true);
    return {
        stream: view.getUint32(0, true),
        timestamp: Number(view.getBigInt64(4, true)),
        length,
        skipped: length === 4 ? view.getUint32(16, true) : null,
    };
}

async function withSocket(run) {
    const { FakeSocket, sockets } = fakeSockets();
    const previous = globalThis.WebSocket;
    globalThis.WebSocket = FakeSocket;
    const { createBackendSocket } = await load();
    const backend = createBackendSocket({});
    try {
        await run({ backend, socket: sockets[0], sockets });
    } finally {
        backend.close();
        globalThis.WebSocket = previous;
    }
}

test('muted audio is reported as one gap packet ahead of the next audio on that stream', async () => {
    const { STREAM_MIC, STREAM_SYSTEM, GAP_FLAG } = await load();
    await withSocket(async ({ backend, socket }) => {
        socket.open();
        backend.skipAudio(STREAM_MIC, 128);
        backend.skipAudio(STREAM_MIC, 128);
        backend.sendAudio(STREAM_SYSTEM, new Int16Array(64), 1_000);
        backend.sendAudio(STREAM_MIC, new Int16Array(32), 1_010);
        backend.sendAudio(STREAM_MIC, new Int16Array(32), 1_020);

        assert.deepEqual(socket.sent.map(decode), [
            { stream: STREAM_SYSTEM, timestamp: 1_000, length: 128, skipped: null },
            { stream: (STREAM_MIC | GAP_FLAG) >>> 0, timestamp: 1_010, length: 4, skipped: 256 },
            { stream: STREAM_MIC, timestamp: 1_010, length: 64, skipped: null },
            { stream: STREAM_MIC, timestamp: 1_020, length: 64, skipped: null },
        ]);
    });
});

test('audio dropped for a closed or backed-up socket is reported as a gap once it can be sent', async () => {
    const { STREAM_MIC, GAP_FLAG } = await load();
    await withSocket(async ({ backend, socket }) => {
        assert.equal(backend.sendAudio(STREAM_MIC, new Int16Array(100), 1_000), false);
        socket.open();
        socket.bufferedAmount = 512 * 1024;
        assert.equal(backend.sendAudio(STREAM_MIC, new Int16Array(50), 1_010), false);
        socket.bufferedAmount = 0;
        assert.equal(backend.sendAudio(STREAM_MIC, new Int16Array(10), 1_020), true);

        assert.deepEqual(socket.sent.map(decode), [
            { stream: (STREAM_MIC | GAP_FLAG) >>> 0, timestamp: 1_020, length: 4, skipped: 150 },
            { stream: STREAM_MIC, timestamp: 1_020, length: 20, skipped: null },
        ]);
    });
});
