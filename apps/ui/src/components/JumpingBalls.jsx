import React from 'react';

export function JumpingBalls({ className = '', size = 'md', label }) {
    return (
        <span className={`ks-balls ks-balls-${size} ${className}`.trim()} role={label ? 'status' : undefined} aria-label={label}>
            <i />
            <i />
            <i />
        </span>
    );
}
