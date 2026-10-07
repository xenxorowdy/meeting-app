export async function copyToClipboard(text) {
    const value = String(text ?? '');

    try {
        if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(value);
            return;
        }
    } catch {
        // Fall through to the selection-based copy for contexts where clipboard
        // access is unavailable or denied.
    }

    if (typeof document === 'undefined' || !document.body || typeof document.execCommand !== 'function') {
        throw new Error('Clipboard access is unavailable in this context.');
    }

    const activeElement = document.activeElement;
    const selectionStart = typeof activeElement?.selectionStart === 'number' ? activeElement.selectionStart : null;
    const selectionEnd = typeof activeElement?.selectionEnd === 'number' ? activeElement.selectionEnd : null;
    const textarea = document.createElement('textarea');
    textarea.value = value;
    textarea.setAttribute('readonly', '');
    textarea.setAttribute('aria-hidden', 'true');
    textarea.tabIndex = -1;
    textarea.style.position = 'fixed';
    textarea.style.top = '0';
    textarea.style.left = '-9999px';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    textarea.setSelectionRange(0, value.length);

    let copied = false;
    try {
        copied = document.execCommand('copy');
    } finally {
        textarea.remove();
        if (activeElement?.isConnected) {
            activeElement.focus({ preventScroll: true });
            if (selectionStart !== null && selectionEnd !== null && typeof activeElement.setSelectionRange === 'function') {
                activeElement.setSelectionRange(selectionStart, selectionEnd);
            }
        }
    }

    if (!copied) throw new Error('Clipboard write was rejected.');
}
