import React, { useEffect, useState } from 'react';
import { fetchSubscription, formatPlanPrice, formatPlanExpiry } from '@/lib/plans.js';

const TIER_LABEL = { free: 'Free', pro: 'Pro' };
const STATUS_LABEL = { active: 'Active', past_due: 'Payment due', canceled: 'Canceled', unpaid: 'Unpaid' };

export function PlanBilling({ onUpgrade }) {
    const [state, setState] = useState(null);
    const [error, setError] = useState('');
    const [attempt, setAttempt] = useState(0);
    useEffect(() => {
        const controller = new AbortController();
        setError('');
        fetchSubscription({ signal: controller.signal }).then(value => {
            if (!controller.signal.aborted) setState(value);
        }).catch(cause => {
            if (!controller.signal.aborted) setError(cause.message);
        });
        return () => controller.abort();
    }, [attempt]);

    if (error) return <section className="ks-account-card ks-account-stack">
        <h2>Plan &amp; billing</h2>
        <p role="alert" className="ks-account-feedback">{error} <button className="ks-button" onClick={() => setAttempt(value => value + 1)}>Retry</button></p>
    </section>;
    if (!state) return <section className="ks-account-card ks-account-stack">
        <h2>Plan &amp; billing</h2>
        <p role="status">Loading plan…</p>
    </section>;

    const { tier, subscription, usage } = state;
    const price = subscription ? formatPlanPrice({ amountMinor: subscription.amountMinor, currency: subscription.currency }) : null;
    const expiry = subscription ? formatPlanExpiry(subscription.currentPeriodEnd) : null;

    return <section className="ks-account-card ks-account-stack">
        <h2>Plan &amp; billing</h2>
        <div className="ks-plan-summary">
            <span className="ks-tag">{TIER_LABEL[tier] || tier}</span>
            {subscription && <span className="ks-tag">{STATUS_LABEL[subscription.status] || subscription.status}</span>}
        </div>
        {tier === 'pro' && subscription ? <>
            <p>{price} / month{expiry && <> · {subscription.status === 'canceled' ? 'access ends' : 'renews'} {expiry}</>}</p>
        </> : <>
            <p>{usage.minutesUsed} of {usage.freeMonthlyMinutes} free minutes used this month.</p>
            {!usage.canRecord && <p role="alert" className="ks-account-feedback">You've used your free minutes for this month.</p>}
            <button className="ks-button ks-primary" onClick={onUpgrade}>Upgrade to Pro</button>
        </>}
    </section>;
}
