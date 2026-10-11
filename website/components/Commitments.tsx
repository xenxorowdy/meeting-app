import { CALL, MEETINGS, NEXT_STEPS, PEOPLE } from '@/lib/demo';
import styles from './Commitments.module.css';

const meeting = MEETINGS.customer;
const tone = Object.fromEntries(PEOPLE.map(person => [person.name, person.tone]));

// The cross-meeting view is a product concept: the app keeps next steps per meeting (owner, due date,
// done) but has no open/overdue tracking yet, so this half is labelled as such on the page.
const OPEN = [
    { state: 'overdue', task: 'Rate-limit doc for John', where: MEETINGS.technical.short, when: 'Was due Aug 28' },
    { state: 'overdue', task: 'SSO timeline for Northwind', where: MEETINGS.northwind.short, when: 'Was due Sep 24' },
    { state: 'upcoming', task: 'Pricing proposal for Acme', where: meeting.short, when: 'Friday' },
    { state: 'waiting', task: 'Priya: signed order form', where: meeting.short, when: 'Waiting on Acme' },
] as const;

const COUNTS = [
    { state: 'overdue', n: 2, label: 'overdue' },
    { state: 'upcoming', n: 3, label: 'upcoming' },
    { state: 'waiting', n: 2, label: 'waiting' },
] as const;

export function Commitments() {
    const done = NEXT_STEPS.filter(step => step.done).length;
    const total = COUNTS.reduce((sum, count) => sum + count.n, 0);
    return (
        <section className={styles.commitments} id="commitments" data-theme="paper" aria-labelledby="commitments-title">
            <div className="wrap">
                <div className={styles.head}>
                    <p className="label" data-scramble>
                        Commitments
                    </p>
                    <h2 id="commitments-title" className={`display ${styles.title}`} data-reveal>
                        Remember what you said <span className="em">you’d do.</span>
                    </h2>
                </div>

                <div className={styles.panels}>
                    <div className={styles.column} data-reveal>
                        <p className={styles.status}>
                            <span className={styles.live} aria-hidden="true" /> In Kesami today
                        </p>
                        <figure
                            className={styles.mock}
                            data-theme="dark"
                            aria-label="Next steps in a Kesami meeting brief, with owners, due dates and checkboxes"
                        >
                            <div className={styles.mockHead}>
                                <span>Next steps</span>
                                <span className={styles.muted}>
                                    {done} of {NEXT_STEPS.length} done
                                </span>
                            </div>
                            <div className={styles.bar} aria-hidden="true">
                                <span style={{ width: `${(done / NEXT_STEPS.length) * 100}%` }} />
                            </div>
                            <ul className={styles.steps}>
                                {NEXT_STEPS.map(step => (
                                    <li key={step.task} data-done={step.done || undefined}>
                                        <span className={styles.box} aria-hidden="true" />
                                        <span className={styles.task}>{step.task}</span>
                                        <span className={styles.meta}>
                                            <span className={styles.avatar} data-tone={tone[step.owner]} aria-hidden="true">
                                                {step.owner[0]}
                                            </span>
                                            {step.owner}
                                            <span className={styles.due}>{step.due}</span>
                                        </span>
                                    </li>
                                ))}
                            </ul>
                            <div className={styles.add} aria-hidden="true">
                                + Add an action item…
                            </div>
                        </figure>
                        <p className={styles.caption}>
                            Every brief ends with the meeting’s next steps. Each is credited to whoever committed to it, with a due date only when one
                            was actually said, and a box to tick when it’s done.
                        </p>
                    </div>

                    <div className={styles.column} data-reveal style={{ '--d': '150ms' } as React.CSSProperties}>
                        <p className={styles.status}>
                            <span className={styles.concept}>Product concept</span> Not in the app yet
                        </p>
                        <figure
                            className={`${styles.mock} ${styles.conceptMock}`}
                            data-theme="dark"
                            aria-label="Concept: one list of open commitments across meetings"
                        >
                            <div className={styles.committed}>
                                <p className={styles.kicker}>You committed to</p>
                                <p className={styles.promise}>Send Acme the pricing proposal</p>
                                <p className={styles.tags}>
                                    <span>Due Friday</span>
                                    <span>High confidence</span>
                                </p>
                                <p className={styles.source}>
                                    <span className={styles.muted}>
                                        {meeting.short} — {meeting.date} · {CALL[1].t}
                                    </span>
                                    <q>{CALL[1].text}</q>
                                </p>
                            </div>

                            <div className={styles.mockHead}>
                                <span>Open commitments</span>
                                <span className={styles.muted}>{total} total</span>
                            </div>
                            <div className={styles.split} aria-hidden="true">
                                {COUNTS.map(count => (
                                    <span key={count.state} data-state={count.state} style={{ flexGrow: count.n }} />
                                ))}
                            </div>
                            <p className={styles.counts}>
                                {COUNTS.map(count => (
                                    <span key={count.state} data-state={count.state}>
                                        <b>{count.n}</b> {count.label}
                                    </span>
                                ))}
                            </p>
                            <ul className={styles.open}>
                                {OPEN.map(item => (
                                    <li key={item.task} data-state={item.state}>
                                        <span className={styles.dot} aria-hidden="true" />
                                        <span className={styles.task}>{item.task}</span>
                                        <span className={styles.meta}>
                                            {item.where} · {item.when}
                                        </span>
                                    </li>
                                ))}
                            </ul>
                        </figure>
                        <p className={styles.caption}>
                            Where it’s heading: one list of everything you’ve promised across every meeting — what’s overdue, what’s next, and what
                            you’re waiting on from someone else.
                        </p>
                    </div>
                </div>
            </div>
        </section>
    );
}
