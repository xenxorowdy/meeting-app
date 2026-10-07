const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const PRINT_ROOT_ID = 'ks-print-root';
const CLEANUP_FALLBACK_MS = 300000;

const PRINT_STYLE = `
@media print {
    html, body { height: auto !important; overflow: visible !important; background: #fff !important; }
    body > *:not(#${PRINT_ROOT_ID}) { display: none !important; }
    #${PRINT_ROOT_ID} { display: block !important; font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", Inter, sans-serif; line-height: 1.4; color: #1d1d1f; padding: 0 8px; max-width: 680px; margin: 0 auto; font-size: 13px; }
    #${PRINT_ROOT_ID} .print-brand { display: flex; align-items: center; gap: 10px; margin-bottom: 24px; font-size: 13px; font-weight: 600; letter-spacing: 0.02em; }
    #${PRINT_ROOT_ID} .print-brand svg { width: 24px; height: 24px; }
    #${PRINT_ROOT_ID} h1 { font-size: 24px; line-height: 1.2; letter-spacing: -0.02em; font-weight: 600; margin: 0 0 8px; }
    #${PRINT_ROOT_ID} h2 { font-size: 15px; line-height: 1.2; font-weight: 600; margin: 24px 0 8px; padding-bottom: 4px; border-bottom: 1px solid #e5e5ea; }
    #${PRINT_ROOT_ID} h3 { font-size: 13px; font-weight: 600; margin: 16px 0 4px; }
    #${PRINT_ROOT_ID} p { margin: 0 0 8px; }
    #${PRINT_ROOT_ID} .print-meta { color: #6e6e73; font-size: 12px; margin-bottom: 24px; }
    #${PRINT_ROOT_ID} ul { padding-left: 16px; margin: 0 0 8px; }
    #${PRINT_ROOT_ID} li { margin-bottom: 4px; }
    #${PRINT_ROOT_ID} pre { white-space: pre-wrap; background: #f5f5f7; border: 1px solid #e5e5ea; padding: 12px; border-radius: 8px; font-size: 12px; }
    #${PRINT_ROOT_ID} .print-turn { margin-bottom: 8px; break-inside: avoid; }
    #${PRINT_ROOT_ID} .print-speaker { font-weight: 600; }
    #${PRINT_ROOT_ID} .print-time { color: #6e6e73; font-size: 11px; }
}`;

export function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, character => HTML_ESCAPES[character]);
}

function inline(text) {
    return escapeHtml(text)
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
        .replace(/(^|[\s(])_([^_]+)_(?=$|[\s).,;:!?])/g, '$1<em>$2</em>');
}

export function markdownToPrintHtml(markdown = '') {
    const html = [];
    let list = [];
    let paragraph = [];
    const flushList = () => {
        if (list.length) html.push(`<ul>${list.map(item => `<li>${inline(item)}</li>`).join('')}</ul>`);
        list = [];
    };
    const flushParagraph = () => {
        if (paragraph.length) html.push(`<p>${inline(paragraph.join(' '))}</p>`);
        paragraph = [];
    };
    for (const raw of String(markdown).split('\n')) {
        const line = raw.trim();
        const heading = line.match(/^#{1,6}\s+(.*)$/);
        const bullet = line.match(/^[-*•]\s+(?:\[[ xX]\]\s+)?(.*)$/);
        if (!line) {
            flushList();
            flushParagraph();
        } else if (heading) {
            flushList();
            flushParagraph();
            html.push(`<h3>${inline(heading[1])}</h3>`);
        } else if (bullet) {
            flushParagraph();
            list.push(bullet[1]);
        } else {
            flushList();
            paragraph.push(line);
        }
    }
    flushList();
    flushParagraph();
    return html.join('');
}

export function printHtml(bodyHtml, { target = globalThis } = {}) {
    const doc = target.document;
    doc.getElementById(PRINT_ROOT_ID)?.remove();
    const root = doc.createElement('div');
    root.id = PRINT_ROOT_ID;
    root.style.display = 'none';
    root.innerHTML = `<style>${PRINT_STYLE}</style>${bodyHtml}`;
    doc.body.appendChild(root);
    let timer = null;
    const cleanup = () => {
        clearTimeout(timer);
        target.removeEventListener('afterprint', cleanup);
        root.remove();
    };
    target.addEventListener('afterprint', cleanup);
    timer = setTimeout(cleanup, CLEANUP_FALLBACK_MS);
    target.print();
}
