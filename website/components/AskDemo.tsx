'use client';

import { useState } from 'react';
import { ANSWERS, MEETINGS } from '@/lib/demo';
import styles from './Ask.module.css';

// Splits each answer into words once, each with its place in the reveal sequence, so the typing effect
// is pure CSS: no timers, no state updates per word. Numbers are citations, as the app numbers them.
function sequence(parts: (string | number)[]) {
    let index = 0;
    return parts.flatMap((part, p) =>
        typeof part === 'string'
            ? part
                  .split(/(?=\s)/)
                  .filter(Boolean)
                  .map((word, w) => ({ key: `${p}-${w}`, word, cite: null as number | null, i: index++ }))
            : [{ key: `${p}-cite`, word: '', cite: part, i: index++ }]
    );
}

const SEQUENCES = ANSWERS.map(answer => sequence(answer.parts));

export function AskDemo() {
    const [active, setActive] = useState(0);
    const [focus, setFocus] = useState<number | null>(null);
    const answer = ANSWERS[active];

    return (
        <div className={styles.demo}>
            <div className={styles.chat}>
                <p className={styles.try}>Try asking</p>
                <div className={styles.questions} role="group" aria-label="Example questions">
                    {ANSWERS.map((item, i) => (
                        <button
                            key={item.q}
                            type="button"
                            className={styles.question}
                            aria-label={item.q}
                            aria-pressed={active === i}
                            onClick={() => {
                                setActive(i);
                                setFocus(null);
                            }}
                        >
                            {item.label}
                        </button>
                    ))}
                </div>

                <div className={styles.thread} aria-live="polite">
                    <p className={styles.scope}>
                        Search in <span>{answer.scope}</span>
                    </p>
                    <p className={styles.asked}>{answer.q}</p>
                    <p key={active} className={styles.answer}>
                        {SEQUENCES[active].map(token =>
                            token.cite ? (
                                <button
                                    key={token.key}
                                    type="button"
                                    className={styles.cite}
                                    style={{ '--i': token.i } as React.CSSProperties}
                                    aria-label={`Show source ${token.cite}`}
                                    onMouseEnter={() => setFocus(token.cite)}
                                    onMouseLeave={() => setFocus(null)}
                                    onFocus={() => setFocus(token.cite)}
                                    onBlur={() => setFocus(null)}
                                    onClick={() => setFocus(token.cite)}
                                >
                                    {token.cite}
                                </button>
                            ) : (
                                <span key={token.key} className={styles.word} style={{ '--i': token.i } as React.CSSProperties}>
                                    {token.word}
                                </span>
                            )
                        )}
                    </p>
                    <p className={styles.coverage}>{answer.coverage}</p>
                </div>
            </div>

            <figure className={styles.sources}>
                <figcaption>
                    <span>Sources ({answer.sources.length})</span>
                    <span className={styles.kind}>From your meetings</span>
                </figcaption>
                <ol key={active}>
                    {answer.sources.map((source, i) => {
                        const meeting = MEETINGS[source.id];
                        return (
                            <li key={`${source.id}-${source.t}`} className={focus === i + 1 ? styles.focused : undefined}>
                                <span className={styles.n}>{i + 1}</span>
                                <span className={styles.where}>
                                    <strong>{meeting.title}</strong>
                                    <span>
                                        {source.t} · {meeting.date}
                                    </span>
                                </span>
                                <q className={styles.quote}>
                                    <span className={styles.who}>{source.who}:</span> {source.quote}
                                </q>
                            </li>
                        );
                    })}
                </ol>
            </figure>
        </div>
    );
}
