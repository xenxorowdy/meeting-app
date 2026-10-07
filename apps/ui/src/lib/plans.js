import { apiRequest } from './backend.js';

export async function fetchPlans({ signal } = {}) {
    const catalog = await apiRequest('/api/plans', { signal });
    if (!Array.isArray(catalog.plans) || !catalog.plans.length) throw new Error('Plans are unavailable. Please try again.');
    return catalog;
}

export function formatPlanPrice(price) {
    if (!price || !Number.isSafeInteger(price.amountMinor) || price.amountMinor < 0) return 'Price to be announced';
    if (price.amountMinor === 0) return 'Free';
    if (!['INR', 'USD', 'EUR', 'GBP'].includes(price.currency)) return 'Price to be announced';
    return new Intl.NumberFormat('en', { style: 'currency', currency: price.currency, maximumFractionDigits: price.amountMinor % 100 === 0 ? 0 : 2 }).format(price.amountMinor / 100);
}

export function pickPlanPrice(prices, locale = typeof navigator !== 'undefined' ? navigator.language : 'en-US') {
    if (!Array.isArray(prices) || !prices.length) return null;
    const preferred = /-in$/i.test(locale || '') ? 'INR' : 'USD';
    return prices.find(price => price.currency === preferred) || prices[0];
}

export async function fetchSubscription({ signal } = {}) {
    return apiRequest('/api/billing/subscription', { signal });
}

export async function syncRazorpaySubscription(subscriptionId, { signal } = {}) {
    return apiRequest('/api/billing/razorpay/sync', { method: 'POST', body: { subscriptionId }, signal });
}

export async function confirmRazorpayPayment(subscriptionId, response, { signal } = {}) {
    if (response?.razorpay_subscription_id !== subscriptionId || !response?.razorpay_payment_id || !response?.razorpay_signature) {
        throw new Error('The payment confirmation is incomplete. Check payment status before trying another checkout.');
    }
    return apiRequest('/api/billing/razorpay/confirm', {
        method: 'POST', signal,
        body: { subscriptionId, paymentId: response.razorpay_payment_id, signature: response.razorpay_signature },
    });
}

export async function waitForPro(subscriptionId, { attempts = 20, intervalMs = 3000, signal } = {}) {
    for (let attempt = 1; attempt <= attempts; attempt++) {
        signal?.throwIfAborted();
        try {
            const result = await syncRazorpaySubscription(subscriptionId, { signal });
            if (result.tier === 'pro') return true;
        } catch (cause) {
            signal?.throwIfAborted();
            if (cause.status >= 400 && cause.status < 500) throw cause;
        }
        if (attempt < attempts) await new Promise((resolve, reject) => {
            const stop = () => { clearTimeout(timer); reject(signal.reason); };
            const timer = setTimeout(() => { signal?.removeEventListener('abort', stop); resolve(); }, intervalMs);
            signal?.addEventListener('abort', stop, { once: true });
            if (signal?.aborted) stop();
        });
    }
    return false;
}

export async function createProCheckout(currency) {
    const checkout = await apiRequest('/api/billing/checkout', {
        method: 'POST',
        body: { plan: 'pro', currency },
    });
    if (currency === 'INR' && checkout.provider === 'razorpay' && checkout.keyId && checkout.subscriptionId) return checkout;
    if (currency === 'USD' && checkout.provider === 'stripe' && checkout.checkoutUrl) return checkout;
    throw new Error('The payment provider did not return a usable checkout. Please try again.');
}

let razorpayScriptPromise;
function loadRazorpay() {
    if (globalThis.Razorpay) return Promise.resolve(globalThis.Razorpay);
    if (!razorpayScriptPromise) {
        razorpayScriptPromise = new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.src = 'https://checkout.razorpay.com/v1/checkout.js';
            script.async = true;
            script.onload = () => globalThis.Razorpay ? resolve(globalThis.Razorpay) : reject(new Error('Razorpay checkout did not load. Please try again.'));
            script.onerror = () => reject(new Error('Could not load Razorpay checkout. Check your connection and try again.'));
            const timer = setTimeout(() => { script.remove(); reject(new Error('Razorpay checkout took too long to load. Check your connection and try again.')); }, 15000);
            const loaded = script.onload;
            const failed = script.onerror;
            script.onload = () => { clearTimeout(timer); loaded(); };
            script.onerror = () => { clearTimeout(timer); script.remove(); failed(); };
            document.head.appendChild(script);
        }).catch(error => {
            razorpayScriptPromise = undefined;
            throw error;
        });
    }
    return razorpayScriptPromise;
}

export async function prepareRazorpayCheckout() {
    await loadRazorpay();
}

export async function openRazorpayCheckout(checkout, { email, onAuthorized, onDismiss, onFailed } = {}) {
    const Razorpay = await loadRazorpay();
    let authorized = false;
    const payment = new Razorpay({
        key: checkout.keyId,
        subscription_id: checkout.subscriptionId,
        name: 'Kesami Pro',
        prefill: { email },
        handler: response => { authorized = true; onAuthorized?.(response); },
        modal: { ondismiss: () => { if (!authorized) onDismiss?.(); } },
    });
    payment.on?.('payment.failed', () => onFailed?.('Payment failed. Retry in checkout or close it and try again.'));
    payment.open();
}

export function formatPlanExpiry(currentPeriodEnd) {
    if (!Number.isSafeInteger(currentPeriodEnd) || currentPeriodEnd <= 0) return null;
    return new Intl.DateTimeFormat('en', { dateStyle: 'medium' }).format(new Date(currentPeriodEnd));
}
