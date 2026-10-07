import React, { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { PricingView } from '../../apps/ui/src/components/design/PricingView.jsx';
import { PlanBilling } from '../../apps/ui/src/components/design/PlanBilling.jsx';
import { fetchSubscription } from '../../apps/ui/src/lib/plans.js';
import '../../apps/ui/src/design.css';

const billing = { razorpay: true, stripe: false, billingEnabled: true };
const plans = [
    { id: 'free', name: 'Free', status: 'available', prices: [{ amountMinor: 0, currency: 'USD' }], features: ['2 hours of recording'], description: 'Your meetings, on your device.' },
    { id: 'pro', name: 'Pro', status: 'available', prices: [{ amountMinor: 49900, currency: 'INR', provider: 'razorpay', interval: 'month' }], features: ['Unlimited recording and AI'], description: 'Unlimited recording and AI summaries, per user.' },
];
const state = { tier: 'free', calls: [], scenario: 'success', signedIn: true };
globalThis.kesamiConnection = { get: () => ({ url: 'http://127.0.0.1:48900', token: 'fixture-session' }) };
window.fetch = async (url, options = {}) => {
    const path = new URL(url).pathname;
    const body = options.body ? JSON.parse(options.body) : null;
    state.calls.push({ path, body });
    if (path === '/api/plans') return Response.json({ billing, plans });
    if (path === '/api/billing/checkout') return Response.json({ provider: 'razorpay', keyId: 'rzp_test_fixture', subscriptionId: 'sub_Fixture' });
    if (path === '/api/billing/razorpay/confirm') {
        if (state.scenario === 'confirmation-error') return Response.json({ error: 'Payment confirmation is temporarily unavailable.' }, { status: 503 });
        state.tier = 'pro';
    }
    if (path === '/api/billing/razorpay/sync') state.tier = 'pro';
    return Response.json({ tier: state.tier, accountSynced: true,
        subscription: state.tier === 'pro' ? { plan: 'pro', provider: 'razorpay', providerSubscriptionId: 'sub_Fixture', status: 'active', currency: 'INR', amountMinor: 49900, currentPeriodEnd: 2000000000000 } : null,
        usage: { minutesUsed: 120, freeMonthlyMinutes: 120, canRecord: state.tier === 'pro', aiUses: 3, freeMonthlyAiUses: 3, canUseAi: state.tier === 'pro' },
    });
};
window.Razorpay = class {
    constructor(options) { state.checkout = options; }
    on(event, handler) { if (event === 'payment.failed') state.fail = handler; }
    open() { state.opened = (state.opened || 0) + 1; }
};

function Fixture() {
    const [version, setVersion] = useState(0);
    const [tier, setTier] = useState('free');
    const [view, setView] = useState('pricing');
    window.paymentFixture = {
        state,
        authorize() { state.checkout.handler({ razorpay_subscription_id: 'sub_Fixture', razorpay_payment_id: 'pay_Fixture', razorpay_signature: 'fixture-proof' }); state.checkout.modal.ondismiss(); },
        dismiss() { state.checkout.modal.ondismiss(); },
        fail() { state.fail(); },
        billing() { setView('billing'); },
        reset(scenario = 'success', signedIn = true) { Object.assign(state, { tier: 'free', calls: [], scenario, signedIn, opened: 0 }); setTier('free'); setView('pricing'); setVersion(value => value + 1); },
    };
    return <div className="ks-app" data-theme="light"><main className="ks-account" style={{ padding: 24 }}>
        <span data-testid="current-plan">{tier === 'pro' ? 'Pro Plan' : 'Free Plan'}</span>
        {view === 'billing' ? <PlanBilling key={version} onUpgrade={() => setView('pricing')} /> : <PricingView key={version}
            account={state.signedIn ? { email: 'payer@example.com' } : null} currentTier={tier}
            onSettings={() => {}} onSignIn={() => { state.signInRequested = true; }}
            onSubscribed={async () => setTier((await fetchSubscription()).tier)} />}
    </main></div>;
}
createRoot(document.getElementById('root')).render(<StrictMode><Fixture /></StrictMode>);
