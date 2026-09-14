import React, { useEffect, useRef } from 'react';

const SLOTS = 48;
const COMMIT_MS = 80;
const REDUCED_MS = 250;
const DRAIN = 0.82;
const DRAIN_EPSILON = 0.004;
const NOISE_FLOOR = 1;
const GAIN = 1.8;
const MID_GAP = 1;
const MAX_BAR_GAP = 2.5;
const MIN_BAR_WIDTH = 1.5;
const HAIRLINE = 1.5;
const MAX_DPR = 3;
const MIC_FALLBACK = '#ec3013';
const SYSTEM_FALLBACK = '#5b9bff';
const CANVAS_STYLE = { display: 'block', width: '100%', height: '100%' };

function shape(value) {
    const above = (Math.max(0, (Number(value) || 0) - NOISE_FLOOR)) / 100;
    if (above <= 0) return 0;
    return Math.min(1, Math.sqrt(above) * GAIN);
}

function prefersReducedMotion() {
    try {
        if (document.documentElement?.dataset?.reducedMotion === 'true') return true;
        return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    } catch {
        return false;
    }
}

function readColors(canvas) {
    try {
        const styles = getComputedStyle(canvas);
        const pick = (name, fallback) => styles.getPropertyValue(name).trim() || fallback;
        return { mic: pick('--ks-accent', MIC_FALLBACK), system: pick('--ks-speaker-1', SYSTEM_FALLBACK) };
    } catch {
        return { mic: MIC_FALLBACK, system: SYSTEM_FALLBACK };
    }
}

function measure(state, canvas) {
    const rect = canvas.getBoundingClientRect();
    const width = Math.max(1, Math.round(rect.width));
    const height = Math.max(1, Math.round(rect.height));
    const dpr = Math.min(MAX_DPR, Math.max(1, window.devicePixelRatio || 1));
    if (width === state.width && height === state.height && dpr === state.dpr) return;
    state.width = width;
    state.height = height;
    state.dpr = dpr;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
}

function addBar(ctx, x, y, width, height, radius) {
    if (height <= 0 || width <= 0) return;
    const capped = Math.min(radius, width / 2, height / 2);
    if (capped > 0.5 && typeof ctx.roundRect === 'function') ctx.roundRect(x, y, width, height, capped);
    else ctx.rect(x, y, width, height);
}

function paintHistory(ctx, state) {
    const mid = state.height / 2;
    const span = Math.max(1, mid - MID_GAP - 0.5);
    const slot = state.width / SLOTS;
    const barWidth = Math.max(MIN_BAR_WIDTH, slot - Math.min(MAX_BAR_GAP, slot * 0.34));
    const radius = barWidth / 2;
    const floor = state.active ? Math.min(HAIRLINE, span) : 0;
    const series = [
        { data: state.system, color: state.colors.system, up: true },
        { data: state.mic, color: state.colors.mic, up: false },
    ];

    for (const entry of series) {
        ctx.fillStyle = entry.color;
        ctx.beginPath();
        for (let i = 0; i < SLOTS; i += 1) {
            const bar = Math.max(floor, Math.min(1, entry.data[(state.head + i) % SLOTS]) * span);
            if (bar <= 0) continue;
            const x = i * slot + (slot - barWidth) / 2;
            const y = entry.up ? mid - MID_GAP - bar : mid + MID_GAP;
            addBar(ctx, x, y, barWidth, bar, radius);
        }
        ctx.fill();
    }
}

function paintStatic(ctx, state) {
    const mid = state.height / 2;
    const track = Math.max(3, Math.min(6, mid - MID_GAP));
    const radius = track / 2;
    const rows = [
        { y: mid - MID_GAP - track, level: shape(state.lastSystem), color: state.colors.system },
        { y: mid + MID_GAP, level: shape(state.lastMic), color: state.colors.mic },
    ];

    for (const row of rows) {
        ctx.fillStyle = row.color;
        ctx.globalAlpha = 0.16;
        ctx.beginPath();
        addBar(ctx, 0, row.y, state.width, track, radius);
        ctx.fill();
        ctx.globalAlpha = 1;
        if (!state.active) continue;
        ctx.beginPath();
        addBar(ctx, 0, row.y, Math.max(track, row.level * state.width), track, radius);
        ctx.fill();
    }
}

function draw(state, canvas) {
    if (!state.ctx) state.ctx = canvas.getContext('2d');
    const ctx = state.ctx;
    if (!ctx || !state.width || !state.height) return;
    if (state.colorsDirty) {
        state.colors = readColors(canvas);
        state.colorsDirty = false;
    }
    ctx.setTransform(state.dpr, 0, 0, state.dpr, 0, 0);
    ctx.clearRect(0, 0, state.width, state.height);
    if (state.reduced) paintStatic(ctx, state);
    else paintHistory(ctx, state);
}

