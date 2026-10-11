'use client';

import { useEffect, useId, useRef, useState } from 'react';
import styles from './Nav.module.css';

type Link = { href: string; label: string };

/**
 * The section links for narrow screens, where the inline list doesn't fit. A disclosure rather than a
 * drawer: one button, one list, closed by choosing a link, pressing Escape, or pressing the button again.
 */
export function NavMenu({ links }: { links: Link[] }) {
    const [open, setOpen] = useState(false);
    const panelId = useId();
    const menuRef = useRef<HTMLDivElement>(null);
    const buttonRef = useRef<HTMLButtonElement>(null);

    useEffect(() => {
        if (!open) return;
        const onKey = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                setOpen(false);
                buttonRef.current?.focus({ preventScroll: true });
            }
        };
        const onPointer = (event: PointerEvent) => {
            if (event.target instanceof Node && !menuRef.current?.contains(event.target)) setOpen(false);
        };
        const onFocus = (event: FocusEvent) => {
            if (event.target instanceof Node && !menuRef.current?.contains(event.target)) setOpen(false);
        };
        window.addEventListener('keydown', onKey);
        window.addEventListener('pointerdown', onPointer);
        window.addEventListener('focusin', onFocus);
        return () => {
            window.removeEventListener('keydown', onKey);
            window.removeEventListener('pointerdown', onPointer);
            window.removeEventListener('focusin', onFocus);
        };
    }, [open]);

    return (
        <div className={styles.menu} ref={menuRef}>
            <button ref={buttonRef} type="button" className={styles.menuButton} aria-expanded={open} aria-controls={panelId} onClick={() => setOpen(value => !value)}>
                {open ? 'Close' : 'Menu'}
                <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
                    {open ? (
                        <path d="M3.5 3.5l9 9M12.5 3.5l-9 9" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                    ) : (
                        <path d="M2.5 5.5h11M2.5 10.5h11" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                    )}
                </svg>
            </button>
            <nav id={panelId} aria-label="Sections" className={styles.menuPanel} hidden={!open}>
                <ul>
                    {links.map(link => (
                        <li key={link.href}>
                            <a href={link.href} onClick={() => setOpen(false)}>
                                {link.label}
                            </a>
                        </li>
                    ))}
                </ul>
            </nav>
        </div>
    );
}
