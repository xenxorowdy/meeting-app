import type { ReactNode } from 'react';
import { Footer } from './Footer';
import { Nav } from './Nav';
import styles from './Legal.module.css';

export type LegalSection = { id: string; title: string; body: ReactNode };

type Props = {
    label: string;
    title: string;
    updated: { iso: string; text: string };
    intro: ReactNode;
    sections: LegalSection[];
};

export function Legal({ label, title, updated, intro, sections }: Props) {
    return (
        <>
            <Nav />
            <main id="main">
                <section className={styles.legal} data-theme="paper" aria-labelledby="legal-title">
                    <div className={`wrap ${styles.head}`}>
                        <p className="label">{label}</p>
                        <h1 id="legal-title" className={`display ${styles.title}`}>
                            {title}
                        </h1>
                        <p className={styles.updated}>
                            Last updated <time dateTime={updated.iso}>{updated.text}</time>
                        </p>
                        <div className={styles.intro}>{intro}</div>
                    </div>
                    <div className={`wrap ${styles.layout}`}>
                        <nav className={styles.toc} aria-label="On this page">
                            <p className={styles.tocTitle}>On this page</p>
                            <ol>
                                {sections.map(section => (
                                    <li key={section.id}>
                                        <a href={`#${section.id}`}>{section.title}</a>
                                    </li>
                                ))}
                            </ol>
                        </nav>
                        <div className={styles.body}>
                            {sections.map(section => (
                                <section key={section.id} id={section.id} aria-labelledby={`${section.id}-title`}>
                                    <h2 id={`${section.id}-title`}>{section.title}</h2>
                                    {section.body}
                                </section>
                            ))}
                        </div>
                    </div>
                </section>
            </main>
            <Footer />
        </>
    );
}
