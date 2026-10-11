import { FOLDER, MEETINGS } from '@/lib/demo';
import styles from './Desktop.module.css';

// apps/ui/src/App.jsx: ⌘ or Ctrl with 1–6 switches views, E exports, comma opens settings, R records.
const SHORTCUTS = [
    { what: 'Start or stop recording', mac: '⌘ R', win: 'Ctrl R' },
    { what: 'Jump between views', mac: '⌘ 1–6', win: 'Ctrl 1–6' },
    { what: 'Export notes', mac: '⌘ E', win: 'Ctrl E' },
    { what: 'Settings', mac: '⌘ ,', win: 'Ctrl ,' },
];

const FEATURES = [
    {
        title: 'Quick capture',
        body: 'One shortcut starts recording. Sound only by default; add the screen when the slides matter.',
    },
    {
        title: 'Within reach during the call',
        body: 'A small widget floats above your meeting: mute your mic or the meeting, pause, stop, or ask what you just missed.',
    },
    {
        title: 'A library you can search',
        body: 'Find any meeting by its title or its brief from one box, filed in folders by customer, project or team.',
    },
];

const LIBRARY = [MEETINGS.customer, MEETINGS.pricingSync, MEETINGS.northwind, MEETINGS.globex, MEETINGS.technical, MEETINGS.discovery];
const FOLDERS = ['All meetings', FOLDER, 'Pricing', 'Northwind', 'Globex'];

function Library({ active }: { active: string }) {
    return (
        <div className={styles.app}>
            <aside className={styles.sidebar}>
                {FOLDERS.map(folder => (
                    <span key={folder} className={folder === active ? styles.current : undefined}>
                        {folder}
                    </span>
                ))}
            </aside>
            <div className={styles.main}>
                <span className={styles.search}>Search your meetings…</span>
                <ul className={styles.list}>
                    {LIBRARY.filter(meeting => active === 'All meetings' || meeting.folder === active).map(meeting => (
                        <li key={meeting.title}>
                            <span className={styles.name}>{meeting.title}</span>
                            <span className={styles.when}>
                                {meeting.date} · {meeting.minutes} min
                            </span>
                        </li>
                    ))}
                </ul>
            </div>
        </div>
    );
}

export function Desktop() {
    return (
        <section className={styles.desktop} id="desktop" data-theme="paper" aria-labelledby="desktop-title">
            <div className="wrap">
                <div className={styles.head}>
                    <p className="label" data-scramble>
                        macOS and Windows
                    </p>
                    <h2 id="desktop-title" className="display h2" data-reveal>
                        Built for your <span className="em">desktop workflow.</span>
                    </h2>
                    <p className="lead" data-reveal style={{ '--d': '120ms' } as React.CSSProperties}>
                        One app on a Mac or a PC: no browser tab to keep open, your library in a folder you own, and out of the way until the next
                        call.
                    </p>
                </div>

                <div className={styles.layout}>
                    <div
                        className={styles.stage}
                        role="img"
                        aria-label="Illustrative Kesami meeting library for macOS and Windows, with a recording widget"
                    >
                        <div className={styles.window} data-theme="dark">
                            <Library active="All meetings" />
                        </div>

                        <div className={styles.widget} data-theme="dark">
                            <span className={styles.rec} />
                            <span className={styles.widgetLabel}>Recording</span>
                            <span className={styles.widgetTime}>12:04</span>
                            <span className={styles.widgetStop}>Stop</span>
                        </div>
                        <p className={styles.previewNote}>Illustrative library · macOS and Windows</p>
                    </div>

                    <div className={styles.copy}>
                        <ul className={styles.features}>
                            {FEATURES.map((feature, i) => (
                                <li key={feature.title} data-reveal style={{ '--d': `${i * 100}ms` } as React.CSSProperties}>
                                    <h3>{feature.title}</h3>
                                    <p>{feature.body}</p>
                                </li>
                            ))}
                        </ul>

                        <table className={styles.keys} data-reveal>
                            <caption>Keyboard-friendly</caption>
                            <thead>
                                <tr>
                                    <th scope="col">Action</th>
                                    <th scope="col">macOS</th>
                                    <th scope="col">Windows</th>
                                </tr>
                            </thead>
                            <tbody>
                                {SHORTCUTS.map(shortcut => (
                                    <tr key={shortcut.what}>
                                        <th scope="row">{shortcut.what}</th>
                                        <td>
                                            <kbd>{shortcut.mac}</kbd>
                                        </td>
                                        <td>
                                            <kbd>{shortcut.win}</kbd>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>

                        <p className={styles.extra}>
                            On a Mac, Kesami also sits in the menu bar and offers to record when Meet or Zoom opens your microphone.
                        </p>
                    </div>
                </div>
            </div>
        </section>
    );
}
