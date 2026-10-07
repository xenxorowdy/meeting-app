import React, { useEffect, useRef, useState } from 'react';
import { Building2, HardDrive, Star } from 'lucide-react';
import { confirmRazorpayPayment, createProCheckout, fetchPlans, fetchSubscription, formatPlanPrice, openRazorpayCheckout, pickPlanPrice, prepareRazorpayCheckout, waitForPro } from '@/lib/plans.js';

const STRIPE_POLL_MS = 5000;
const STRIPE_POLL_LIMIT = 120;

const PLAN_ICONS = { free: HardDrive, pro: Star, enterprise: Building2 };

export function PricingView({ account, currentTier = 'free', canSignIn = true, onSettings, onSignIn, onSubscribed }) {
    const [catalog, setCatalog] = useState(null);
    const [error, setError] = useState('');
    const [checkoutError, setCheckoutError] = useState('');
    const [checkoutMessage, setCheckoutMessage] = useState('');
    const [checkoutBusy, setCheckoutBusy] = useState(false);
    const [currency, setCurrency] = useState('');
    const [attempt, setAttempt] = useState(0);
    const [confirming, setConfirming] = useState(false);
    const [pendingSubscription, setPendingSubscription] = useState('');
    const [confirmedPro, setConfirmedPro] = useState(false);
    const unmounted = useRef(new AbortController());

    useEffect(() => {
        const controller = new AbortController();
        unmounted.current = controller;
        return () => controller.abort();
    }, []);

    useEffect(() => { setConfirmedPro(false); }, [currentTier, account?.id]);

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

    async function confirmPro(subscriptionId, response) {
        const signal = unmounted.current.signal;
        if (signal.aborted) return;
        setCheckoutBusy(true);
        setConfirming(true);
        setCheckoutError('');
        setPendingSubscription(subscriptionId);
        setCheckoutMessage('Checking payment and activating Pro…');
        try {
            const confirmation = response ? await confirmRazorpayPayment(subscriptionId, response, { signal }) : null;
            const active = confirmation?.tier === 'pro' || await waitForPro(subscriptionId, { signal });
            if (signal.aborted) return;
            setCheckoutMessage(active ? 'You’re on Pro now.' : 'Razorpay is still confirming your payment. Check payment status before starting another checkout.');
            if (active) { setConfirmedPro(true); setPendingSubscription(''); await onSubscribed?.(); }
        } catch (cause) {
            if (signal.aborted) return;
            setCheckoutMessage('');
            setCheckoutError(cause.message || 'Could not confirm the subscription. Check Plan & billing in a minute.');
        } finally {
            if (!signal.aborted) { setConfirming(false); setCheckoutBusy(false); }
        }
    }

    async function watchStripeCheckout() {
        const signal = unmounted.current.signal;
        for (let poll = 0; poll < STRIPE_POLL_LIMIT && !signal.aborted; poll += 1) {
            await new Promise(resolve => setTimeout(resolve, STRIPE_POLL_MS));
            if (signal.aborted) return;
            try {
                const value = await fetchSubscription({ signal });
                if (value.tier === 'pro') {
                    setConfirmedPro(true);
                    setCheckoutMessage('You’re on Pro now.');
                    onSubscribed?.();
                    return;
                }
            } catch {
                if (signal.aborted) return;
            }
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
                setConfirmedPro(true);
                setCheckoutMessage('Your Pro subscription is already active.');
                setCheckoutBusy(false);
                onSubscribed?.();
                return;
            }
            if (pendingSubscription) { await confirmPro(pendingSubscription); return; }
            if (selectedCurrency === 'INR') await prepareRazorpayCheckout();
            const checkout = await createProCheckout(selectedCurrency);
            if (checkout.provider === 'razorpay') {
                await openRazorpayCheckout(checkout, {
                    email: account.email,
                    onAuthorized: response => confirmPro(checkout.subscriptionId, response),
                    onDismiss: () => setCheckoutBusy(false),
                    onFailed: message => setCheckoutError(message),
                });
            } else {
                window.open(checkout.checkoutUrl, '_blank', 'noopener,noreferrer');
                setCheckoutMessage('Finish checkout in your browser. Kesami switches to Pro as soon as Stripe confirms the payment.');
                setCheckoutBusy(false);
                void watchStripeCheckout();
            }
        } catch (cause) {
            setCheckoutError(cause.message || 'Could not start checkout. Please try again.');
            setCheckoutBusy(false);
        }
    }

    return <div className="ks-account ks-pricing">
        <h1>Start local. Stay in control.</h1>
        <p>Your meeting library stays on this computer on every plan. Upgrade when you need more recording time and AI.</p>
        {error && <div className="ks-account-feedback" role="alert">{error} <button className="ks-button" onClick={() => setAttempt(value => value + 1)}>Retry</button></div>}
        {checkoutError && <p className="ks-account-feedback" role="alert">{checkoutError}</p>}
        {checkoutMessage && <p className="ks-account-feedback" role="status">{checkoutMessage}</p>}
        {pendingSubscription && !checkoutBusy && <button className="ks-button ks-primary" onClick={() => confirmPro(pendingSubscription)}>Check payment status</button>}
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
            const isCurrent = plan.id === (confirmedPro ? 'pro' : currentTier);
            const canSubscribe = plan.id === 'pro' && !isCurrent && plan.status === 'available' && Boolean(price?.currency) && providerReady;
            const tag = isCurrent ? 'CURRENT PLAN'
                : plan.id === 'free' || canSubscribe ? 'AVAILABLE NOW'
                : plan.status === 'contact' ? 'COMING LATER'
                : 'COMING SOON';
            const Icon = PLAN_ICONS[plan.id] || Star;
            let action = null;
            if (isCurrent) {
                action = <button className="ks-button" disabled>Current plan</button>;
            } else if (plan.id === 'pro') {
                const label = !canSubscribe ? 'Not available yet'
                    : confirming ? 'Activating Pro…'
                    : checkoutBusy ? 'Opening checkout…'
                    : !account ? 'Sign in to subscribe'
                    : price.provider === 'razorpay' ? 'Subscribe with Razorpay' : 'Subscribe to Pro';
                action = (
                    <button
                        className={`ks-button ${canSubscribe ? 'ks-primary' : ''}`}
                        disabled={!canSubscribe || checkoutBusy || (!account && !canSignIn)}
                        onClick={account ? () => startCheckout(price.currency) : onSignIn}
                    >
                        {label}
                    </button>
                );
            } else if (plan.id !== 'free') {
                action = <button className="ks-button" disabled>Not available yet</button>;
            }
            return <section key={plan.id} className="ks-plan-card" aria-label={`${plan.name} plan`}>
                <Icon aria-hidden="true" />
                <span className="ks-tag">{tag}</span>
                <h2>{plan.name}</h2>
                <div className="ks-plan-price">{formatPlanPrice(price)}{price?.amountMinor > 0 && <small> / {price.interval || 'month'}</small>}</div>
                {plan.id === 'pro' && availablePrices.length > 1 && !isCurrent && <select aria-label="Pro billing currency" value={price?.currency || ''} onChange={event => setCurrency(event.target.value)}>
                    {availablePrices.map(item => <option key={item.currency} value={item.currency}>{item.currency}</option>)}
                </select>}
                <p>{plan.description}</p>
                <ul>{plan.features.map(feature => <li key={feature}>{feature}</li>)}</ul>
                {action}
                {plan.note && <p className="ks-plan-note">{plan.note}</p>}
            </section>;
        })}</div>}
        <section className="ks-account-card ks-account-stack ks-plan-details">
            <h2>What stays on this computer?</h2>
            <p>Your meeting library, recordings, search and exports stay on this computer on every plan. While you record, audio is streamed for live transcription. Meeting text is sent only when you use AI features such as summaries and Ask AI.</p>
            <button onClick={onSettings}>Recording settings →</button>
        </section>
    </div>;
}
