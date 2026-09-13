import React, { memo, useEffect, useMemo, useState } from 'react';

const TARGET_WORDS_PER_SECOND = 26;
const MIN_STEP_MS = 12;
const MAX_CATCHUP_MS = 1400;

export function prefersReducedMotion() {
    try {
        return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    } catch {
        return false;
    }
}

export const StreamingText = memo(function StreamingText({ text = '', stream = false }) {
    const tokens = useMemo(() => text.match(/\S+\s*/g) || [], [text]);
    const animate = stream && !prefersReducedMotion();
    const [shown, setShown] = useState(() => (animate ? 0 : tokens.length));

    useEffect(() => {
        if (!animate) {
            setShown(tokens.length);
            return undefined;
        }
        if (shown >= tokens.length) {
            if (shown > tokens.length) setShown(tokens.length);
            return undefined;
        }
        const remaining = tokens.length - shown;
        const step = Math.max(MIN_STEP_MS, Math.min(1000 / TARGET_WORDS_PER_SECOND, MAX_CATCHUP_MS / remaining));
        const timer = setTimeout(() => setShown(value => Math.min(tokens.length, value + 1)), step);
        return () => clearTimeout(timer);
    }, [animate, shown, tokens.length]);

    if (!animate) return text;

    return tokens.slice(0, shown).map((token, index) => (
        <span key={index} className="ks-word">
            {token}
        </span>
    ));
});
