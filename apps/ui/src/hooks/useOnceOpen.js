import { useState } from 'react';

/**
 * True from the first time `isOpen` goes true, and true for the rest of the
 * session. Lazy surfaces use this so their chunk is fetched on first use rather
 * than at startup, while staying mounted afterwards so their close animation and
 * any restored state still work.
 */
export function useOnceOpen(isOpen) {
    const [opened, setOpened] = useState(Boolean(isOpen));
    if (isOpen && !opened) setOpened(true);
    return opened;
}
