import { CALL, DECISIONS, FOLDER, MEETINGS, PEOPLE } from '@/lib/demo';
import { ArrowRight } from './Icons';
import styles from './Memory.module.css';

const meeting = MEETINGS.customer;

// What one call turns into. Every link is something the app keeps today: speakers you name, the folder
// you file the meeting in, the brief's decisions and next steps with their timestamps, the drafted email.
const CHAIN = [
    { kind: 'Meeting', value: meeting.short, note: `${meeting.date} · ${meeting.minutes} min` },
    { kind: 'People', people: true, note: 'Name a voice once; every line follows' },
    { kind: 'Customer or project', value: `${FOLDER} folder`, note: 'Filed with the calls before it' },
    { kind: 'Decisions', value: 'SSO goes in the proposal', note: `Said at ${CALL[3].t}` },
    { kind: 'Commitments', value: 'You · pricing proposal · Friday', note: `Said at ${CALL[1].t}` },
    { kind: 'Follow-ups', value: 'Recap email to Priya', note: 'Drafted when the call ends' },
];

const HISTORY = [
    { ...MEETINGS.discovery, kind: 'Commitment', text: 'You: a sandbox account before the pilot' },
    { ...MEETINGS.technical, kind: 'Context', text: 'John: the nightly sync needs more than 100 requests a minute' },
    { ...MEETINGS.customer, kind: 'Decision', text: DECISIONS[0] },
];

export function Memory() {
    return (
        <section className={styles.memory} id="how" data-theme="light" aria-labelledby="memory-title">
            <div className="wrap">
                <div className={styles.head}>
                    <p className="label" data-scramble>
                        Kesami remembers
                    </p>
                    <h2 id="memory-title" className="display h2" data-reveal>
                        A meeting is more than a transcript.
                    </h2>
                    <p className="lead" data-reveal style={{ '--d': '120ms' } as React.CSSProperties}>
                        Keep the people, decisions and next steps with the conversation they came from. File related calls together, then ask across them.
                    </p>
                </div>

                <ol className={styles.chain} aria-label="What Kesami keeps from one meeting">
                    {CHAIN.map((link, i) => (
                        <li key={link.kind} className={styles.link} data-reveal style={{ '--d': `${i * 90}ms` } as React.CSSProperties}>
                            <span className={styles.kind}>{link.kind}</span>
                            {link.people ? (
                                <span className={styles.people}>
                                    {PEOPLE.map(person => (
                                        <span key={person.name} className={styles.person}>
                                            <span className={styles.avatar} data-tone={person.tone} aria-hidden="true">
                                                {person.name[0]}
                                            </span>
                                            {person.name}
                                        </span>
                                    ))}
                                </span>
                            ) : (
                                <span className={styles.value}>{link.value}</span>
                            )}
                            <span className={styles.note}>{link.note}</span>
                        </li>
                    ))}
                </ol>

                <div className={styles.history} data-reveal>
                    <div className={styles.historyHead}>
                        <p className={styles.historyTitle}>
                            <span className={styles.folderMark} aria-hidden="true" />
                            {FOLDER} · three meetings, one memory
                        </p>
                        <a className="link" href="#ask">
                            Ask across all three <ArrowRight size={16} />
                        </a>
                    </div>
                    <ol className={styles.timeline}>
                        {HISTORY.map(item => (
                            <li key={item.title}>
                                <span className={styles.date}>{item.date}</span>
                                <span className={styles.meetingName}>{item.short}</span>
                                <span className={styles.item}>
                                    <span className={styles.itemKind}>{item.kind}</span>
                                    {item.text}
                                </span>
                            </li>
                        ))}
                    </ol>
                    <p className={styles.footnote}>
                        Transcripts, your notes, briefs, decisions and action items are indexed on your computer, so the next question can reach all
                        of them.
                    </p>
                </div>
            </div>
        </section>
    );
}
