'use client';

import { useEffect } from 'react';

const GLYPHS = '▮▯/\\_—·:01';
const SCRAMBLE_MS = 640;

// Resolves left to right: settled characters stay put while the rest keep cycling, the way a
// transcript line firms up from interim to final.
function scramble(el: HTMLElement) {
    const final = el.textContent ?? '';
    const start = performance.now();
    const tick = (now: number) => {
        const progress = Math.min(1, (now - start) / SCRAMBLE_MS);
        const settled = Math.floor(progress * final.length);
        let out = final.slice(0, settled);
        for (let i = settled; i < final.length; i++) {
            out += final[i] === ' ' ? ' ' : GLYPHS[(Math.random() * GLYPHS.length) | 0];
        }
        el.textContent = out;
        if (progress < 1) requestAnimationFrame(tick);
        else el.textContent = final;
    };
    requestAnimationFrame(tick);
}

/**
 * One IntersectionObserver for every [data-reveal] and [data-scramble] on the page, mounted once in the
 * layout. Sections stay server components and opt in with an attribute instead of each wrapping itself
 * in a client component with its own observer.
 */
export function RevealObserver() {
    useEffect(() => {
        const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        const targets = document.querySelectorAll<HTMLElement>('[data-reveal], [data-scramble]');
        const observer = new IntersectionObserver(
            entries => {
                for (const entry of entries) {
                    if (!entry.isIntersecting) continue;
                    const el = entry.target as HTMLElement;
                    el.dataset.shown = '';
                    if (!reduced && el.hasAttribute('data-scramble')) scramble(el);
                    observer.unobserve(el);
                }
            },
            { rootMargin: '0px 0px -12% 0px' }
        );
        targets.forEach(el => observer.observe(el));
        return () => observer.disconnect();
    }, []);

    return null;
}
