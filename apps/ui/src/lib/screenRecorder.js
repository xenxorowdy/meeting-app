import { startPcmCapture } from '@/lib/pcmCapture';

// Meetings are mostly static faces and slides, so a modest bitrate keeps files
// small. Capture at 25–27 FPS so cursor movement and shared video look fluid;
// the codec naturally spends fewer bits on unchanged frames.
export const DEFAULT_BITS_PER_SECOND = 800_000;
const MIN_FRAME_RATE = 25;
const TARGET_FRAME_RATE = 27;
const MAX_WIDTH = 1280;

// Ordered best-first. Electron 30 has no h264/mp4 encoder, so webm is the only
// real option; vp8 is the fallback for a build without vp9.
const CANDIDATE_TYPES = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];

// One second of video per chunk: small enough that a crash loses almost nothing,
// large enough that IPC overhead stays irrelevant.
const CHUNK_MS = 1000;

function pickMimeType() {
    return CANDIDATE_TYPES.find(type => MediaRecorder.isTypeSupported(type)) || '';
}

export function isRecordingSupported() {
    return Boolean(globalThis.alphaRecorder && typeof MediaRecorder !== 'undefined' && pickMimeType());
}

export function listSources() {
    if (!globalThis.alphaRecorder) return Promise.resolve([]);
    return globalThis.alphaRecorder.listSources();
}

/**
 * Record a screen (or window) to disk for the duration of a meeting, and feed the
 * system-audio track to the backend so remote participants get transcribed.
 *
 * The bytes stream to the Electron main process a chunk at a time rather than
 * accumulating in this renderer: an hour of Blobs held in memory is hundreds of
 * megabytes of RSS in the window the user is looking at.
 *
 * `onSystemPcm` may never be called: system-audio loopback is not available on
 * every platform and Electron version, and a stream can come back video-only.
 * `hasSystemAudio` on the result says which happened, so the UI can be honest
 * about whether the other side was captured rather than silently recording half
 * the conversation.
 */
