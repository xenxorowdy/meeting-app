import { CALL, MEETINGS } from '@/lib/demo';
import styles from './Privacy.module.css';

// The data boundary as the code draws it (docs/HOW-KESAMI-WORKS.md, CLOUD_TRANSCRIPTION.md). Don't sharpen
// it into "nothing leaves your computer": transcription and AI answers go through Kesami's relay, and a
// brief is written automatically when a meeting ends unless that setting is off.
const POINTS = [
    {
        n: '01',
        title: 'Stays on your computer',
        body: 'Every meeting is a folder in Documents › Kesami Meetings: the transcript and brief as Markdown, the details as JSON, and the recording. The search index, the embeddings behind Ask and your Ask history are built locally and live beside them.',
    },
    {
        n: '02',
        title: 'Sent while you record',
        body: 'Your audio streams through Kesami’s relay to Sarvam, which transcribes it live. The relay passes it on and keeps no copy. No bot joins the call, so nobody else sees Kesami at all.',
    },
    {
        n: '03',
        title: 'Sent when AI writes or answers',
        body: 'When a meeting ends, its transcript goes to Google Gemini (OpenAI as a fallback) to write the brief; you can switch automatic briefs off. A question sends only the dozen or so most relevant excerpts, never your whole library.',
    },
];

// apps/core-backend/src/library.rs: one "YYYY-MM-DD Title" folder per meeting; .kesami-chat holds the index.
const FILES = [
    { name: 'meeting.json', kind: 'JSON' },
    { name: 'transcript.md', kind: 'Markdown', open: true },
    { name: 'summary.md', kind: 'Markdown' },
    { name: 'recording.webm', kind: 'Recording' },
];

const OTHER_FOLDERS = [MEETINGS.pricingSync, MEETINGS.technical, MEETINGS.discovery].map(meeting => `2026-${isoDay(meeting.date)} ${meeting.title}`);

function isoDay(date: string) {
    const [month, day] = date.split(' ');
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return `${String(months.indexOf(month) + 1).padStart(2, '0')}-${day.padStart(2, '0')}`;
}

function Folder() {
    return (
        <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
            <path
                d="M1.5 4a1.5 1.5 0 0 1 1.5-1.5h3.2l1.5 1.5H13A1.5 1.5 0 0 1 14.5 5.5v6A1.5 1.5 0 0 1 13 13H3a1.5 1.5 0 0 1-1.5-1.5Z"
                fill="var(--color-folder)"
            />
        </svg>
    );
}

function Doc() {
    return (
        <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M4 1.5h5.5L12.5 4.5v9a1 1 0 0 1-1 1h-7.5a1 1 0 0 1-1-1v-11a1 1 0 0 1 1-1Z" fill="var(--color-paper)" stroke="var(--line-strong)" />
            <path d="M9.5 1.5v3h3" fill="none" stroke="var(--line-strong)" />
        </svg>
    );
}

export function Privacy() {
    const meeting = MEETINGS.customer;
    return (
        <section className={styles.privacy} id="privacy" data-theme="light" aria-labelledby="privacy-title">
            <div className={`wrap ${styles.layout}`}>
                <div className={styles.copy}>
                    <p className="label" data-scramble>
                        Privacy
                    </p>
                    <h2 id="privacy-title" className="display h2" data-reveal>
                        Your meetings are files, <span className="em">not a feed.</span>
                    </h2>
                    <ol className={styles.points}>
                        {POINTS.map((point, i) => (
                            <li key={point.n} data-reveal style={{ '--d': `${i * 100}ms` } as React.CSSProperties}>
                                <h3 className={styles.title}>{point.title}</h3>
                                <p>{point.body}</p>
                            </li>
                        ))}
                    </ol>
                    <p className={styles.footnote} data-reveal>
                        Kesami’s own servers hold your account and plan, not your meetings. Slack, Notion, Jira and the other connectors send only
                        when you click, or after every meeting if you turn that on.
                    </p>
                </div>

                <figure className={styles.finder} data-reveal aria-label="The Kesami Meetings folder with a transcript open">
                    <div className={styles.bar}>
                        <span className={styles.path}>
                            Documents <span aria-hidden="true">›</span> <strong>Kesami Meetings</strong>
                        </span>
                    </div>
                    <div className={styles.body}>
                        <ul className={styles.tree}>
                            <li className={styles.folderOpen}>
                                <span className={styles.row}>
                                    <span className={styles.chev} aria-hidden="true">
                                        ▾
                                    </span>
                                    <Folder />
                                    2026-{isoDay(meeting.date)} {meeting.title}
                                </span>
                                <ul>
                                    {FILES.map(file => (
                                        <li key={file.name} className={file.open ? styles.selected : undefined}>
                                            <span className={styles.row}>
                                                <Doc />
                                                <span className={styles.file}>{file.name}</span>
                                                <span className={styles.kind}>{file.kind}</span>
                                            </span>
                                        </li>
                                    ))}
                                </ul>
                            </li>
                            {OTHER_FOLDERS.map(folder => (
                                <li key={folder}>
                                    <span className={styles.row}>
                                        <span className={styles.chev} aria-hidden="true">
                                            ▸
                                        </span>
                                        <Folder />
                                        {folder}
                                    </span>
                                </li>
                            ))}
                            <li className={styles.hidden}>
                                <span className={styles.row}>
                                    <span className={styles.chev} aria-hidden="true">
                                        ▸
                                    </span>
                                    <Folder />
                                    .kesami-chat
                                    <span className={styles.kind}>Search index · Ask history</span>
                                </span>
                            </li>
                        </ul>
                        <pre className={styles.preview}>
                            <span className={styles.h}># {meeting.title} — transcript</span>
                            {CALL.slice(0, 3).map(line => (
                                <span key={line.t}>
                                    {'\n\n'}
                                    <b>
                                        **[{line.t}] {line.who}:**
                                    </b>{' '}
                                    {line.text}
                                </span>
                            ))}
                        </pre>
                    </div>
                </figure>
            </div>
        </section>
    );
}
