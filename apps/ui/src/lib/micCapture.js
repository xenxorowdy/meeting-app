import { startPcmCapture } from './pcmCapture.js';

export function microphoneProcessing({ noiseSuppression = true, echoCancellation = true } = {}) {
    return { noiseSuppression, echoCancellation, autoGainControl: true };
}

/** Update the existing track so the recorder's mixed audio is filtered too. */
export async function applyMicrophoneProcessing(stream, options) {
    const constraints = microphoneProcessing(options);
    await Promise.all(stream.getAudioTracks().map(async track => {
        // applyConstraints replaces custom constraints; retain device selection.
        await track.applyConstraints({ ...track.getConstraints(), ...constraints });
        const applied = track.getSettings();
        for (const key of ['noiseSuppression', 'echoCancellation']) {
            if (typeof applied[key] === 'boolean' && applied[key] !== constraints[key]) {
                throw new Error(`This microphone could not ${constraints[key] ? 'enable' : 'disable'} ${key === 'noiseSuppression' ? 'noise cancellation' : 'echo cancellation'}.`);
            }
        }
    }));
}

/**
 * Capture the microphone as 16 kHz signed 16-bit mono and hand each block to
 * onPcm. Everything from this stream is attributed to the local user.
 */
export async function startMicCapture({ onPcm, deviceId, muted = false, noiseSuppression = true, echoCancellation = true } = {}) {
    const constraints = {
        audio: {
            channelCount: 1,
            ...microphoneProcessing({ noiseSuppression, echoCancellation }),
            ...(deviceId && deviceId !== 'default' ? { deviceId: { exact: deviceId } } : {}),
        },
    };

    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    // A worklet failure must not leave the microphone recording in the background.
    let capture;
    try {
        stream.getAudioTracks().forEach(track => { track.enabled = !muted; });
        capture = await startPcmCapture({ stream, onPcm, muted });
    } catch (cause) {
        stream.getTracks().forEach(track => track.stop());
        throw cause;
    }
    let pendingProcessing = Promise.resolve();
    let applied = microphoneProcessing({ noiseSuppression, echoCancellation });

    return {
        sampleRate: capture.sampleRate,
        stream,
        setProcessing(options) {
            const wanted = microphoneProcessing(options);
            if (wanted.noiseSuppression === applied.noiseSuppression && wanted.echoCancellation === applied.echoCancellation) {
                return pendingProcessing;
            }
            applied = wanted;
            pendingProcessing = pendingProcessing.catch(() => {}).then(() => applyMicrophoneProcessing(stream, options));
            return pendingProcessing;
        },
        setMuted(next) {
            capture.setMuted(next);
            // Disabling the track as well means the OS mic indicator goes out,
            // rather than showing the app as listening while it forwards silence.
            stream.getAudioTracks().forEach(track => {
                track.enabled = !next;
            });
        },
        async stop() {
            await capture.stop();
            stream.getTracks().forEach(track => track.stop());
        },
    };
}
