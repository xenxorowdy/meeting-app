import React, { useId } from 'react';

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
export function LogoMark({ size = 24, live = false, className }) {
    const gradientId = useId();
    return (
        <svg
            width={size}
            height={size}
            viewBox="0 0 32 32"
            className={className}
            role="img"
            aria-label="KESAMI"
        >
            <defs>
                <linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="1">
                    <stop offset="0" stopColor="#6BA6FF" />
                    <stop offset="1" stopColor="#2F6BEB" />
                </linearGradient>
            </defs>
            <rect width="32" height="32" rx="9" fill={`url(#${gradientId})`} />
            {BARS.map((bar, index) => (
                <rect
                    key={bar.x}
                    x={bar.x}
                    y={(32 - bar.height) / 2}
                    width="3.6"
                    height={bar.height}
                    rx="1.8"
                    fill="#fff"
                    className={live ? 'ks-logo-bar is-live' : 'ks-logo-bar'}
                    style={live ? { animationDelay: `${index * 0.14}s` } : undefined}
                />
            ))}
        </svg>
    );
}
