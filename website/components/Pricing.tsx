import { GET_URL, PLANS } from '@/lib/site';
import { CurrencyToggle } from './CurrencyToggle';
import styles from './Pricing.module.css';

function Price({ usd, inr }: { usd: number; inr: number }) {
    return (
        <span className={`tech ${styles.amount}`}>
            <span className={styles.showUsd}>${usd}</span>
            <span className={styles.showInr}>₹{inr}</span>
        </span>
    );
}

export function Pricing() {
    return (
        <section className={styles.pricing} id="pricing" data-theme="light" aria-labelledby="pricing-title">
            <div className="wrap">
                <div className={styles.head}>
                    <div className={styles.headCopy}>
                        <p className="label" data-scramble>
                            Pricing
                        </p>
                        <h2 id="pricing-title" className="display h2" data-reveal>
                            Start free. <span className="em">Keep more.</span>
                        </h2>
                    </div>
                    <CurrencyToggle />
                </div>

                <div className={styles.plans}>
                    <article className={styles.pro} data-reveal>
                        <header className={styles.planHead}>
                            <h3 className={styles.planName}>{PLANS.pro.name}</h3>
                            <span className="chip">Unlimited</span>
                        </header>
                        <p className={styles.price}>
                            <Price usd={PLANS.pro.usd} inr={PLANS.pro.inr} />
                            <span className={styles.per}>a month</span>
                        </p>
                        <ul className={styles.features}>
                            {PLANS.pro.features.map(feature => (
                                <li key={feature}>{feature}</li>
                            ))}
                        </ul>
                        <a className="btn" href={GET_URL}>
                            Get Kesami
                        </a>
                        <p className={styles.upgradeNote}>Upgrade to Pro inside the app.</p>
                    </article>

                    <article className={styles.free} data-reveal style={{ '--d': '120ms' } as React.CSSProperties}>
                        <header className={styles.planHead}>
                            <h3 className={styles.planName}>{PLANS.free.name}</h3>
                        </header>
                        <p className={styles.price}>
                            <Price usd={0} inr={0} />
                            <span className={styles.per}>a month</span>
                        </p>
                        <ul className={styles.features}>
                            {PLANS.free.features.map(feature => (
                                <li key={feature}>{feature}</li>
                            ))}
                        </ul>
                        <a className="link" href={GET_URL}>
                            Get Kesami free
                        </a>
                    </article>
                </div>

                <aside className={styles.enterprise} data-reveal>
                    <h3 className={styles.planName}>{PLANS.enterprise.name}</h3>
                    <span className="chip">Coming later</span>
                    <ul>
                        {PLANS.enterprise.features.map(feature => (
                            <li key={feature}>{feature}</li>
                        ))}
                    </ul>
                </aside>
            </div>
        </section>
    );
}
