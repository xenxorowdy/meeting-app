'use client';

import { useEffect, useRef } from 'react';

/**
 * Marks which story step is in the reading band by setting data-active on the enclosing section. The
 * panes are server-rendered and CSS shows the one that matches, so scrolling never re-renders React.
 */
export function StepObserver() {
    const ref = useRef<HTMLSpanElement>(null);

    useEffect(() => {
        const section = ref.current?.closest('section');
        if (!section) return;
        const steps = section.querySelectorAll<HTMLElement>('[data-step]');
        // On a phone the app window is pinned over the top 44vh, so the step being read sits lower.
        const band = window.matchMedia('(max-width: 960px)').matches ? '-58% 0px -22% 0px' : '-45% 0px -45% 0px';
        const observer = new IntersectionObserver(
            entries => {
                for (const entry of entries) {
                    if (entry.isIntersecting) section.dataset.active = (entry.target as HTMLElement).dataset.step;
                }
            },
            { rootMargin: band }
        );
        steps.forEach(step => observer.observe(step));
        return () => observer.disconnect();
    }, []);

    return <span ref={ref} hidden />;
}
