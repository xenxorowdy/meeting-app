import React, { useEffect, useState } from 'react';
import { HardDrive, Star } from 'lucide-react';
import { fetchPlans, formatPlanPrice, pickPlanPrice } from '@/lib/plans.js';

export function PricingView({ onSettings, onLocal }) {
    const [catalog, setCatalog] = useState(null);
    const [error, setError] = useState('');
    const [attempt, setAttempt] = useState(0);
    useEffect(() => {
        const controller = new AbortController();
        setError('');
        fetchPlans({ signal: controller.signal }).then(value => {
            if (!controller.signal.aborted) setCatalog(value);
        }).catch(cause => {
            if (!controller.signal.aborted) setError(cause.message);
        });
        return () => controller.abort();
    }, [attempt]);
    return <div className="ks-account ks-pricing">
        <h1>Start local. Stay in control.</h1>
        <p>Use the desktop workspace without an account or subscription.</p>
        {error && <div className="ks-account-feedback" role="alert">{error} <button className="ks-button" onClick={() => setAttempt(value => value + 1)}>Retry</button></div>}
        {!catalog && !error && <p role="status">Loading plans…</p>}
        {catalog && <div className="ks-pricing-grid">{catalog.plans.map(plan => {
            const price = pickPlanPrice(plan.prices);
            return <section key={plan.id} className="ks-plan-card" aria-label={`${plan.name} plan`}>
                {plan.id === 'free' ? <HardDrive aria-hidden="true" /> : <Star aria-hidden="true" />}
                <span className="ks-tag">{plan.status === 'available' ? 'AVAILABLE NOW' : 'COMING SOON'}</span>
                <h2>{plan.name}</h2>
                <div className="ks-plan-price">{formatPlanPrice(price)}{price?.amountMinor > 0 && <small> / {price.interval || 'month'}</small>}</div>
                <p>{plan.description}</p>
                <ul>{plan.features.map(feature => <li key={feature}>{feature}</li>)}</ul>
                <button className={`ks-button ${plan.id === 'free' ? 'ks-primary' : ''}`} disabled={plan.status !== 'available'} onClick={onLocal}>
                    {plan.id === 'free' ? 'Open workspace' : 'Not available yet'}
                </button>
                <p className="ks-plan-note">{plan.note}</p>
            </section>;
        })}</div>}
        <section className="ks-account-card ks-account-stack ks-plan-details">
            <h2>What does local mode include?</h2>
            <p>Recording, your meeting library, search and exports stay available without signing in. Transcription and AI require a configured provider; its usage charges are separate. Signing in does not upload or sync your meetings.</p>
            <button onClick={onSettings}>Configure recording and AI providers →</button>
        </section>
    </div>;
}
