'use client';

import { useEffect, useRef } from 'react';
import styles from './WaveFloor.module.css';

const COUNT = 88;

// A fixed seed, so the server and the client draw the same bars and hydration has nothing to reconcile.
function seeded(seed: number) {
    return () => {
        seed |= 0;
        seed = (seed + 0x6d2b79f5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// Two slow envelopes multiplied give phrase-shaped groups — loud syllables bunched between pauses —
// instead of uniform noise, which is what makes the floor read as speech rather than an equaliser.
const BARS = (() => {
    const random = seeded(48900);
    return Array.from({ length: COUNT }, (_, i) => {
        const phrase = Math.abs(Math.sin(i * 0.19 + 0.6) * Math.sin(i * 0.071 + 2.1));
        return {
            h: (0.16 + phrase * 0.7 + random() * 0.14).toFixed(3),
            dur: `${(0.9 + random() * 0.9).toFixed(2)}s`,
            delay: `${(-random() * 2).toFixed(2)}s`,
            hot: random() < 0.13,
        };
    });
})();

/**
 * The hero's floor: the logo's voice bars, stretched across the page. Idle, a playhead sweeps across
 * it; under a pointer the bars rise around the cursor. The pointer position is one CSS variable
 * written once per frame — every bar derives its own lift from it in CSS, so moving the mouse
 * re-renders nothing in React.
 */
export function WaveFloor() {
    const ref = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const floor = ref.current;
        const area = floor?.closest('section');
        if (!floor || !area) return;

        // The sweep is a main-thread animation (a registered custom property), so stop it while the
        // hero is scrolled away instead of recalculating 88 bars' styles for nobody.
        const visibility = new IntersectionObserver(([entry]) => {
            if (entry.isIntersecting) delete floor.dataset.paused;
            else floor.dataset.paused = '';
        });
        visibility.observe(floor);
        if (!window.matchMedia('(hover: hover)').matches) return () => visibility.disconnect();

        let frame = 0;
        let x = 0;
        let rect = floor.getBoundingClientRect();

        const paint = () => {
            frame = 0;
            floor.style.setProperty('--px', ((x - rect.left) / rect.width).toFixed(4));
        };
        const onMove = (event: PointerEvent) => {
            x = event.clientX;
            if (!frame) frame = requestAnimationFrame(paint);
        };
        const onEnter = () => {
            rect = floor.getBoundingClientRect();
            floor.dataset.pointer = '';
        };
        const onLeave = () => {
            delete floor.dataset.pointer;
            floor.style.removeProperty('--px');
        };

        area.addEventListener('pointermove', onMove, { passive: true });
        area.addEventListener('pointerenter', onEnter, { passive: true });
        area.addEventListener('pointerleave', onLeave, { passive: true });
        return () => {
            visibility.disconnect();
            cancelAnimationFrame(frame);
            area.removeEventListener('pointermove', onMove);
            area.removeEventListener('pointerenter', onEnter);
            area.removeEventListener('pointerleave', onLeave);
        };
    }, []);

    return (
        <div ref={ref} className={styles.floor} style={{ '--n': COUNT } as React.CSSProperties} aria-hidden="true">
            {BARS.map((bar, i) => (
                <div key={i} className={bar.hot ? `${styles.col} ${styles.hot}` : styles.col} style={{ '--i': i } as React.CSSProperties}>
                    <span className={styles.bar} style={{ '--h': bar.h, '--dur': bar.dur, '--delay': bar.delay } as React.CSSProperties} />
                </div>
            ))}
        </div>
    );
}
