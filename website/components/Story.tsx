import { CALL, DECISIONS, EMAIL, MEETINGS, NEXT_STEPS, PEOPLE } from '@/lib/demo';
import { StepObserver } from './StepObserver';
import styles from './Story.module.css';

const meeting = MEETINGS.customer;

const PIPELINE = ['Meeting', 'Understand', 'Remember', 'Follow up', 'Act'];

const STEPS = [
    {
        n: '01',
        title: 'Record the meeting. No bot required.',
        body: 'Press ⌘R or Ctrl+R, or click New meeting. Your microphone becomes You, the meeting’s audio becomes everyone else, and the transcript writes itself while you talk.',
        facts: ['Meet · Zoom · Teams · anything with sound', 'Sound only, or screen + sound'],
    },
    {
        n: '02',
        title: 'When the call ends, the brief is ready.',
        body: 'A summary where every point links to the moment it was said, the decisions that were made, and next steps with an owner and a due date.',
        facts: ['Summary · Decisions · Next steps', 'Every point links to its moment'],
    },
    {
        n: '03',
        title: 'The follow-up is already drafted.',
        body: 'Kesami writes the recap email from what was agreed. Open it in your email app, change what you like, and send it yourself.',
        facts: ['Open in your email app, or copy it', 'Kesami never sends email for you'],
    },
    {
        n: '04',
        title: 'Send the work where it gets done.',
        body: 'One click turns each next step into a task in Jira, Linear, Asana or ClickUp, or posts the brief to Slack or Notion. Nothing leaves until you click, unless you choose to send after every meeting.',
        facts: ['Jira · Linear · Asana · ClickUp', 'Slack · Notion'],
    },
];

const TABS = ['Transcript', 'Brief', 'Follow-up', 'Send to'];

const SECTIONS = [
    { heading: 'Pricing', text: 'Acme needs the annual pricing in writing before signing.', t: CALL[0].t },
    { heading: 'Proposal', text: 'You’ll send it by Friday, with SSO included.', t: CALL[1].t },
    { heading: 'Technical', text: 'John’s rate-limit question is still open.', t: CALL[4].t },
];

const TOOLS = [
    { name: 'Jira', what: `${NEXT_STEPS.length} issues, one per next step`, action: 'Create tasks', primary: true },
    { name: 'Slack', what: 'The brief, to #acme-deal', action: 'Send' },
    { name: 'Notion', what: 'The brief, as a page', action: 'Send' },
];

const CONCEPTS = ['Remind me before Friday', 'Put the follow-up call on my calendar'];

const tone = Object.fromEntries(PEOPLE.map(person => [person.name, person.tone]));

