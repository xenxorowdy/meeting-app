const test = require('node:test');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const moduleUrl = pathToFileURL(path.resolve(__dirname, '../apps/ui/src/lib/plans.js')).href;

test('pricing distinguishes free, configured and unpublished amounts', async () => {
    const { formatPlanPrice } = await import(moduleUrl);
    assert.equal(formatPlanPrice(null), 'Price to be announced');
    assert.equal(formatPlanPrice({ amountMinor: 0 }), 'Free');
    assert.equal(formatPlanPrice({ amountMinor: 99900, currency: 'INR' }), '₹999');
    assert.equal(formatPlanPrice({ amountMinor: 1299, currency: 'USD' }), '$12.99');
    assert.equal(formatPlanPrice({ amountMinor: -100, currency: 'USD' }), 'Price to be announced');
    assert.equal(formatPlanPrice({ amountMinor: 100, currency: 'XXX' }), 'Price to be announced');
});

test('a missing catalog produces an actionable error instead of a blank pricing view', async () => {
    const { fetchPlans } = await import(moduleUrl);
    const original = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: true, text: async () => '{}' });
    try { await assert.rejects(fetchPlans(), /Plans are unavailable/); }
    finally { globalThis.fetch = original; }
});

test('pickPlanPrice picks the price matching the viewer region', async () => {
    const { pickPlanPrice } = await import(moduleUrl);
    const prices = [
        { amountMinor: 80000, currency: 'INR' },
        { amountMinor: 1000, currency: 'USD' },
    ];
    assert.equal(pickPlanPrice(prices, 'en-IN').currency, 'INR');
    assert.equal(pickPlanPrice(prices, 'en-US').currency, 'USD');
    assert.equal(pickPlanPrice([]), null);
    assert.equal(pickPlanPrice(null), null);
});

test('formatPlanExpiry renders a readable date or nothing', async () => {
    const { formatPlanExpiry } = await import(moduleUrl);
    assert.equal(formatPlanExpiry(1_800_000_000_000), 'Jan 15, 2027');
    assert.equal(formatPlanExpiry(0), null);
    assert.equal(formatPlanExpiry(null), null);
    assert.equal(formatPlanExpiry(-5), null);
});

test('Pro checkout sends the selected currency and opens the Razorpay subscription', async () => {
    const { createProCheckout, openRazorpayCheckout } = await import(moduleUrl);
    const originalFetch = globalThis.fetch;
    const originalRazorpay = globalThis.Razorpay;
    const originalConnection = globalThis.kesamiConnection;
    let request;
    let options;
    let opened = false;
    globalThis.kesamiConnection = { get: () => ({ url: 'http://127.0.0.1:48900', token: 'test-session' }) };
    globalThis.fetch = async (url, init) => {
        request = { url, init };
        return { ok: true, text: async () => JSON.stringify({ provider: 'razorpay', keyId: 'rzp_test_public', subscriptionId: 'sub_test' }) };
    };
    globalThis.Razorpay = class {
        constructor(value) { options = value; }
        open() { opened = true; }
    };
    try {
        const checkout = await createProCheckout('INR');
        await openRazorpayCheckout(checkout, { email: 'asha@example.com' });
        assert.equal(request.url, 'http://127.0.0.1:48900/api/billing/checkout');
        assert.equal(request.init.method, 'POST');
        assert.equal(request.init.headers.get('Authorization'), 'Bearer test-session');
        assert.deepEqual(JSON.parse(request.init.body), { plan: 'pro', currency: 'INR' });
        assert.equal(options.key, 'rzp_test_public');
        assert.equal(options.subscription_id, 'sub_test');
        assert.equal(options.prefill.email, 'asha@example.com');
        assert.equal(opened, true);
    } finally {
        globalThis.fetch = originalFetch;
        globalThis.Razorpay = originalRazorpay;
        globalThis.kesamiConnection = originalConnection;
    }
});

test('Pro checkout rejects an incomplete provider response', async () => {
    const { createProCheckout } = await import(moduleUrl);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: true, text: async () => JSON.stringify({ provider: 'razorpay', subscriptionId: 'sub_test' }) });
    try { await assert.rejects(createProCheckout('INR'), /usable checkout/); }
    finally { globalThis.fetch = originalFetch; }
});

test('waitForPro asks the backend to sync the Razorpay subscription until it reports Pro', async () => {
    const { waitForPro } = await import(moduleUrl);
    const originalFetch = globalThis.fetch;
    const originalConnection = globalThis.kesamiConnection;
    const requests = [];
    const replies = [
        { ok: false, status: 502, body: { error: 'Could not reach Razorpay. Please try again.' } },
        { ok: true, status: 200, body: { tier: 'free', subscription: null } },
        { ok: true, status: 200, body: { tier: 'pro', subscription: { status: 'active' } } },
    ];
    globalThis.kesamiConnection = { get: () => ({ url: 'http://127.0.0.1:48900', token: 'test-session' }) };
    globalThis.fetch = async (url, init) => {
        requests.push({ url, init });
        const reply = replies.shift();
        return { ok: reply.ok, status: reply.status, text: async () => JSON.stringify(reply.body) };
    };
    try {
        assert.equal(await waitForPro('sub_test', { attempts: 5, intervalMs: 1 }), true);
        assert.equal(requests.length, 3);
        assert.equal(requests[0].url, 'http://127.0.0.1:48900/api/billing/razorpay/sync');
        assert.equal(requests[0].init.method, 'POST');
        assert.deepEqual(JSON.parse(requests[0].init.body), { subscriptionId: 'sub_test' });
    } finally {
        globalThis.fetch = originalFetch;
        globalThis.kesamiConnection = originalConnection;
    }
});

test('waitForPro gives up quietly while Razorpay is still confirming and stops on a rejected subscription', async () => {
    const { waitForPro } = await import(moduleUrl);
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = async () => {
        calls++;
        return { ok: true, status: 200, text: async () => JSON.stringify({ tier: 'free' }) };
    };
    try {
        assert.equal(await waitForPro('sub_test', { attempts: 3, intervalMs: 1 }), false);
        assert.equal(calls, 3);
        calls = 0;
        globalThis.fetch = async () => {
            calls++;
            return { ok: false, status: 404, text: async () => JSON.stringify({ error: 'That subscription does not belong to this account.' }) };
        };
        await assert.rejects(waitForPro('sub_test', { attempts: 3, intervalMs: 1 }), /does not belong/);
        assert.equal(calls, 1);
    } finally {
        globalThis.fetch = originalFetch;
    }
});
