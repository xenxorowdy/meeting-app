import styles from './Problem.module.css';

// What decays after a call, on the clock it decays on. Kept to words: the section's job is to name the
// problem in one glance before the page shows the product.
const LOSSES = [
    { when: '10 minutes later', title: 'Decisions get buried', body: 'They’re somewhere in a 40-minute call nobody will replay.' },
    { when: 'The next day', title: 'Commitments get forgotten', body: '“I’ll send it by Friday” was said out loud and written nowhere.' },
    { when: 'A week later', title: 'Follow-ups slip through', body: 'Everyone assumed someone else was sending the recap.' },
    { when: 'The next meeting', title: 'Context goes missing', body: 'It opens with “so where did we land last time?”' },
];

export function Problem() {
    return (
        <section className={styles.problem} data-theme="paper" aria-labelledby="problem-title">
            <div className="wrap">
                <h2 id="problem-title" className={`display h2 ${styles.title}`} data-reveal>
                    The meeting ends. <span className="em">The work doesn’t.</span>
                </h2>
                <ol className={styles.timeline}>
                    {LOSSES.map((loss, i) => (
                        <li key={loss.title} data-reveal style={{ '--d': `${i * 110}ms` } as React.CSSProperties}>
                            <p className={styles.when}>{loss.when}</p>
                            <h3 className={styles.what}>{loss.title}</h3>
                            <p className={styles.body}>{loss.body}</p>
                        </li>
                    ))}
                </ol>
            </div>
        </section>
    );
}
