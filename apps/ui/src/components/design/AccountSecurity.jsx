import React, { useState } from 'react';
import { changePassword } from '@/lib/auth.js';

export function AccountSecurity({ onAccountChange, disabled }) {
    const [form, setForm] = useState({ currentPassword: '', password: '', confirm: '' });
    const [busy, setBusy] = useState(false);
    const [message, setMessage] = useState('');
    const [error, setError] = useState('');
    const submit = async event => {
        event.preventDefault();
        if (busy || disabled) return;
        setError(''); setMessage('');
        if (form.password !== form.confirm) { setError('The new passwords do not match.'); return; }
        setBusy(true);
        try {
            const account = await changePassword(form);
            onAccountChange?.(account);
            setForm({ currentPassword: '', password: '', confirm: '' });
            setMessage('Password updated. Other sessions have been signed out.');
        } catch (cause) { setError(cause.message); }
        finally { setBusy(false); }
    };
    return <section className="ks-account-card ks-account-stack">
        <h2>Password &amp; security</h2>
        <form className="ks-account-password" onSubmit={submit}>
            {[['currentPassword', 'Current password'], ['password', 'New password'], ['confirm', 'Confirm new password']].map(([key, label]) => <label className="ks-field" key={key}>
                {label}<input type="password" autoComplete={key === 'currentPassword' ? 'current-password' : 'new-password'} minLength={key === 'currentPassword' ? undefined : 8} maxLength={512} required disabled={busy || disabled} value={form[key]} onChange={event => setForm(value => ({ ...value, [key]: event.target.value }))} />
            </label>)}
            <p>Use at least 8 characters. Updating your password signs out other sessions.</p>
            <button type="submit" className="ks-button" disabled={busy || disabled}>{busy ? 'Updating password…' : 'Update password'}</button>
            {error && <p role="alert" className="ks-account-feedback">{error}</p>}
            {message && <p role="status">{message}</p>}
        </form>
    </section>;
}
