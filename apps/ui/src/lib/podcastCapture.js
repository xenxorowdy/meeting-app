function supportedType(kind) {
    const candidates = kind === 'audio'
        ? ['audio/webm;codecs=opus', 'audio/webm']
        : ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
    return candidates.find(type => MediaRecorder.isTypeSupported(type)) || '';
}

export function isPodcastCaptureSupported() {
    return Boolean(globalThis.alphaPodcast && typeof MediaRecorder !== 'undefined' && navigator.mediaDevices);
}

export async function requestPodcastPermissions() {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
    stream.getTracks().forEach(track => track.stop());
    return listPodcastDevices();
}

export async function listPodcastDevices() {
    if (!navigator.mediaDevices?.enumerateDevices) return { microphones: [], cameras: [] };
    const devices = await navigator.mediaDevices.enumerateDevices();
    return {
        microphones: devices.filter(device => device.kind === 'audioinput').map((device, index) => ({ id: device.deviceId, label: device.label || `Microphone ${index + 1}` })),
        cameras: devices.filter(device => device.kind === 'videoinput').map((device, index) => ({ id: device.deviceId, label: device.label || `Camera ${index + 1}` })),
    };
}

async function openRecorder(projectId, stream, kind, sourceKind, captureGroupId, timelineStartMs) {
    const mimeType = supportedType(kind);
    if (!mimeType) throw new Error(`No ${kind} encoder is available in this Alpha build.`);
    const sink = await globalThis.alphaPodcast.startCapture(projectId, { mimeType, sourceKind, captureGroupId, timelineStartMs });
    const recorder = new MediaRecorder(stream, kind === 'video' ? { mimeType, videoBitsPerSecond: 8_000_000 } : { mimeType, audioBitsPerSecond: 256_000 });
    let chain = Promise.resolve();
    let failure = null;
    recorder.ondataavailable = event => {
        if (!event.data?.size || failure) return;
        const blob = event.data;
        chain = chain.then(async () => {
            const buffer = await blob.arrayBuffer();
            await globalThis.alphaPodcast.writeCapture(sink.id, buffer);
        }).catch(cause => {
            failure = cause;
        });
    };
    recorder.onerror = event => {
        failure = event.error || new Error(`The ${sourceKind} recorder stopped unexpectedly.`);
    };
    recorder.start(1000);
    return {
        stream,
        async stop() {
            if (recorder.state !== 'inactive') {
                await new Promise(resolve => {
                    recorder.onstop = resolve;
                    recorder.stop();
                });
            }
            await chain;
            stream.getTracks().forEach(track => track.stop());
            const result = await globalThis.alphaPodcast.stopCapture(sink.id);
            if (failure) throw failure;
            return result;
        },
    };
}

/**
 * Capture sources as separate takes so microphone, camera and screen can be
 * independently trimmed and cleaned on the timeline.
 */
export async function startPodcastCapture({ projectId, microphoneId, cameraId, screenSourceId, includeMic = true, includeCamera = true, includeScreen = false, timelineStartMs = 0, onEnded = null }) {
    if (!isPodcastCaptureSupported()) throw new Error('Podcast recording requires the Alpha desktop app.');
    const opened = [];
    const captureGroupId = globalThis.crypto?.randomUUID?.() || `capture-${Date.now()}`;
    try {
        if (includeMic) {
            const mic = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: microphoneId ? { exact: microphoneId } : undefined, echoCancellation: true, noiseSuppression: false, autoGainControl: false }, video: false });
            opened.push(await openRecorder(projectId, mic, 'audio', 'microphone', captureGroupId, timelineStartMs));
        }
        if (includeCamera) {
            const camera = await navigator.mediaDevices.getUserMedia({ audio: false, video: { deviceId: cameraId ? { exact: cameraId } : undefined, width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30, max: 30 } } });
            opened.push(await openRecorder(projectId, camera, 'video', 'camera', captureGroupId, timelineStartMs));
        }
        if (includeScreen) {
            await globalThis.alphaRecorder?.selectSource(screenSourceId || null);
            const screen = await navigator.mediaDevices.getDisplayMedia({ video: { width: { max: 1920 }, height: { max: 1080 }, frameRate: { ideal: 30, max: 30 } }, audio: true });
            opened.push(await openRecorder(projectId, screen, 'video', 'screen', captureGroupId, timelineStartMs));
        }
        let stopPromise = null;
        let stopped = false;
        const session = {
            streams: opened.map(item => item.stream),
            isStopped: () => stopped,
            stop() {
                if (!stopPromise) {
                    stopped = true;
                    stopPromise = Promise.allSettled(opened.map(item => item.stop())).then(outcomes => {
                        const failed = outcomes.find(outcome => outcome.status === 'rejected');
                        if (failed) throw failed.reason;
                        return outcomes.map(outcome => outcome.value);
                    });
                }
                return stopPromise;
            },
        };
        for (const item of opened) {
            for (const track of item.stream.getTracks()) {
                track.addEventListener('ended', () => {
                    if (stopped) return;
                    session.stop().then(results => onEnded?.(null, results), cause => onEnded?.(cause));
                }, { once: true });
            }
        }
        return session;
    } catch (cause) {
        for (const item of opened) await item.stop().catch(() => {});
        throw cause;
    }
}
