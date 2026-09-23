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
