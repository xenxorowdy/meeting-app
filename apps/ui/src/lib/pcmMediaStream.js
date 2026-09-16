// Turn the native helper's PCM into a recordable track without playing it
// through the speakers. The caller owns this stream and its audio context.
export async function createPcmMediaStream({ sampleRate = 16000, muted = false, maxAheadSeconds = 0.5 } = {}) {
    const context = new AudioContext({ sampleRate });
    let destination;
    try {
        destination = context.createMediaStreamDestination();
        const gain = context.createGain();
        gain.gain.value = muted ? 0 : 1;
        gain.connect(destination);
        if (context.state === 'suspended') await context.resume();

        const sources = new Set();
        let nextStart = 0;
        let stopped = false;
        return {
            stream: destination.stream,
            write(pcm) {
                if (stopped || !pcm?.length || context.state !== 'running') return;
                const start = Math.max(context.currentTime + 0.02, nextStart);
                const duration = pcm.length / sampleRate;
                // A stalled renderer must not accumulate minutes of delayed audio.
                if (start + duration - context.currentTime > maxAheadSeconds) return;
                const buffer = context.createBuffer(1, pcm.length, sampleRate);
                const channel = buffer.getChannelData(0);
                for (let i = 0; i < pcm.length; i += 1) channel[i] = pcm[i] / 32768;
                const source = context.createBufferSource();
                source.buffer = buffer;
                source.connect(gain);
                source.onended = () => { sources.delete(source); source.disconnect(); };
                sources.add(source);
                source.start(start);
                nextStart = start + duration;
            },
            setMuted(next) { gain.gain.value = next ? 0 : 1; },
            async stop() {
                if (stopped) return;
                stopped = true;
                for (const source of sources) {
                    source.onended = null;
                    try { source.stop(); } catch { /* Already ended. */ }
                    source.disconnect();
                }
                sources.clear();
                gain.disconnect();
                destination.stream.getTracks().forEach(track => track.stop());
                await context.close().catch(() => {});
            },
        };
    } catch (cause) {
        destination?.stream.getTracks().forEach(track => track.stop());
        await context.close().catch(() => {});
        throw cause;
    }
}
