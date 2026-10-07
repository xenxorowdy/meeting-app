import React, { useEffect, useRef, useState } from 'react';
import { LogoMark } from '@/components/brand/Logo';
import { CALL_PROMPT_WOBBLE_DELAY_MS } from '@/lib/callPrompt';

const SOURCE_LABELS = { 'google-meet': 'Google Meet call detected', zoom: 'Zoom call detected', microphone: 'Microphone use detected' };

export function CallDetectedPrompt({ prompt, theme, shell }) {
    const cardRef = useRef(null);
    const latestRef = useRef(prompt);
    const requestedRef = useRef(false);
    const [wobbling, setWobbling] = useState(false);
    const [requested, setRequested] = useState(false);
    const [commandError, setCommandError] = useState(null);
    const starting = requested || prompt.status === 'starting';
    latestRef.current = { ...prompt, status: starting ? 'starting' : prompt.status };
    const error = prompt.error || commandError;

    useEffect(() => {
        const timer = setTimeout(() => {
            const card = cardRef.current;
            if (!card || latestRef.current.status === 'starting' || card.matches(':hover') || card.contains(document.activeElement) || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
            setWobbling(true);
        }, Math.max(0, prompt.createdAt + CALL_PROMPT_WOBBLE_DELAY_MS - Date.now()));
        return () => clearTimeout(timer);
    }, [prompt.id, prompt.createdAt]);

    useEffect(() => {
        requestedRef.current = false;
        setRequested(false);
        if (prompt.status === 'starting') setWobbling(false);
    }, [prompt.status, prompt.error]);

    const start = async () => {
        if (starting || requestedRef.current) return;
        requestedRef.current = true;
        setRequested(true);
        setWobbling(false);
        setCommandError(null);
        try {
            const accepted = await shell?.sendCommand('start-call', prompt.id);
            if (!accepted) throw new Error('This prompt is no longer available. Open Kesami to record.');
        } catch (cause) {
            requestedRef.current = false;
            setRequested(false);
            setCommandError(cause.message || 'Could not start recording. Try again.');
        }
    };

    return (
        <div className="ks-app ksw-call-shell" data-theme={theme}>
            <section ref={cardRef} className={`ksw-call-card${wobbling ? ' is-wobbling' : ''}`} aria-labelledby="ksw-call-title" aria-describedby="ksw-call-source" aria-busy={starting} onAnimationEnd={() => setWobbling(false)} onMouseEnter={() => setWobbling(false)} onFocusCapture={() => setWobbling(false)}>
                <header className="ksw-call-grip">
                    <LogoMark size={38} />
                    <h1 id="ksw-call-title">Take notes</h1>
                </header>
                <span id="ksw-call-source" className="sr-only">{SOURCE_LABELS[prompt.source] || 'Call detected'}. Start audio recording in Kesami.</span>
                {error && <p className="ksw-call-error" role="alert">{error}</p>}
                <div className="ksw-call-buttons">
                    <button type="button" className="ksw-call-start" onClick={start} disabled={starting}>{starting ? 'Starting…' : error ? 'Retry' : 'Start'}</button>
                    <button type="button" className="ksw-call-dismiss" onClick={() => shell?.sendCommand('dismiss-call', prompt.id)} disabled={starting}>Not now</button>
                </div>
            </section>
        </div>
    );
}
