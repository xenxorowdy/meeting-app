import { startPcmCapture } from './pcmCapture.js';

const LOOPBACK_HINTS = [
    /blackhole/i,
    /loopback/i,
    /soundflower/i,
    /existential audio/i,
    /vb-?(audio|cable)/i,
    /virtual (audio )?cable/i,
    /cable output/i,
    /stereo mix/i,
    /what ?u ?hear/i,
];

const NO_SOURCE_MESSAGE =
    'No meeting audio source is available. Install a loopback input device (BlackHole on macOS, VB-Audio Cable on Windows) and pick it under Settings › Audio › Meeting audio.';

export function isLoopbackDevice(label) {
    return LOOPBACK_HINTS.some(pattern => pattern.test(String(label || '')));
}

export async function listAudioInputs() {
    if (!navigator.mediaDevices?.enumerateDevices) return [];
    const devices = await navigator.mediaDevices.enumerateDevices().catch(() => []);
    return devices
        .filter(device => device.kind === 'audioinput' && device.deviceId && device.deviceId !== 'default' && device.deviceId !== 'communications')
        .map(device => ({ deviceId: device.deviceId, label: device.label || 'Audio input', isLoopback: isLoopbackDevice(device.label) }));
}

export async function systemAudioAvailability() {
    const bridge = globalThis.alphaSystemAudio;
    if (!bridge) return { available: false, source: null, reason: 'Capturing the other participants needs the Alpha desktop app.' };
    const state = await bridge.available().catch(cause => ({ available: false, reason: cause.message }));
    if (state?.available) return { available: true, source: 'native', reason: null };

    const loopback = (await listAudioInputs()).find(device => device.isLoopback);
    if (loopback) return { available: true, source: 'device', reason: null, device: loopback };
    return { available: false, source: null, reason: state?.reason || NO_SOURCE_MESSAGE };
}

async function startNativeCapture({ onPcm, onError, muted }) {
    const bridge = globalThis.alphaSystemAudio;
    let isMuted = muted;

    const offData = bridge.onData(bytes => {
        if (!onPcm || !bytes?.byteLength) return;
        if (isMuted) {
            onPcm(new Int16Array(bytes.byteLength / 2));
            return;
        }
        const aligned = bytes.byteOffset % 2 === 0 ? bytes : new Uint8Array(bytes);
        onPcm(new Int16Array(aligned.buffer, aligned.byteOffset, aligned.byteLength / 2));
    });

    const offStatus = bridge.onStatus(status => {
        if (status.state === 'error' && onError) onError(status.message || 'System audio capture stopped.');
    });

    try {
        await bridge.start();
    } catch (cause) {
        offData();
        offStatus();
        throw cause;
    }

    return {
        source: 'native',
        label: 'System audio',
        setMuted(next) {
            isMuted = next;
        },
        async stop() {
            offData();
            offStatus();
            await bridge.stop().catch(() => {});
        },
    };
}

async function startDeviceCapture({ deviceId, label, onPcm, onError, muted }) {
    const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
            deviceId: { exact: deviceId },
            channelCount: 1,
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
        },
    });

    let capture;
    try {
        capture = await startPcmCapture({ stream, onPcm, muted });
    } catch (cause) {
        stream.getTracks().forEach(track => track.stop());
        throw cause;
    }

    const tracks = stream.getAudioTracks();
    const ended = () => onError?.('The meeting audio device disconnected. Choose an available device in Settings.');
    tracks.forEach(track => track.addEventListener('ended', ended));
    return {
        source: 'device',
        label: label || 'Meeting audio device',
        setMuted(next) {
            capture.setMuted(next);
        },
        async stop() {
            tracks.forEach(track => track.removeEventListener('ended', ended));
            await capture.stop();
            stream.getTracks().forEach(track => track.stop());
        },
    };
}

export async function startSystemCapture({ onPcm, onError, deviceId = 'default', muted = false } = {}) {
    if (deviceId && deviceId !== 'default') {
        const device = (await listAudioInputs()).find(entry => entry.deviceId === deviceId);
        return startDeviceCapture({ deviceId, label: device?.label, onPcm, onError, muted });
    }

    const bridge = globalThis.alphaSystemAudio;
    if (bridge) {
        const state = await bridge.available().catch(() => null);
        if (state?.available) return startNativeCapture({ onPcm, onError, muted });
        const loopback = (await listAudioInputs()).find(device => device.isLoopback);
        if (loopback) return startDeviceCapture({ deviceId: loopback.deviceId, label: loopback.label, onPcm, onError, muted });
        throw new Error(state?.reason || NO_SOURCE_MESSAGE);
    }

    const loopback = (await listAudioInputs()).find(device => device.isLoopback);
    if (loopback) return startDeviceCapture({ deviceId: loopback.deviceId, label: loopback.label, onPcm, onError, muted });
    throw new Error(NO_SOURCE_MESSAGE);
}
