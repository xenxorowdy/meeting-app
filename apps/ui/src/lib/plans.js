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
