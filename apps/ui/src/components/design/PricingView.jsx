import React, { useEffect, useState } from 'react';
import { HardDrive, Star } from 'lucide-react';
import { createProCheckout, fetchPlans, fetchSubscription, formatPlanPrice, openRazorpayCheckout, pickPlanPrice, prepareRazorpayCheckout, waitForPro } from '@/lib/plans.js';

export function PricingView({ account, canSignIn = true, onSettings, onLocal, onSignIn, onSubscribed }) {
    const [catalog, setCatalog] = useState(null);
    const [error, setError] = useState('');
    const [checkoutError, setCheckoutError] = useState('');
    const [checkoutMessage, setCheckoutMessage] = useState('');
    const [checkoutBusy, setCheckoutBusy] = useState(false);
    const [currency, setCurrency] = useState('');
    const [attempt, setAttempt] = useState(0);
    const [confirming, setConfirming] = useState(false);
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

    async function confirmPro(subscriptionId) {
        setConfirming(true);
        setCheckoutMessage('Payment received. Activating Pro…');
        try {
            const active = await waitForPro(subscriptionId);
            setCheckoutMessage(active ? 'You’re on Pro now.' : 'Payment received. Razorpay is still confirming it; Pro switches on as soon as it does.');
            if (active) onSubscribed?.();
        } catch (cause) {
            setCheckoutMessage('');
            setCheckoutError(cause.message || 'Could not confirm the subscription. Check Plan & billing in a minute.');
        } finally {
            setConfirming(false);
            setCheckoutBusy(false);
        }
    }

    async function startCheckout(selectedCurrency) {
        if (checkoutBusy) return;
        setCheckoutBusy(true);
        setCheckoutError('');
        setCheckoutMessage('');
        try {
            const current = await fetchSubscription();
            if (current.tier === 'pro') {
                setCheckoutMessage('Your Pro subscription is already active.');
                setCheckoutBusy(false);
                return;
            }
            if (selectedCurrency === 'INR') await prepareRazorpayCheckout();
            const checkout = await createProCheckout(selectedCurrency);
            if (checkout.provider === 'razorpay') {
                await openRazorpayCheckout(checkout, {
                    email: account.email,
                    onAuthorized: () => confirmPro(checkout.subscriptionId),
                    onDismiss: () => setCheckoutBusy(false),
                });
            } else {
                window.open(checkout.checkoutUrl, '_blank', 'noopener,noreferrer');
                setCheckoutBusy(false);
            }
        } catch (cause) {
            setCheckoutError(cause.message || 'Could not start checkout. Please try again.');
            setCheckoutBusy(false);
        }
    }

    return <div className="ks-account ks-pricing">
        <h1>Start local. Stay in control.</h1>
        <p>Use the desktop workspace without an account or subscription.</p>
        {error && <div className="ks-account-feedback" role="alert">{error} <button className="ks-button" onClick={() => setAttempt(value => value + 1)}>Retry</button></div>}
        {checkoutError && <p className="ks-account-feedback" role="alert">{checkoutError}</p>}
        {checkoutMessage && <p className="ks-account-feedback" role="status">{checkoutMessage}</p>}
        {!catalog && !error && <p role="status">Loading plans…</p>}
        {catalog && <div className="ks-pricing-grid">{catalog.plans.map(plan => {
            const availablePrices = (plan.prices || []).filter(item => catalog.billing?.[item.provider]);
            const prices = availablePrices.length ? availablePrices : plan.prices;
            const price = currency && plan.id === 'pro'
                ? prices?.find(item => item.currency === currency) || pickPlanPrice(prices)
                : pickPlanPrice(prices);
            const providerReady = catalog.billing
                ? catalog.billing[price?.provider] === true
                : Boolean(catalog.billingEnabled);
            const canSubscribe = plan.id === 'pro' && plan.status === 'available' && Boolean(price?.currency) && providerReady;
            const buttonLabel = plan.id === 'free' ? 'Open workspace'
                : plan.id !== 'pro' || !canSubscribe ? 'Not available yet'
                : confirming ? 'Activating Pro…'
                : checkoutBusy ? 'Opening checkout…'
                : !account ? 'Sign in to subscribe'
                : price.provider === 'razorpay' ? 'Subscribe with Razorpay' : 'Subscribe to Pro';
            const buttonAction = plan.id === 'free' ? onLocal
                : account ? () => startCheckout(price.currency) : onSignIn;
            const buttonDisabled = plan.id !== 'free' && (!canSubscribe || checkoutBusy || (!account && !canSignIn));
            return <section key={plan.id} className="ks-plan-card" aria-label={`${plan.name} plan`}>
                {plan.id === 'free' ? <HardDrive aria-hidden="true" /> : <Star aria-hidden="true" />}
                <span className="ks-tag">{plan.id === 'free' || canSubscribe ? 'AVAILABLE NOW' : plan.id === 'enterprise' ? 'CONTACT SALES' : 'COMING SOON'}</span>
                <h2>{plan.name}</h2>
                <div className="ks-plan-price">{formatPlanPrice(price)}{price?.amountMinor > 0 && <small> / {price.interval || 'month'}</small>}</div>
                {plan.id === 'pro' && availablePrices.length > 1 && <select aria-label="Pro billing currency" value={price?.currency || ''} onChange={event => setCurrency(event.target.value)}>
                    {availablePrices.map(item => <option key={item.currency} value={item.currency}>{item.currency}</option>)}
                </select>}
                <p>{plan.description}</p>
                <ul>{plan.features.map(feature => <li key={feature}>{feature}</li>)}</ul>
                <button className={`ks-button ${plan.id === 'free' || canSubscribe ? 'ks-primary' : ''}`} disabled={buttonDisabled} onClick={buttonAction}>
                    {buttonLabel}
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
