import React, { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';

const DEFAULT_WIDTH = 380;

export function ResizableChatPanel({ open, onClose, children }) {
    const panel = useRef(null);
    const drag = useRef(null);
    const [preferredWidth, setPreferredWidth] = useState(DEFAULT_WIDTH);
    const [maximum, setMaximum] = useState(800);
    const [dragging, setDragging] = useState(false);
    const minimum = Math.min(280, maximum);
    const width = Math.max(minimum, Math.min(maximum, preferredWidth));
    const clamp = value => Math.max(minimum, Math.min(maximum, value));

    useEffect(() => {
        if (!open || !panel.current) return;
        const host = panel.current.parentElement;
        const measure = () => {
            const available = host.getBoundingClientRect().width;
            const overlay = window.matchMedia('(max-width: 700px)').matches;
            setMaximum(Math.max(0, Math.min(800, overlay ? available : Math.max(280, available - 320))));
        };
        measure();
        const observer = new ResizeObserver(measure);
        observer.observe(host);
        return () => { observer.disconnect(); drag.current = null; setDragging(false); };
    }, [open]);

    if (!open) return null;
    return (
        <aside ref={panel} className={`ks-meeting-chat${dragging ? ' is-resizing' : ''}`} style={{ '--ks-chat-width': `${width}px` }}>
            <div
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
                    event.currentTarget.setPointerCapture(event.pointerId);
                    drag.current = { x: event.clientX, width };
                    setDragging(true);
                }}
                onPointerMove={event => {
                    if (drag.current) setPreferredWidth(clamp(drag.current.width + drag.current.x - event.clientX));
                }}
                onPointerUp={event => {
                    drag.current = null;
                    setDragging(false);
                    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
                }}
                onPointerCancel={() => { drag.current = null; setDragging(false); }}
                onLostPointerCapture={() => { drag.current = null; setDragging(false); }}
                onDoubleClick={() => setPreferredWidth(DEFAULT_WIDTH)}
                onKeyDown={event => {
                    const next = { ArrowLeft: width + 20, ArrowRight: width - 20, Home: minimum, End: maximum, Enter: DEFAULT_WIDTH }[event.key];
                    if (next === undefined) return;
                    event.preventDefault();
                    setPreferredWidth(clamp(next));
                }}
            >
                <span />
            </div>
            <button type="button" className="ks-close-chat" onClick={onClose} aria-label="Close Ask AI"><X /></button>
            {children}
        </aside>
    );
}
