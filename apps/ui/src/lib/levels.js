const SILENT = { mic: 0, system: 0 };

/**
 * Audio levels arrive one packet at a time — 128 frames at 16 kHz is a reading
 * every 8 ms per stream, so routing them through React state would re-render the
 * whole meeting several hundred times a second to move a few bars. This keeps
 * them out of the render path: subscribers are notified at most once a frame and
 * write to the DOM themselves.
 */
export function createLevelChannel({ schedule = requestAnimationFrame, cancel = cancelAnimationFrame } = {}) {
    const listeners = new Set();
    let current = SILENT;
    let frame = 0;
    let pending = null;

    const flush = () => {
        frame = 0;
        const value = pending;
        pending = null;
        if (!value) return;
        for (const listener of [...listeners]) listener(value);
    };

    return {
        get current() {
            return current;
        },
        publish(next) {
            current = next;
            pending = next;
            if (!frame) frame = schedule(flush);
        },
        subscribe(listener) {
            listeners.add(listener);
            listener(current);
            return () => listeners.delete(listener);
        },
        reset() {
            current = SILENT;
            pending = null;
            if (frame) cancel(frame);
            frame = 0;
            for (const listener of [...listeners]) listener(SILENT);
        },
        get listenerCount() {
            return listeners.size;
        },
    };
}
