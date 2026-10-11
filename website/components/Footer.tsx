import { CONTACT, PLATFORMS, RELEASES_URL } from '@/lib/site';
import { Wordmark } from './Logo';
import styles from './Footer.module.css';

const COLUMNS = [
    {
        title: 'Product',
        links: [
            { href: '/#how', label: 'How it works' },
            { href: '/#commitments', label: 'Commitments' },
            { href: '/#ask', label: 'Ask Kesami' },
            { href: '/#privacy', label: 'Privacy' },
            { href: '/#pricing', label: 'Pricing' },
            { href: '/#faq', label: 'FAQ' },
        ],
    },
    {
        title: 'Download',
        links: [
            { href: PLATFORMS.mac.href, label: 'macOS' },
            { href: PLATFORMS.windows.href, label: 'Windows' },
            { href: RELEASES_URL, label: 'All releases' },
        ],
    },
    {
        title: 'Legal',
        links: [
            { href: '/privacy', label: 'Privacy policy' },
            { href: '/terms', label: 'Terms of service' },
        ],
    },
    {
        title: 'Contact',
        links: [
            { href: `mailto:${CONTACT.email}`, label: CONTACT.email },
            { href: CONTACT.phone.href, label: CONTACT.phone.label },
        ],
    },
];

export function Footer() {
    return (
        <footer className={styles.footer} data-theme="paper">
            <div className={`wrap ${styles.top}`}>
                <a className={styles.brand} href="/#top" aria-label="Kesami home"><Wordmark /></a>
                <p className={styles.tagline}>Remember what you promised. Get it done.</p>
            </div>
            <div className={`wrap ${styles.navigation}`}>
                {COLUMNS.map(column => (
                    <nav key={column.title} aria-label={column.title} className={styles.column}>
                        <ul>
                            {column.links.map(link => (
                                <li key={link.label}>
                                    <a className="link" href={link.href}>
                                        {link.label}
                                    </a>
                                </li>
                            ))}
                        </ul>
                    </nav>
                ))}
            </div>
            <div className={`wrap ${styles.bottom}`}>
                <span>© 2026 Kesami</span>
                <span>Kesami. Meeting memory for macOS and Windows.</span>
            </div>
        </footer>
    );
}