export async function startScreenRecording({
    meetingId,
    sourceId,
    micStream = null,
    onSystemPcm,
    onError,
    bitsPerSecond = DEFAULT_BITS_PER_SECOND,
} = {}) {
    const bridge = globalThis.alphaRecorder;
    if (!bridge) throw new Error('Screen recording needs the desktop app.');

    const mimeType = pickMimeType();
    if (!mimeType) throw new Error('This build has no video encoder for screen recording.');

    const permission = await bridge.screenPermission();
    if (permission === 'denied' || permission === 'restricted') {
        throw new Error(
            'Screen Recording permission is denied. Grant it in System Settings › Privacy & Security › Screen Recording, then restart Alpha.'
        );
    }

    // Tell the main process which source its display-media handler should hand
    // back; the renderer cannot choose one itself.
    await bridge.selectSource(sourceId || null);

    const stream = await navigator.mediaDevices.getDisplayMedia({
        video: {
            // getDisplayMedia rejects `min`/`exact` constraints during source
            // selection. Apply the requested lower bound to the returned track
            // instead, where normal MediaStreamTrack constraints are supported.
            frameRate: { ideal: TARGET_FRAME_RATE, max: TARGET_FRAME_RATE },
            width: { max: MAX_WIDTH },
        },
        audio: true,
    });

    const videoTrack = stream.getVideoTracks()[0] || null;
    if (videoTrack) {
        await videoTrack
            .applyConstraints({ frameRate: { min: MIN_FRAME_RATE, ideal: TARGET_FRAME_RATE, max: TARGET_FRAME_RATE } })
            .catch(() => videoTrack.applyConstraints({ frameRate: { ideal: TARGET_FRAME_RATE, max: TARGET_FRAME_RATE } }).catch(() => {}));
    }

    const systemTrack = stream.getAudioTracks()[0] || null;
    const hasSystemAudio = Boolean(systemTrack);

    // Mix whatever audio exists into one track for the recording. Without this the
    // recording carries only the screen, and a replay of a meeting with no sound
    // is close to useless.
    let mixContext = null;
    let mixed = null;
    const audioSources = [];
    if (systemTrack) audioSources.push(new MediaStream([systemTrack]));
    if (micStream && micStream.getAudioTracks().length) audioSources.push(micStream);

    if (audioSources.length) {
        mixContext = new AudioContext();
        mixed = mixContext.createMediaStreamDestination();
        for (const source of audioSources) {
            mixContext.createMediaStreamSource(source).connect(mixed);
        }
    }

    const recordedStream = new MediaStream([...stream.getVideoTracks(), ...(mixed ? mixed.stream.getAudioTracks() : [])]);

    const startedAtMs = Date.now();
    const handle = await bridge.start({ meetingId, mimeType, startedAtMs });

    let bytes = 0;
    let writeFailed = null;

    const recorder = new MediaRecorder(recordedStream, { mimeType, videoBitsPerSecond: bitsPerSecond });

    // A webm is only valid if its clusters land in the order they were encoded, and
    // `ondataavailable` cannot guarantee that on its own: MediaRecorder fires it
    // without awaiting, so two handlers overlap and `blob.arrayBuffer()` can resolve
    // out of order. Chaining every chunk onto the previous one serialises the writes
    // no matter how the promises settle.
    let writeChain = Promise.resolve();

    recorder.ondataavailable = event => {
        if (!event.data || !event.data.size || writeFailed) return;
        const blob = event.data;

        writeChain = writeChain.then(async () => {
            if (writeFailed) return;
            try {
                const buffer = await blob.arrayBuffer();
                await bridge.writeChunk(handle.id, buffer);
                bytes += buffer.byteLength;
            } catch (cause) {
                // Stop writing after the first failure rather than reporting an
                // error per chunk for the rest of the meeting.
                writeFailed = cause.message || String(cause);
                if (onError) onError(writeFailed);
            }
        });
    };

    recorder.onerror = event => {
        if (onError) onError(event.error?.message || 'The screen recorder failed.');
    };

    // The user can stop sharing from the OS overlay, which ends the video track
    // without going through our stop path.
    let onEnded = null;

    // Feed system audio to the backend at 16 kHz. This is the first time this app
    // hears anyone but its own user, so remote turns depend on it.
    let systemCapture = null;
    if (systemTrack && onSystemPcm) {
        systemCapture = await startPcmCapture({ stream: new MediaStream([systemTrack]), onPcm: onSystemPcm });
    }

    recorder.start(CHUNK_MS);

    const result = {
        hasSystemAudio,
        mimeType,
        startedAtMs,

        setSystemMuted(muted) {
            if (systemCapture) systemCapture.setMuted(muted);
        },

        onSourceEnded(callback) {
            onEnded = callback;
            const video = stream.getVideoTracks()[0];
            if (video) video.addEventListener('ended', () => onEnded && onEnded());
        },

        /** Flush, close the file, and return what to store on the meeting. */
        async stop() {
            if (recorder.state !== 'inactive') {
                await new Promise(resolve => {
                    recorder.onstop = resolve;
                    try {
                        recorder.stop();
                    } catch {
                        resolve();
                    }
                });
            }

            // The final `ondataavailable` fires during stop(), so its write is
            // still queued here. Closing the file before it drains would truncate
            // the recording.
            await writeChain;

            if (systemCapture) await systemCapture.stop();
            if (mixContext) await mixContext.close().catch(() => {});
            stream.getTracks().forEach(track => track.stop());

            const finished = await bridge.stop(handle.id).catch(() => null);

            return {
                videoPath: finished?.path || handle.path,
                startedAtMs,
                durationMs: Date.now() - startedAtMs,
                bytes: finished?.bytes ?? bytes,
                mimeType,
                hasSystemAudio,
                sourceId: sourceId || null,
                error: writeFailed,
            };
        },
    };

    return result;
}