export function LevelHistory({ subscribe, active = false, className }) {
    const canvasRef = useRef(null);
    const stateRef = useRef(null);

    if (!stateRef.current) {
        stateRef.current = {
            mic: new Float32Array(SLOTS),
            system: new Float32Array(SLOTS),
            head: 0,
            peakMic: 0,
            peakSystem: 0,
            lastMic: 0,
            lastSystem: 0,
            active: false,
            reduced: false,
            width: 0,
            height: 0,
            dpr: 1,
            ctx: null,
            colors: { mic: MIC_FALLBACK, system: SYSTEM_FALLBACK },
            colorsDirty: true,
            frame: 0,
            timer: 0,
            commitAt: 0,
            wake: null,
        };
    }

    useEffect(() => {
        const canvas = canvasRef.current;
        const state = stateRef.current;
        if (!canvas) return undefined;

        state.ctx = canvas.getContext('2d');
        state.colorsDirty = true;

        const stopFrame = () => {
            if (state.frame) cancelAnimationFrame(state.frame);
            state.frame = 0;
        };

        const stopTimer = () => {
            if (state.timer) clearInterval(state.timer);
            state.timer = 0;
        };

        const loop = now => {
            state.frame = 0;
            if (state.reduced) return;

            if (state.active) {
                if (!state.commitAt) state.commitAt = now;
                if (now - state.commitAt >= COMMIT_MS) {
                    state.commitAt = now;
                    state.mic[state.head] = shape(state.peakMic);
                    state.system[state.head] = shape(state.peakSystem);
                    state.head = (state.head + 1) % SLOTS;
                    state.peakMic = 0;
                    state.peakSystem = 0;
                    draw(state, canvas);
                }
                state.frame = requestAnimationFrame(loop);
                return;
            }

            let peak = 0;
            for (let i = 0; i < SLOTS; i += 1) {
                state.mic[i] *= DRAIN;
                state.system[i] *= DRAIN;
                peak = Math.max(peak, state.mic[i], state.system[i]);
            }
            if (peak <= DRAIN_EPSILON) {
                state.mic.fill(0);
                state.system.fill(0);
                draw(state, canvas);
                return;
            }
            draw(state, canvas);
            state.frame = requestAnimationFrame(loop);
        };

        const wake = () => {
            if (state.frame || state.reduced) return;
            state.commitAt = 0;
            state.frame = requestAnimationFrame(loop);
        };
        state.wake = wake;

        const syncMotion = force => {
            const reduced = prefersReducedMotion();
            if (!force && reduced === state.reduced) return;
            state.reduced = reduced;
            stopFrame();
            stopTimer();
            if (reduced) {
                state.mic.fill(0);
                state.system.fill(0);
                state.head = 0;
                state.timer = setInterval(() => draw(state, canvas), REDUCED_MS);
                draw(state, canvas);
                return;
            }
            draw(state, canvas);
            wake();
        };

        const resize = () => {
            measure(state, canvas);
            draw(state, canvas);
        };

        const invalidate = () => {
            state.colorsDirty = true;
            syncMotion(false);
            if (!state.frame) draw(state, canvas);
        };

        measure(state, canvas);
        syncMotion(true);

        const targets = [];
        const documentRoot = document.documentElement;
        if (documentRoot) targets.push(documentRoot);
        const themeHost = canvas.closest('[data-theme]') || canvas.closest('.ks-app');
        if (themeHost && themeHost !== documentRoot) targets.push(themeHost);

        const mutations = typeof MutationObserver === 'function' ? new MutationObserver(invalidate) : null;
        if (mutations) {
            for (const target of targets) {
                mutations.observe(target, { attributes: true, attributeFilter: ['class', 'style', 'data-theme', 'data-reduced-motion'] });
            }
        }

        const sizeObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(resize) : null;
        sizeObserver?.observe(canvas);
        window.addEventListener('resize', resize);

        let motionQuery = null;
        const onMotionChange = () => syncMotion(false);
        try {
            motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
            motionQuery.addEventListener('change', onMotionChange);
        } catch {
            motionQuery = null;
        }

        return () => {
            stopFrame();
            stopTimer();
            sizeObserver?.disconnect();
            mutations?.disconnect();
            motionQuery?.removeEventListener('change', onMotionChange);
            window.removeEventListener('resize', resize);
            state.wake = null;
        };
    }, []);

    useEffect(() => {
        const state = stateRef.current;
        if (typeof subscribe !== 'function') return undefined;

        const unsubscribe = subscribe(value => {
            const mic = Math.max(0, Math.min(100, Number(value?.mic) || 0));
            const system = Math.max(0, Math.min(100, Number(value?.system) || 0));
            state.lastMic = mic;
            state.lastSystem = system;
            if (mic > state.peakMic) state.peakMic = mic;
            if (system > state.peakSystem) state.peakSystem = system;
            if (state.active) state.wake?.();
        });

        state.wake?.();

        return () => {
            if (typeof unsubscribe === 'function') unsubscribe();
            if (state.frame) cancelAnimationFrame(state.frame);
            state.frame = 0;
        };
    }, [subscribe]);

    useEffect(() => {
        const state = stateRef.current;
        state.active = Boolean(active);
        state.commitAt = 0;
        if (!state.active) {
            state.peakMic = 0;
            state.peakSystem = 0;
            state.lastMic = 0;
            state.lastSystem = 0;
        }
        state.wake?.();
    }, [active]);

    return <canvas ref={canvasRef} className={className} style={CANVAS_STYLE} role="img" aria-label="Live audio levels" />;
}
