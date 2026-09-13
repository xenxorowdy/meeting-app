import React, { useState } from 'react';

export function SignInView({ onContinue }) {
    const [mode, setMode] = useState('login');
    const [message, setMessage] = useState('');
    const unavailable = () => setMessage('Account sign-in is not connected in this desktop build. Continue locally to open your meetings.');

    return (
        <main className="ks-login">
            <section className="ks-login-story">
                <div>
                    <div className="ks-brand">
                        <span className="ks-brand-mark">
                            <i />
                        </span>
                        KESAMI
                    </div>
                    <div className="ks-login-intro">
                        <h1>
                            Every meeting,
                            <br />
                            remembered.
                        </h1>
                        <p>AI transcription, noise cancellation, task tracking, and a searchable archive of every conversation you've ever had.</p>
                    </div>
                </div>
                <div className="ks-testimonial">
                    <p>“I haven't taken notes in three months. KESAMI captures everything and tells me exactly what I need to do next.”</p>
                    <div>
                        <span className="ks-avatar" style={{ '--speaker': '#5b9bff' }}>
                            JK
                        </span>
                        <div>
                            <strong>Jamie Kim</strong>
                            <small>Head of Product, Vercel</small>
                        </div>
                    </div>
                </div>
            </section>
            <section className="ks-login-form" aria-label="Sign in">
                <div className="ks-auth-tabs" role="tablist" aria-label="Account access">
                    <button
                        role="tab"
                        aria-selected={mode === 'login'}
                        onClick={() => {
                            setMode('login');
                            setMessage('');
                        }}
                    >
                        Sign In
                    </button>
                    <button
                        role="tab"
                        aria-selected={mode === 'signup'}
                        onClick={() => {
                            setMode('signup');
                            setMessage('');
                        }}
                    >
                        Create Account
                    </button>
                </div>
                <form
                    onSubmit={event => {
                        event.preventDefault();
                        unavailable();
                    }}
                >
                    {mode === 'signup' && (
                        <label className="ks-field">
                            FULL NAME
                            <input autoComplete="name" placeholder="Maya Chen" />
                        </label>
                    )}
                    <label className="ks-field">
                        EMAIL
                        <input type="email" autoComplete="email" placeholder="maya@company.com" required />
                    </label>
                    <div className="ks-password-label">
                        <label htmlFor="ks-password">PASSWORD</label>
                        {mode === 'login' && (
                            <button type="button" onClick={unavailable}>
                                Forgot?
                            </button>
                        )}
                    </div>
                    <input
                        id="ks-password"
                        type="password"
                        autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                        placeholder="••••••••"
                        required
                    />
                    <button type="submit" className="ks-auth-submit">
                        {mode === 'login' ? 'Sign in' : 'Create account'}
                    </button>
                </form>
                <div className="ks-auth-divider">
                    <span />
                    OR
                    <span />
                </div>
                <div className="ks-oauth">
                    <button onClick={unavailable}>
                        <span>G</span>Continue with Google
                    </button>
                    <button onClick={unavailable}>
                        <span aria-hidden="true" />
                        Continue with Apple
                    </button>
                </div>
                <p className="ks-auth-terms">Account services are not connected in this build.</p>
                {message && (
                    <p className="ks-auth-message" role="status">
                        {message}
                    </p>
                )}
                <button className="ks-local-entry" onClick={onContinue}>
                    Continue locally <span aria-hidden="true">↗</span>
                </button>
            </section>
        </main>
    );
}
