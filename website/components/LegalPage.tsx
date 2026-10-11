import { Footer } from '@/components/Footer';
import { Nav } from '@/components/Nav';
import styles from './LegalPage.module.css';

export function LegalPage({ title, intro, children }: { title: string; intro: string; children: React.ReactNode }) {
    return (
        <>
            <Nav />
            <main id="main" className={styles.main} data-theme="light">
                <article className={styles.article}>
                    <a className="link" href="/">← Back to Kesami</a>
                    <header className={styles.header}>
                        <p className="label">Kesami · Legal</p>
                        <h1>{title}</h1>
                        <p className={styles.updated}>Last updated: <time dateTime="2026-10-06">6 October 2026</time></p>
                        <p className={styles.intro}>{intro}</p>
                    </header>
                    <div className={styles.content}>{children}</div>
                </article>
            </main>
            <Footer />
        </>
    );
}
