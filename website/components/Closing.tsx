import { PLATFORMS } from '@/lib/site';
import { AppleLogo, WindowsLogo } from './Icons';
import styles from './Closing.module.css';

const CHOICES = [
    { id: 'mac', icon: <AppleLogo size={22} />, ...PLATFORMS.mac },
    { id: 'windows', icon: <WindowsLogo size={20} />, ...PLATFORMS.windows },
] as const;

// The download choice every "Get Kesami" button points at. The head script tags <html> with the
// visitor's OS before paint, and CSS fills that platform's button; anyone else sees two equal choices.
export function Closing() {
    return (
        <section className={styles.closing} id="download" data-theme="light" aria-labelledby="closing-title">
            <div className="wrap">
                <h2 id="closing-title" className={`display ${styles.title}`} data-reveal>
                    Your next meeting, <span className="em">remembered.</span>
                </h2>
                <p className={`lead ${styles.lead}`} data-reveal style={{ '--d': '120ms' } as React.CSSProperties}>
                    Free to start, with two hours of meetings a month. Available for macOS and Windows.
                </p>

                <ul className={styles.platforms} aria-label="Downloads">
                    {CHOICES.map((choice, i) => (
                        <li
                            key={choice.id}
                            className={styles.platform}
                            data-os={choice.id}
                            data-reveal
                            style={{ '--d': `${200 + i * 100}ms` } as React.CSSProperties}
                        >
                            <p className={styles.os}>
                                {choice.icon}
                                {choice.name}
                            </p>
                            <p className={styles.requires}>{choice.requires}</p>
                            <a className={`btn ${styles.get}`} href={choice.href}>
                                {choice.action}
                            </a>
                            <p className={styles.file}>{choice.file}</p>
                        </li>
                    ))}
                </ul>
                <p className={styles.unsigned}>
                    The builds aren’t code-signed yet, so macOS and Windows each ask once before the first launch.{' '}
                    <a className="link" href="#faq">
                        Here’s what to click
                    </a>
                    .
                </p>
                <p className={styles.mobile}>Kesami is a desktop app. Open this page on your Mac or PC to install it.</p>
            </div>
        </section>
    );
}
