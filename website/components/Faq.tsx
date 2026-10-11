import { LANGUAGES } from '@/lib/site';
import { Plus } from './Icons';
import styles from './Faq.module.css';

// Every answer here is checked against the code or the README; keep it that way when editing.
export const QUESTIONS = [
    {
        q: 'Does a bot join my meetings?',
        a: 'No. Kesami records on your computer: your microphone for you, the meeting’s audio for everyone else. Nobody on the call gets an invite, a join request or a bot in the participant list.',
    },
    {
        q: 'Which meeting apps does it work with?',
        a: 'Anything that plays sound on your computer — Google Meet, Zoom, Microsoft Teams, Slack huddles, even a recorded video. Kesami numbers the voices it hears; rename a speaker once and every line follows, with the calendar invite’s attendees suggested as names.',
    },
    {
        q: 'Which computers are supported?',
        a: 'Macs with Apple silicon (M1 or later) on macOS 13 Ventura or newer, and 64-bit PCs on Windows 10 or 11. There is no Intel Mac or Windows on Arm build yet.',
    },
    {
        q: 'Is anything different on Windows?',
        a: 'One thing: how Kesami hears the other side of the call. On a Mac it captures the meeting’s sound directly. On Windows it does that when you record with Screen + sound; for audio-only meetings, pick a loopback input such as Stereo Mix or VB-Audio Cable under Settings › Audio › Meeting audio. Your own microphone works the same everywhere.',
    },
    {
        q: 'My computer warns me before opening Kesami.',
        a: 'Kesami isn’t code-signed yet, so each system asks once. On a Mac, open System Settings → Privacy & Security, find the message about Kesami and click Open Anyway. On Windows, when SmartScreen says “Windows protected your PC”, click More info, then Run anyway. Updates aren’t automatic for now: download new versions from the releases page.',
    },
    {
        q: 'Where are my recordings and notes?',
        a: 'On your computer, in Documents › Kesami Meetings — one folder per meeting, with the transcript and summary as Markdown and the details as JSON. While you record, audio streams through Kesami’s relay for live transcription. When a meeting ends, its transcript goes to the AI to write the brief (you can switch that off), and a question sends only the most relevant excerpts.',
    },
    {
        q: 'Which languages does it understand?',
        a: `${LANGUAGES.slice(0, -1)
            .map(language => language.name)
            .join(', ')} and ${LANGUAGES[LANGUAGES.length - 1].name} — or let Kesami detect the language for you.`,
    },
    {
        q: 'Do I need an account?',
        a: 'Yes, a Google sign-in. Your free hours and your Pro plan are attached to it, and it lets Kesami transcribe and summarise through its own relay instead of asking you for API keys.',
    },
];

export function Faq() {
    return (
        <section className={styles.faq} id="faq" data-theme="paper" aria-labelledby="faq-title">
            <div className={`wrap ${styles.layout}`}>
                <div className={styles.head}>
                    <p className="label" data-scramble>
                        FAQ
                    </p>
                    <h2 id="faq-title" className="display h2" data-reveal>
                        Questions, <span className="em">answered.</span>
                    </h2>
                </div>
                <div className={styles.list}>
                    {QUESTIONS.map(item => (
                        <details key={item.q} className={styles.item}>
                            <summary>
                                <span>{item.q}</span>
                                <span className={styles.icon}>
                                    <Plus />
                                </span>
                            </summary>
                            <p>{item.a}</p>
                        </details>
                    ))}
                </div>
            </div>
        </section>
    );
}
