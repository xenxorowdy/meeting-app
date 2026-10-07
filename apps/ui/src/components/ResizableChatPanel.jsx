import React, { useEffect, useRef, useState } from 'react';

const DEFAULT_WIDTH = 360;

export function ResizableChatPanel({ open, onClose, children }) {
    const panel = useRef(null);
    const drag = useRef(null);
    const [preferredWidth, setPreferredWidth] = useState(DEFAULT_WIDTH);
    const [maximum, setMaximum] = useState(800);
    const [dragging, setDragging] = useState(false);
    const [expanded, setExpanded] = useState(false);
    const minimum = Math.min(320, maximum);
    const width = Math.max(minimum, Math.min(maximum, preferredWidth));
    const clamp = value => Math.max(minimum, Math.min(maximum, value));

    useEffect(() => {
        if (!open || !panel.current) return;
        const host = panel.current.parentElement;
        const measure = () => {
            const available = host.getBoundingClientRect().width;
            const overlay = window.matchMedia('(max-width: 1100px)').matches;
            setMaximum(Math.max(0, Math.min(800, overlay ? available : Math.max(320, available - 320))));
        };
        measure();
        const observer = new ResizeObserver(measure);
        observer.observe(host);
        return () => { observer.disconnect(); drag.current = null; setDragging(false); };
    }, [open]);

    useEffect(() => {
        if (!dragging) return undefined;
        const move = event => {
            if (drag.current) setPreferredWidth(Math.max(minimum, Math.min(maximum, drag.current.width + drag.current.x - event.clientX)));
        };
        const end = () => {
            drag.current = null;
            setDragging(false);
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', end);
        window.addEventListener('pointercancel', end);
        window.addEventListener('blur', end);
        return () => {
            window.removeEventListener('pointermove', move);
            window.removeEventListener('pointerup', end);
            window.removeEventListener('pointercancel', end);
            window.removeEventListener('blur', end);
        };
    }, [dragging, minimum, maximum]);

    useEffect(() => {
        if (!open) setExpanded(false);
    }, [open]);

    useEffect(() => {
        if (!open) return;
        const closeOnEscape = event => {
            if (event.key === 'Escape' && !event.defaultPrevented && !document.querySelector('[role="dialog"]')) {
                if (expanded) setExpanded(false);
                else onClose();
            }
        };
        window.addEventListener('keydown', closeOnEscape);
        return () => window.removeEventListener('keydown', closeOnEscape);
    }, [open, onClose, expanded]);

    if (!open) return null;
    return (
        <aside aria-label="Ask AI panel" ref={panel} className={`ks-meeting-chat${dragging ? ' is-resizing' : ''}${expanded ? ' is-expanded' : ''}`} style={{ '--ks-chat-width': `${width}px` }}>
            {!expanded && <div
                className="ks-chat-resize"
                role="separator"
                tabIndex={0}
                aria-label="Resize AI chat"
                aria-orientation="vertical"
                aria-valuemin={minimum}
                aria-valuemax={maximum}
                aria-valuenow={width}
                aria-valuetext={`${Math.round(width)} pixels wide`}
                title="Drag to resize · Arrow keys to adjust · Double-click to reset"
                onPointerDown={event => {
                    if (event.button !== 0) return;
                    event.preventDefault();
                    event.currentTarget.focus();
                    drag.current = { x: event.clientX, width };
                    setDragging(true);
                }}
                onDoubleClick={() => setPreferredWidth(DEFAULT_WIDTH)}
                onKeyDown={event => {
                    const next = { ArrowLeft: width + 20, ArrowRight: width - 20, Home: minimum, End: maximum, Enter: DEFAULT_WIDTH }[event.key];
                    if (next === undefined) return;
                    event.preventDefault();
                    setPreferredWidth(clamp(next));
                }}
            >
                <span />
            </div>}
            {typeof children === 'function' ? children({ isExpanded: expanded, onToggleExpand: () => setExpanded(value => !value) }) : children}
        </aside>
    );
}
