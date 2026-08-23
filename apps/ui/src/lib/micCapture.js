import { startPcmCapture } from '@/lib/pcmCapture';

/**
 * Capture the microphone as 16 kHz signed 16-bit mono and hand each block to
 * onPcm. Everything from this stream is attributed to the local user.
 */
export async function startMicCapture({ onPcm, deviceId, muted = false } = {}) {
    const constraints = {
        audio: {
            channelCount: 1,
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
            ...(deviceId && deviceId !== 'default' ? { deviceId: { exact: deviceId } } : {}),
        },
    };

    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    const capture = await startPcmCapture({ stream, onPcm, muted });

    return {
        sampleRate: capture.sampleRate,
        stream,
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
