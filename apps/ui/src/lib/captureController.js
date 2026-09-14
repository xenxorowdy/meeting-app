// Serialize device ownership across permission prompts, device changes and stop.
// Invalidated attempts cannot publish audio, errors or a late ready callback.
export function createCaptureController(startCapture) {
    let generation = 0;
    let current = null;
    let pending = Promise.resolve();

    const close = async () => {
        const handle = current;
        current = null;
        if (handle) await handle.stop();
    };
    const stop = () => {
        generation += 1;
        pending = pending.catch(() => {}).then(close);
        return pending;
    };
    return {
        start({ onReady, onError, onPcm, ...options }) {
            const attempt = ++generation;
            const active = () => generation === attempt;
            pending = pending.catch(() => {}).then(async () => {
                await close();
                if (!active()) return;
                const handle = await startCapture({
                    ...options,
                    onPcm: pcm => { if (active() && current) onPcm?.(pcm); },
                    onError: message => {
                        if (!active()) return;
                        // Release a failed source so a fallback may take over.
                        stop().catch(() => {});
                        onError?.(message);
                    },
                });
                if (!active()) { await handle.stop(); return; }
                current = handle;
                onReady?.(handle);
            }).catch(cause => {
                if (active()) onError?.(cause.message || 'Audio capture is unavailable.');
            });
            return pending;
        },
        stop,
    };
}
