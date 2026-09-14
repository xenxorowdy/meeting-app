import React from 'react';

const BARS = [
    { x: 6.4, height: 10 },
    { x: 11.6, height: 18 },
    { x: 16.8, height: 13 },
    { x: 22, height: 20 },
];

/**
 * The KESAMI mark: a rounded tile holding four voice bars — the moment speech
 * becomes something you can search. `live` lets the bars breathe on surfaces
 * that represent an active session (sign-in hero, brand row).
 */
export function LogoMark({ size = 24, live = false, flat = false, className }) {
    return (
        <svg width={size} height={size} viewBox="0 0 32 32" className={className} role="img" aria-label="KESAMI">
            <rect width="32" height="32" rx={flat ? 0 : 9} fill={flat ? 'var(--ks-logo-tile, #f3f2f2)' : '#EC3013'} />
            {BARS.map((bar, index) => (
                <rect
                    key={bar.x}
                    x={bar.x}
                    y={(32 - bar.height) / 2}
                    width="3.6"
                    height={bar.height}
                    rx={flat ? 0 : 1.8}
                    fill={flat ? 'var(--ks-logo-bar-color, #ec3013)' : '#fff'}
                    className={live ? 'ks-logo-bar is-live' : 'ks-logo-bar'}
                    style={live ? { animationDelay: `${index * 0.14}s` } : undefined}
                />
            ))}
        </svg>
    );
}
