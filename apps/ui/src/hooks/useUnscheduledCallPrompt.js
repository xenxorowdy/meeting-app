import { useCallback, useEffect, useRef, useState } from 'react';
import { createCallPromptController } from '@/lib/callPrompt';

// Persisted preference/event names remain compatible; calendar calls are included too.
export function useUnscheduledCallPrompt({ enabled, canRecord, onStart }) {
    const [callPrompt, setCallPrompt] = useState(null);
    const controllerRef = useRef(null);
    const latestRef = useRef({ enabled, canRecord, onStart });
    latestRef.current = { enabled, canRecord, onStart };

    useEffect(() => {
        const controller = createCallPromptController({ onChange: setCallPrompt });
        controllerRef.current = controller;
        controller.setContext(latestRef.current);
        const unsubscribe = globalThis.kesamiMicUsage?.onEvent?.(event => {
            if (event?.active) controller.detect({ source: 'microphone' });
            else if (event?.active === false) controller.microphoneInactive();
        });
        globalThis.kesamiMicUsage?.start?.().catch(() => {});
        return () => { unsubscribe?.(); controller.dispose(); controllerRef.current = null; };
    }, []);

    useEffect(() => { controllerRef.current?.setContext(latestRef.current); }, [enabled, canRecord, onStart]);

    // Browser-only development keeps notifications; desktop uses the floating card.
    useEffect(() => {
        if (globalThis.kesamiShell || !enabled || typeof Notification === 'undefined') return;
        if (Notification.permission === 'default') Notification.requestPermission().catch(() => {});
    }, [enabled]);
    useEffect(() => {
        if (globalThis.kesamiShell || !callPrompt || typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
        const notification = new Notification('Take notes', { body: 'A call was detected. Click to start audio recording.', tag: 'kesami-call-prompt' });
        notification.onclick = () => { window.focus(); controllerRef.current?.start(callPrompt.id); };
        return () => notification.close();
    }, [callPrompt?.id]);

    const notifyUnscheduledCall = useCallback(call => controllerRef.current?.detect(call), []);
    const startCallPrompt = useCallback(id => controllerRef.current?.start(id), []);
    const dismissCallPrompt = useCallback(id => controllerRef.current?.dismiss(id), []);
    return { callPrompt, notifyUnscheduledCall, startCallPrompt, dismissCallPrompt };
}
