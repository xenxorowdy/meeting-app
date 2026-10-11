'use client';

import { useEffect, useState } from 'react';
import styles from './Pricing.module.css';

type Currency = 'usd' | 'inr';

const OPTIONS: { value: Currency; label: string }[] = [
    { value: 'usd', label: 'USD $' },
    { value: 'inr', label: 'INR ₹' },
];

/**
 * The head script has already picked a currency and the CSS already shows it, so this only has to
 * change the attribute. State exists for aria-pressed alone and is read after mount, never during
 * the server render, so the markup can't disagree with what the visitor sees.
 */
export function CurrencyToggle() {
    const [currency, setCurrency] = useState<Currency | null>(null);

    useEffect(() => {
        setCurrency(document.documentElement.dataset.currency === 'inr' ? 'inr' : 'usd');
    }, []);

    const choose = (next: Currency) => {
        document.documentElement.dataset.currency = next;
        try {
            localStorage.setItem('kesami-currency', next);
        } catch {
            // Private windows can refuse storage; the choice still holds for this visit.
        }
        setCurrency(next);
    };

    return (
        <div className={styles.toggle} role="group" aria-label="Currency">
            {OPTIONS.map(option => (
                <button
                    key={option.value}
                    type="button"
                    className={styles[option.value]}
                    aria-pressed={currency === null ? undefined : currency === option.value}
                    onClick={() => choose(option.value)}
                >
                    {option.label}
                </button>
            ))}
        </div>
    );
}
