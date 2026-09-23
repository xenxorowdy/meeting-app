import React, { useEffect, useState } from 'react';
import { ArrowRight, Moon, Sun } from 'lucide-react';
import { LogoMark } from '@/components/brand/Logo';
import { createAccount, signIn, signInWithGoogle } from '@/lib/auth.js';
import { apiRequest } from '@/lib/backend.js';

const EMPTY_FORM = { name: '', email: '', password: '' };

export function SignInView({ onContinue, onAuthenticated, theme = 'dark', onToggleTheme, notice }) {
    const [mode, setMode] = useState('signin');
    const [form, setForm] = useState(EMPTY_FORM);
    const [reveal, setReveal] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const [registrationAllowed, setRegistrationAllowed] = useState(null);
    const [googleClientId, setGoogleClientId] = useState(null);
    const [googleAuth, setGoogleAuth] = useState(null);
    useEffect(() => {
        const controller = new AbortController();
        apiRequest('/api/auth/config', { signal: controller.signal }).then(config => {
            setRegistrationAllowed(config.registrationAllowed !== false);
            setGoogleClientId(config.googleClientId || '');
            setGoogleAuth(config.googleAuth || null);
        }).catch(() => {});
        return () => controller.abort();
    }, []);
    const continueLocal = async destination => {
        if (busy) return;
        setBusy(true);
        setError('');
        try { await onContinue(destination); }
        catch (cause) { setError(cause.message || 'Could not open the local workspace.'); }
        finally { setBusy(false); }
    };

    const creating = mode === 'create';
    const dark = theme === 'dark';

    const toggleMode = () => {
        setMode(creating ? 'signin' : 'create');
        setError('');
    };

    const update = field => event => {
        setForm(current => ({ ...current, [field]: event.target.value }));
    };

    const submit = async event => {
        event.preventDefault();
        if (busy) return;
        if (!form.email || !form.password) {
            setError('Enter your email and password.');
            return;
        }
        setBusy(true);
        setError('');
        try {
            const account = creating ? await createAccount(form) : await signIn(form);
            onAuthenticated?.(account);
        } catch (cause) {
            setError(cause.message || 'Something went wrong. Try again.');
        } finally {
            setBusy(false);
        }
    };

    const submitGoogle = async () => {
        if (busy) return;
        setBusy(true);
        setError('');
        try {
            const account = await signInWithGoogle(googleAuth || googleClientId);
            onAuthenticated?.(account);
        } catch (cause) {
            setError(cause.message || 'Google sign-in failed. Try again.');
        } finally {
            setBusy(false);
        }
    };

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
                    <h2 id="welcome-title">{creating ? 'Create account.' : 'Get in.'}</h2>
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
                    {creating ? 'NEW ACCOUNT' : 'SIGN IN'}
                    <i />
                </div>
                <form onSubmit={submit}>
                    {creating && (
                        <input
                            type="text"
                            name="name"
                            autoComplete="name"
                            aria-label="Full name"
                            placeholder="Full name"
                            maxLength={80}
                            value={form.name}
                            onChange={update('name')}
                            disabled={busy}
                            required
                        />
                    )}
                    <input
                        type="email"
                        name="email"
                        autoComplete="email"
                        aria-label="Email"
                        placeholder="you@work.com"
                        disabled={busy}
                        maxLength={254}
                        value={form.email}
                        onChange={update('email')}
                        required
                    />
                    <div className="ks-welcome-password">
                        <input
                            type={reveal ? 'text' : 'password'}
                            name="password"
                            autoComplete={creating ? 'new-password' : 'current-password'}
                            aria-label="Password"
                            placeholder={creating ? 'At least 8 characters' : 'Password'}
                            minLength={creating ? 8 : undefined}
                            maxLength={512}
                            value={form.password}
                            onChange={update('password')}
                            disabled={busy}
                            required
                        />
                        <button type="button" className="ks-welcome-reveal" onClick={() => setReveal(!reveal)}>
                            {reveal ? 'Hide' : 'Show'}
                        </button>
                    </div>
                    <button type="submit" className="ks-welcome-submit" disabled={busy}>
                        {busy ? (creating ? 'Creating account…' : 'Signing in…') : creating ? 'Create account' : 'Continue to workspace'}
                    </button>
                </form>
                {globalThis.alphaGoogleSignIn?.start && (
                    <div className="ks-oauth">
                        <span>OR</span>
                        <button type="button" disabled={busy || (googleAuth ? !googleAuth.configured : !googleClientId)} onClick={submitGoogle}>
                            {busy ? 'Waiting for Google…' : creating ? 'Create account with Google' : 'Sign in with Google'}
                        </button>
                        {googleAuth && !googleAuth.configured && <p className="ks-welcome-note">Google sign-in is unavailable. You can continue locally.</p>}
                        {!googleAuth && googleClientId === '' && <p className="ks-welcome-note">Add a Google Desktop app client ID in Connection &amp; preferences first.</p>}
                    </div>
                )}
                {(error || notice) && (
                    <p className="ks-welcome-error" role="alert">
                        {error || notice}
                    </p>
                )}
                {registrationAllowed === false && <p className="ks-welcome-note">Ask your workspace owner for account access, or continue locally.</p>}
                <div className="ks-welcome-links">
                    <button type="button" disabled={busy || (!creating && registrationAllowed === false)} onClick={toggleMode}>
                        {creating ? 'I already have an account' : 'Create account'}
                    </button>
                    <button type="button" disabled={busy} onClick={() => continueLocal('settings')}>
                        Connection &amp; preferences
                    </button>
                </div>
                <button type="button" className="ks-welcome-local" disabled={busy} onClick={() => continueLocal()}>
                    <ArrowRight aria-hidden="true" />
                    Use it locally, no account
                </button>
                <p className="ks-welcome-note">
                    Local use is free. AI providers may charge for usage. Signing in does not sync your meetings.
                </p>
            </section>
        </main>
    );
}
