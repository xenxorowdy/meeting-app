import React, { useEffect, useRef, useState } from 'react';
import { ArrowRight, Moon, Sun } from 'lucide-react';
import { LogoMark } from '@/components/brand/Logo';
import { signInWithGoogle } from '@/lib/auth.js';
import { apiRequest } from '@/lib/backend.js';

const CONFIG_TIMEOUT_MS = 8000;
const CONFIG_RETRY_MS = 3000;

export function SignInView({ onAuthenticated, theme = 'dark', onToggleTheme, notice }) {
    const busyRef = useRef(false);
    const mountedRef = useRef(true);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const [config, setConfig] = useState(null);
    const [configState, setConfigState] = useState('loading');
    const [configAttempt, setConfigAttempt] = useState(0);

    useEffect(() => {
        mountedRef.current = true;
        return () => { mountedRef.current = false; };
    }, []);

    useEffect(() => {
        const controller = new AbortController();
        let active = true;
        setConfigState('loading');
        const timeout = setTimeout(() => {
            controller.abort();
            if (active) setConfigState('offline');
        }, CONFIG_TIMEOUT_MS);
        apiRequest('/api/auth/config', { signal: controller.signal })
            .then(value => {
                if (!active || controller.signal.aborted) return;
                setConfig(value || {});
                setConfigState('ready');
            })
            .catch(() => {
                if (active) setConfigState('offline');
            })
            .finally(() => clearTimeout(timeout));
        return () => { active = false; clearTimeout(timeout); controller.abort(); };
    }, [configAttempt]);

    useEffect(() => {
        if (configState !== 'offline') return undefined;
        const timer = setTimeout(() => setConfigAttempt(value => value + 1), CONFIG_RETRY_MS);
        return () => clearTimeout(timer);
    }, [configState, configAttempt]);

    const googleAuth = config?.googleAuth || null;
    const googleClientId = config?.googleClientId || '';
    const desktopGoogle = Boolean(globalThis.kesamiGoogleSignIn?.start);
    const googleConfigured = googleAuth ? googleAuth.configured === true : Boolean(googleClientId);
    const googleReady = desktopGoogle && googleConfigured;

    const dark = theme === 'dark';

    const submitGoogle = async () => {
        if (busyRef.current || !googleReady) return;
        busyRef.current = true;
        setBusy(true);
        setError('');
        try {
            const account = await signInWithGoogle(googleAuth || { clientId: googleClientId, calendar: config?.googleCalendar === true });
            if (mountedRef.current) onAuthenticated?.(account);
        } catch (cause) {
            if (mountedRef.current) setError(cause.message || 'Google sign-in failed. Try again.');
        } finally {
            busyRef.current = false;
            if (mountedRef.current) setBusy(false);
        }
    };

    const feedback = (error || notice) && (
        <p className="ks-welcome-error" role="alert">
            {error || notice}
        </p>
    );

    let panel;
    if (configState === 'loading') {
        panel = <p className="ks-welcome-note" role="status">Connecting to Kesami…</p>;
    } else if (configState === 'offline') {
        panel = (
            <>
                <p className="ks-welcome-error" role="alert">
                    Kesami’s engine isn’t responding yet. It restarts on its own, so this usually clears in a few seconds.
                </p>
                <div className="ks-welcome-links">
                    <button type="button" onClick={() => setConfigAttempt(value => value + 1)}>
                        Try again now
                    </button>
                </div>
                {notice && <p className="ks-welcome-note">{notice}</p>}
            </>
        );
    } else {
        panel = (
            <>
                <button type="button" className="ks-welcome-primary" disabled={busy || !googleReady} aria-busy={busy} onClick={submitGoogle}>
                    <ArrowRight aria-hidden="true" />
                    {busy ? 'Waiting for Google…' : 'Continue with Google'}
                </button>
                <p className="ks-welcome-note">
                    Sign in or create your account with Google in your browser. Your meeting library and recordings stay on this computer.
                </p>
                {!googleReady && (
                    <p className="ks-welcome-error" role="alert">
                        {desktopGoogle
                            ? 'Google sign-in isn’t configured for this build. Check again or contact support.'
                            : 'Open the Kesami desktop app to sign in with Google.'}
                    </p>
                )}
                {desktopGoogle && !googleConfigured && <div className="ks-welcome-links"><button type="button" onClick={() => setConfigAttempt(value => value + 1)}>Check again</button></div>}
                {feedback}
            </>
        );
    }

    return (
        <main className="ks-welcome">
            <section className="ks-welcome-poster" aria-label="About Kesami">
                <div className="ks-welcome-brand">
                    <LogoMark size={24} flat live />
                    KESAMI
                </div>
                <div>
                    <h1>
                        No bot.
                        <br />
                        Your disk.
                        <br />
                        Clear notes.
                    </h1>
                    <div className="ks-welcome-rule" />
                    <p>You stay in the conversation. Kesami keeps the transcript, the decisions and the follow-ups — on your own disk.</p>
                </div>
                <span className="ks-welcome-platforms">MACOS · WINDOWS — RECORDS FROM YOUR DEVICES ONLY</span>
            </section>
            <section className="ks-welcome-panel" aria-labelledby="welcome-title">
                <div className="ks-welcome-head">
                    <h2 id="welcome-title">Get in.</h2>
                    <button
                        type="button"
                        className="ks-welcome-theme"
                        onClick={() => onToggleTheme?.(dark ? 'light' : 'dark')}
                        aria-label="Toggle theme"
                    >
                        {dark ? <Sun aria-hidden="true" /> : <Moon aria-hidden="true" />}
                        {dark ? 'Light' : 'Dark'}
                    </button>
                </div>
                <div className="ks-welcome-divider">
                    <i />
                    SIGN IN
                    <i />
                </div>
                {panel}
            </section>
        </main>
    );
}
