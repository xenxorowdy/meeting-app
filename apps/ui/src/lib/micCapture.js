const TARGET_SAMPLE_RATE = 16000;

const WORKLET_SOURCE = `
class PcmForwarder extends AudioWorkletProcessor {
    process(inputs) {
        const channel = inputs[0] && inputs[0][0];
        if (channel && channel.length) {
            this.port.postMessage(new Float32Array(channel));
        }
        return true;
    }
}
registerProcessor('pcm-forwarder', PcmForwarder);
`;

function floatToPcm16(samples) {
    const pcm = new Int16Array(samples.length);
    for (let i = 0; i < samples.length; i += 1) {
        const clamped = Math.max(-1, Math.min(1, samples[i]));
        pcm[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
    }
    return pcm;
}

/**
 * Capture the microphone as 16 kHz signed 16-bit mono and hand each block to
 * onPcm. While muted it forwards silence rather than stopping, so the backend's
 * level meter reads a true zero instead of freezing at the last value.
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
    const context = new AudioContext({ sampleRate: TARGET_SAMPLE_RATE });

    const workletUrl = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: 'application/javascript' }));
    try {
        await context.audioWorklet.addModule(workletUrl);
    } finally {
        URL.revokeObjectURL(workletUrl);
    }

    const source = context.createMediaStreamSource(stream);
    const forwarder = new AudioWorkletNode(context, 'pcm-forwarder');
    const sink = context.createGain();
    sink.gain.value = 0;
    let isMuted = muted;

    forwarder.port.onmessage = event => {
        if (!onPcm) return;
        const samples = event.data;
        onPcm(isMuted ? new Int16Array(samples.length) : floatToPcm16(samples));
    };

    source.connect(forwarder);
    forwarder.connect(sink);
    sink.connect(context.destination);

    if (context.state === 'suspended') await context.resume();

    return {
        sampleRate: context.sampleRate,
        setMuted(next) {
            isMuted = next;
            stream.getAudioTracks().forEach(track => {
                track.enabled = !next;
            });
        },
        async stop() {
            forwarder.port.onmessage = null;
            try {
                source.disconnect();
                forwarder.disconnect();
                sink.disconnect();
            } catch {
                // Already torn down.
            }
            stream.getTracks().forEach(track => track.stop());
            await context.close().catch(() => {});
        },
    };
}
