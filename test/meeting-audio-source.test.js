const assert = require('node:assert/strict');
const { test } = require('node:test');

const load = () => import('../apps/ui/src/lib/systemCapture.js');

function fakeBridge({ available = true, reason = null } = {}) {
    const bridge = {
        data: new Set(),
        status: new Set(),
        started: 0,
        stopped: 0,
        available: async () => ({ available, platform: 'darwin', reason }),
        start: async () => {
            bridge.started += 1;
            return { started: true };
        },
        stop: async () => {
            bridge.stopped += 1;
            return { stopped: true };
        },
        onData(listener) {
            bridge.data.add(listener);
            return () => bridge.data.delete(listener);
        },
        onStatus(listener) {
            bridge.status.add(listener);
            return () => bridge.status.delete(listener);
        },
        emit(bytes) {
            for (const listener of bridge.data) listener(bytes);
        },
        emitStatus(status) {
            for (const listener of bridge.status) listener(status);
        },
    };
    return bridge;
}

function fakeDevices(devices) {
    return {
        enumerateDevices: async () => devices,
        getUserMedia: async constraints => {
            const error = new Error('requested');
            error.constraints = constraints;
            throw error;
        },
    };
}

function withGlobals({ bridge, devices }, run) {
    const previousBridge = globalThis.alphaSystemAudio;
    const previousNavigator = globalThis.navigator;
    globalThis.alphaSystemAudio = bridge;
    if (devices) Object.defineProperty(globalThis, 'navigator', { value: { mediaDevices: devices }, configurable: true, writable: true });
    return run().finally(() => {
        globalThis.alphaSystemAudio = previousBridge;
        if (devices) Object.defineProperty(globalThis, 'navigator', { value: previousNavigator, configurable: true, writable: true });
    });
}

const pcmBytes = samples => {
    const view = new Int16Array(samples);
    return new Uint8Array(view.buffer);
};

test('the native helper is preferred and its bytes arrive as 16-bit samples', async () => {
    const { startSystemCapture } = await load();
    const bridge = fakeBridge();

    await withGlobals({ bridge }, async () => {
        const heard = [];
        const capture = await startSystemCapture({ onPcm: pcm => heard.push(pcm) });

        assert.equal(capture.source, 'native');
        assert.equal(bridge.started, 1);

        bridge.emit(pcmBytes([120, -4000, 32000]));
        assert.equal(heard.length, 1);
        assert.ok(heard[0] instanceof Int16Array);
        assert.deepEqual(Array.from(heard[0]), [120, -4000, 32000]);

        await capture.stop();
        assert.equal(bridge.stopped, 1);
        bridge.emit(pcmBytes([1]));
        assert.equal(heard.length, 1, 'a stopped capture must not keep forwarding');
    });
});

test('muted meeting audio forwards silence so the level meter reads zero', async () => {
    const { startSystemCapture } = await load();
    const bridge = fakeBridge();

    await withGlobals({ bridge }, async () => {
        const heard = [];
        const capture = await startSystemCapture({ onPcm: pcm => heard.push(pcm), muted: true });

        bridge.emit(pcmBytes([9000, -9000]));
        assert.deepEqual(Array.from(heard[0]), [0, 0]);

        capture.setMuted(false);
        bridge.emit(pcmBytes([9000, -9000]));
        assert.deepEqual(Array.from(heard[1]), [9000, -9000]);

        await capture.stop();
    });
});

test('a helper that loses permission reports it instead of going quiet', async () => {
    const { startSystemCapture } = await load();
    const bridge = fakeBridge();

    await withGlobals({ bridge }, async () => {
        const failures = [];
        const capture = await startSystemCapture({ onPcm: () => {}, onError: message => failures.push(message) });

        bridge.emitStatus({ state: 'error', message: 'Screen Recording permission is required.' });
        assert.deepEqual(failures, ['Screen Recording permission is required.']);

        await capture.stop();
    });
});

test('without the helper a loopback input device is used instead', async () => {
    const { startSystemCapture } = await load();
    const bridge = fakeBridge({ available: false, reason: 'no helper on this platform' });
    const devices = fakeDevices([
        { kind: 'audioinput', deviceId: 'mic-1', label: 'MacBook Pro Microphone' },
        { kind: 'audioinput', deviceId: 'loop-1', label: 'BlackHole 2ch' },
        { kind: 'audiooutput', deviceId: 'out-1', label: 'Speakers' },
    ]);

    await withGlobals({ bridge, devices }, async () => {
        const failure = await startSystemCapture({ onPcm: () => {} }).then(
            () => null,
            cause => cause
        );

        assert.equal(failure.message, 'requested');
        assert.deepEqual(failure.constraints.audio.deviceId, { exact: 'loop-1' });
        assert.equal(failure.constraints.audio.echoCancellation, false, 'loopback audio must not be processed as if it were a microphone');
        assert.equal(bridge.started, 0);
    });
});

test('an explicitly chosen device wins over the native helper', async () => {
    const { startSystemCapture } = await load();
    const bridge = fakeBridge();
    const devices = fakeDevices([{ kind: 'audioinput', deviceId: 'cable-1', label: 'VB-Cable Output' }]);

    await withGlobals({ bridge, devices }, async () => {
        const failure = await startSystemCapture({ onPcm: () => {}, deviceId: 'cable-1' }).then(
            () => null,
            cause => cause
        );

        assert.deepEqual(failure.constraints.audio.deviceId, { exact: 'cable-1' });
        assert.equal(bridge.started, 0);
    });
});

test('with no helper and no loopback device the reason is reported', async () => {
    const { startSystemCapture, systemAudioAvailability } = await load();
    const bridge = fakeBridge({ available: false, reason: 'no helper on this platform' });
    const devices = fakeDevices([{ kind: 'audioinput', deviceId: 'mic-1', label: 'MacBook Pro Microphone' }]);

    await withGlobals({ bridge, devices }, async () => {
        const state = await systemAudioAvailability();
        assert.equal(state.available, false);
        assert.match(state.reason, /no helper on this platform/);

        await assert.rejects(startSystemCapture({ onPcm: () => {} }), /no helper on this platform/);
    });
});

test('an ordinary microphone is never mistaken for a loopback device', async () => {
    const { isLoopbackDevice } = await load();

    for (const label of ['BlackHole 2ch', 'Loopback Audio', 'VB-Cable Output', 'Stereo Mix']) {
        assert.equal(isLoopbackDevice(label), true, `${label} should be recognised`);
    }
    for (const label of ['MacBook Pro Microphone', 'External Headphones', 'AirPods Pro', 'Aggregate Device', 'Multi-Output Device', '']) {
        assert.equal(isLoopbackDevice(label), false, `${label} must not be treated as meeting audio`);
    }
});
