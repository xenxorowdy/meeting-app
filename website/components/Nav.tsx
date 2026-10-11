import { GET_URL } from '@/lib/site';
import { Wordmark } from './Logo';
import { NavMenu } from './NavMenu';
import styles from './Nav.module.css';

const LINKS = [
    { href: '/#how', label: 'How it works' },
    { href: '/#commitments', label: 'Commitments' },
    { href: '/#ask', label: 'Ask' },
    { href: '/#privacy', label: 'Privacy' },
    { href: '/#pricing', label: 'Pricing' },
];

export function Nav() {
    return (
        <header className={styles.nav}>
            <div className={`wrap ${styles.inner}`}>
                <div className={styles.bar}>
                    <a href="/#top" className={styles.brand} aria-label="Kesami home">
                        <Wordmark />
                    </a>
                    <nav aria-label="Sections" className={styles.inline}>
                        <ul className={styles.links}>
                            {LINKS.map(link => (
                                <li key={link.href}>
                                    <a href={link.href}>{link.label}</a>
                                </li>
                            ))}
                        </ul>
                    </nav>
                    <NavMenu links={LINKS} />
                    <a className={styles.cta} href={GET_URL}>
                        Get Kesami
                    </a>
                </div>
            </div>
        </header>
    );
}
