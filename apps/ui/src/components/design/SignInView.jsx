import React, { useState } from 'react';
import { Check, MessageSquareText, Sparkles } from 'lucide-react';
import { LogoMark } from '@/components/brand/Logo';
import { createAccount, signIn } from '@/lib/auth.js';

const EMPTY_FORM = { name: '', email: '', password: '' };

export function SignInView({ onContinue, onAuthenticated }) {
    const [mode, setMode] = useState('signin');
    const [form, setForm] = useState(EMPTY_FORM);
    const [showPassword, setShowPassword] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');

    const creating = mode === 'create';

    const switchMode = next => {
        setMode(next);
        setError('');
    };

    const update = field => event => {
        setForm(current => ({ ...current, [field]: event.target.value }));
    };

    const submit = async event => {
        event.preventDefault();
        if (busy) return;
        setBusy(true);
        setError('');
        try {
            const account = creating
                ? await createAccount(form)
                : await signIn(form);
            onAuthenticated?.(account);
        } catch (cause) {
            setError(cause.message || 'Something went wrong. Try again.');
        } finally {
            setBusy(false);
        }
    };

    return (
        <main className="ks-login">
            <section className="ks-login-story" aria-label="About Kesami">
                <div className="ks-brand">
                    <LogoMark size={26} live />
                    KESAMI
                </div>
                <div className="ks-login-intro">
                    <span className="ks-eyebrow">YOUR MEETING WORKSPACE</span>
                    <h1>Be in the conversation.<br /><span>Keep the clarity.</span></h1>
                    <p>Turn conversations into a transcript you can search, notes you can use, and answers you can trace back to the meeting.</p>
                    <div className="ks-welcome-preview" aria-hidden="true">
                        <div className="ks-welcome-preview-head"><LogoMark size={16} live /><span>From conversation to clarity</span><span className="ks-tag">WORKFLOW</span></div>
                        <div className="ks-welcome-flow"><span><Check />Capture</span><i /><span><Check />Understand</span><i /><span><Check />Follow through</span></div>
                        <div className="ks-welcome-preview-question"><MessageSquareText />What did we decide?</div>
                        <p>Review decisions and action items, with links to the conversation behind them.</p>
                    </div>
                </div>
                <p className="ks-welcome-footer">Less note taking. More attention to what matters.</p>
            </section>
            <section className="ks-login-form" aria-labelledby="welcome-title">
                <div className="ks-welcome-icon"><Sparkles aria-hidden="true" /></div>
                <h2 id="welcome-title">Make room for<br />a better meeting.</h2>
                <div className="ks-auth-tabs" role="tablist" aria-label="Authentication">
                    <button type="button" role="tab" aria-selected={!creating} onClick={() => switchMode('signin')}>
                        Sign in
                    </button>
                    <button type="button" role="tab" aria-selected={creating} onClick={() => switchMode('create')}>
                        Create account
                    </button>
                </div>
                <form onSubmit={submit}>
                    {creating && (
                        <label className="ks-field">
                            Full name
                            <input
                                type="text"
                                name="name"
                                autoComplete="name"
                                placeholder="Asha Verma"
                                value={form.name}
                                onChange={update('name')}
                                maxLength={80}
                                required
                            />
                        </label>
                    )}
                    <label className="ks-field">
                        Email
                        <input
                            type="email"
                            name="email"
                            autoComplete="email"
                            placeholder="you@work.com"
                            value={form.email}
                            onChange={update('email')}
                            required
                        />
                    </label>
                    <div className="ks-password-label">
                        <span id="ks-password-label">Password</span>
                        <button type="button" onClick={() => setShowPassword(!showPassword)}>
                            {showPassword ? 'Hide' : 'Show'}
                        </button>
                    </div>
                    <input
                        id="ks-password"
                        type={showPassword ? 'text' : 'password'}
                        name="password"
                        autoComplete={creating ? 'new-password' : 'current-password'}
                        placeholder={creating ? 'At least 8 characters' : 'Your password'}
                        value={form.password}
                        onChange={update('password')}
                        aria-labelledby="ks-password-label"
                        required
                    />
                    <button type="submit" className="ks-auth-submit" disabled={busy}>
                        {busy
                            ? (creating ? 'Creating account…' : 'Signing in…')
                            : (creating ? 'Create account' : 'Sign in')}
                    </button>
                </form>
                {error && <p className="ks-auth-message is-error" role="alert">{error}</p>}
                <button type="button" className="ks-local-entry" onClick={() => onContinue()}>
                    Continue without signing in
                </button>
                <button type="button" className="ks-local-entry" onClick={() => onContinue('settings')}>
                    Configure connection &amp; preferences
                </button>
                <p className="ks-auth-terms">
                    {creating
                        ? 'Your account is stored on the meeting service you connect to, not in this app. Meeting audio and transcripts stay under the same service.'
                        : 'Signing in grants this app access to the meeting workspace on your connected service.'}
                </p>
            </section>
        </main>
    );
}
