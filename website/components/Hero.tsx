import { CALL, DECISIONS, MEETINGS, NEXT_STEPS, PEOPLE, SUMMARY } from '@/lib/demo';
import { GET_URL } from '@/lib/site';
import { AppleLogo, ArrowDown, ArrowRight, WindowsLogo } from './Icons';
import styles from './Hero.module.css';

const meeting = MEETINGS.customer;

// The brief Kesami leaves behind once the call is over, after apps/ui MeetingDetail.jsx: a short summary,
// the decisions, and next steps with owner, due date and a checkbox.
export function Hero() {
    const done = NEXT_STEPS.filter(step => step.done).length;
    return (
        <section className={styles.hero} id="top" data-theme="light" aria-labelledby="hero-title">
            <div className={`wrap ${styles.content}`}>
                <div className={styles.grid}>
                    <div className={styles.copy}>
                        <h1 id="hero-title" className={`display ${styles.title}`}>
                            Meetings end.<br />
                            <span className={styles.accent}>Context stays.</span>
                        </h1>
                    </div>
                    <div className={styles.intro}>
                        <p className={`lead ${styles.lead}`}>
                            Keep the decisions, find the promises, and pick up where you left off. Kesami turns your meetings into a memory you can ask.
                        </p>
                        <div className={styles.actions}>
                            <a className="btn" href={GET_URL}>
                                Get Kesami
                                <ArrowRight size={16} />
                            </a>
                            <a className="link" href="#how">
                                See how it works <ArrowDown size={16} />
                            </a>
                        </div>
                        <p className={styles.note}>
                            <span className={styles.platforms} aria-hidden="true">
                                <AppleLogo size={14} />
                                <WindowsLogo size={13} />
                            </span>
                            Available for macOS and Windows · Free to start
                        </p>
                    </div>
                </div>
                <figure className={styles.preview} aria-label="Illustrative Kesami meeting brief with transcript sources, decisions and next steps">
                    <div className={styles.brief} data-theme="dark">
                        <div className={styles.briefHead}>
                            <span className={styles.ended}>
                                <span className={styles.endedDot} aria-hidden="true">✓</span> Meeting ended · brief ready
                            </span>
                            <span className={styles.folder}>{meeting.folder}</span>
                        </div>
                        <div className={styles.meetingHeader}>
                        <p className={styles.meetingTitle}>{meeting.title}</p>
                        <p className={styles.meta}>
                            {meeting.date} · {meeting.minutes} min ·{' '}
                            <span className={styles.people}>
                                {PEOPLE.map(person => (
                                    <span key={person.name} data-tone={person.tone}>
                                        {person.name}
                                    </span>
                                ))}
                            </span>
                        </p>
                        </div>
                        <div className={styles.workspace}>
                        <div className={styles.transcript}>
                            <p className={styles.transcriptTitle}>The conversation</p>
                            <ol className={styles.turns}>
                                {CALL.slice(0, 4).map(line => (
                                    <li key={line.t}>
                                        <p className={styles.turnMeta}>
                                            <span data-tone={line.tone}>{line.who}</span>
                                            <span>{line.t}</span>
                                        </p>
                                        <p>{line.text}</p>
                                    </li>
                                ))}
                            </ol>
                            <p className={styles.sourceNote}>The original words, always within reach.</p>
                        </div>
                        <div className={styles.result}>
                        <p className={styles.kicker}>Meeting brief</p>
                        <p className={styles.summary}>
                            {SUMMARY} <span className={styles.ts}>{CALL[1].t}</span>
                        </p>

                        <p className={styles.kicker}>Decisions</p>
                        <ul className={styles.decisions}>
                            {DECISIONS.map(decision => (
                                <li key={decision}>{decision}</li>
                            ))}
                        </ul>

                        <p className={styles.kicker}>
                            Next steps
                            <span className={styles.progress}>
                                {done} of {NEXT_STEPS.length} done
                            </span>
                        </p>
                        <ul className={styles.steps}>
                            {NEXT_STEPS.map((step, i) => (
                                <li
                                    key={step.task}
                                    className={step.owner === 'You' ? styles.mine : undefined}
                                    data-done={step.done || undefined}
                                >
                                    <span className={styles.box} aria-hidden="true" />
                                    <span className={styles.task}>{step.task}</span>
                                    <span className={styles.owner}>
                                        {step.owner} · {step.due}
                                    </span>
                                </li>
                            ))}
                        </ul>
                        </div>
                        </div>
                    </div>
                    <figcaption className={styles.previewCaption}>
                        <span>One conversation. A brief, decisions, and a clear next step.</span>
                        <span>Illustrative meeting · fictional Acme account</span>
                    </figcaption>
                </figure>
            </div>
        </section>
    );
}