export function Story() {
    return (
        <section className={styles.story} id="follow-through" data-theme="paper" data-active="1" aria-labelledby="flow-title">
            <StepObserver />
            <div className="wrap">
                <header className={styles.head}>
                    <p className="label" data-scramble>
                        From meeting to action
                    </p>
                    <h2 id="flow-title" className="display h2" data-reveal>
                        Turn conversations into <span className="em">follow-through.</span>
                    </h2>
                    <ol
                        className={styles.pipeline}
                        aria-label="What happens to a meeting"
                        data-reveal
                        style={{ '--d': '120ms' } as React.CSSProperties}
                    >
                        {PIPELINE.map(stage => (
                            <li key={stage}>{stage}</li>
                        ))}
                    </ol>
                </header>

                <div className={styles.layout}>
                    <div className={styles.frameWrap}>
                        <div
                            className={styles.frame}
                            data-theme="dark"
                            role="img"
                            aria-label="The Kesami app showing the meeting’s transcript, its brief, the drafted follow-up email and sending tasks to Jira"
                        >
                            <div className={styles.titlebar}>
                                <span className={styles.windowTitle}>{meeting.title}</span>
                                <span className={styles.tabs}>
                                    {TABS.map((tab, i) => (
                                        <span key={tab} className={styles.tab} data-tab={i + 1}>
                                            {tab}
                                        </span>
                                    ))}
                                </span>
                            </div>

                            <div className={styles.panes}>
                                <div className={styles.pane} data-pane="1">
                                    <div className={styles.paneHead}>
                                        <span>Transcript</span>
                                        <span className={styles.meta}>
                                            {PEOPLE.length} speakers · {meeting.date}
                                        </span>
                                    </div>
                                    <ol className={styles.lines}>
                                        {CALL.map(line => (
                                            <li key={line.t}>
                                                <span className={styles.time}>{line.t}</span>
                                                <span className={styles.who} data-tone={line.tone}>
                                                    {line.who}
                                                </span>
                                                <span>{line.text}</span>
                                            </li>
                                        ))}
                                    </ol>
                                </div>

                                <div className={styles.pane} data-pane="2">
                                    <div className={styles.paneHead}>
                                        <span>Meeting brief</span>
                                        <span className={styles.meta}>Ready when the meeting ended</span>
                                    </div>
                                    <dl className={styles.sections}>
                                        {SECTIONS.map(section => (
                                            <div key={section.heading}>
                                                <dt>{section.heading}</dt>
                                                <dd>
                                                    {section.text} <span className={styles.cite}>{section.t}</span>
                                                </dd>
                                            </div>
                                        ))}
                                    </dl>
                                    <p className={styles.sub}>Decisions</p>
                                    <ul className={styles.decisions}>
                                        {DECISIONS.map(decision => (
                                            <li key={decision}>{decision}</li>
                                        ))}
                                    </ul>
                                    <p className={styles.sub}>Next steps</p>
                                    <ul className={styles.next}>
                                        {NEXT_STEPS.map(step => (
                                            <li key={step.task} data-done={step.done || undefined}>
                                                <span className={styles.task}>{step.task}</span>
                                                <span className={styles.owner} data-tone={tone[step.owner]}>
                                                    {step.owner}
                                                </span>
                                                <span className={styles.meta}>{step.due}</span>
                                            </li>
                                        ))}
                                    </ul>
                                </div>

                                <div className={styles.pane} data-pane="3">
                                    <div className={styles.paneHead}>
                                        <span>Follow-up email</span>
                                        <span className={styles.meta}>Draft · edit before you send</span>
                                    </div>
                                    <div className={styles.email}>
                                        <p className={styles.emailRow}>
                                            <span className={styles.meta}>Subject</span>
                                            {EMAIL.subject}
                                        </p>
                                        <div className={styles.emailBody}>
                                            {EMAIL.body.map(paragraph => (
                                                <p key={paragraph}>{paragraph}</p>
                                            ))}
                                        </div>
                                    </div>
                                    <div className={styles.buttons}>
                                        <span className={styles.primary}>Open in email app</span>
                                        <span className={styles.secondary}>Copy email</span>
                                    </div>
                                </div>

                                <div className={styles.pane} data-pane="4">
                                    <div className={styles.paneHead}>
                                        <span>Send to</span>
                                        <span className={styles.meta}>Nothing is sent until you click</span>
                                    </div>
                                    <ul className={styles.tools}>
                                        {TOOLS.map(tool => (
                                            <li key={tool.name}>
                                                <span className={styles.toolName}>{tool.name}</span>
                                                <span className={styles.meta}>{tool.what}</span>
                                                <span className={tool.primary ? styles.primary : styles.secondary}>{tool.action}</span>
                                            </li>
                                        ))}
                                    </ul>
                                    <p className={styles.sub}>
                                        Next <span className={styles.conceptTag}>Concept</span>
                                    </p>
                                    <ul className={styles.tools}>
                                        {CONCEPTS.map(concept => (
                                            <li key={concept} className={styles.conceptRow}>
                                                <span className={styles.toolName}>{concept}</span>
                                                <span className={styles.secondary}>Confirm</span>
                                            </li>
                                        ))}
                                    </ul>
                                </div>
                            </div>
                        </div>
                    </div>

                    <ol className={styles.steps}>
                        {STEPS.map((step, i) => (
                            <li key={step.n} className={styles.step} data-step={i + 1}>
                                <h3 className={`display ${styles.stepTitle}`}>{step.title}</h3>
                                <p className={styles.body}>{step.body}</p>
                                <ul className={styles.facts}>
                                    {step.facts.map(fact => (
                                        <li key={fact}>{fact}</li>
                                    ))}
                                </ul>
                            </li>
                        ))}
                    </ol>
                </div>
            </div>
        </section>
    );
}
