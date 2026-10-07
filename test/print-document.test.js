const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const MODULE_URL = pathToFileURL(path.join(__dirname, '..', 'apps', 'ui', 'src', 'lib', 'printDocument.js')).href;

function printTarget() {
    const listeners = [];
    const nodes = [];
    let prints = 0;
    const target = {
        document: {
            getElementById: id => nodes.find(node => node.id === id && !node.removed) || null,
            createElement: () => ({ style: {}, removed: false, remove() { this.removed = true; } }),
            body: { appendChild: node => nodes.push(node) },
        },
        addEventListener: (type, listener) => listeners.push({ type, listener }),
        removeEventListener: (type, listener) => {
            const index = listeners.findIndex(entry => entry.type === type && entry.listener === listener);
            if (index !== -1) listeners.splice(index, 1);
        },
        print: () => { prints += 1; },
    };
    const fire = type => listeners.filter(entry => entry.type === type).forEach(entry => entry.listener());
    return { target, nodes, listeners, fire, prints: () => prints };
}

test('meeting text is escaped before it reaches the print document', async () => {
    const { escapeHtml, markdownToPrintHtml } = await import(MODULE_URL);
    assert.equal(escapeHtml(`<img src=x onerror="alert('x')"> & more`), '&lt;img src=x onerror=&quot;alert(&#39;x&#39;)&quot;&gt; &amp; more');
    assert.equal(escapeHtml(null), '');
    assert.equal(
        markdownToPrintHtml('## Notes\n- [x] Ship **v2** <script>alert(1)</script>\n\nPlain _text_ & more\ncontinues here'),
        '<h3>Notes</h3><ul><li>Ship <strong>v2</strong> &lt;script&gt;alert(1)&lt;/script&gt;</li></ul><p>Plain <em>text</em> &amp; more continues here</p>'
    );
});

test('printing mounts one hidden print root and removes it after the dialog closes', async () => {
    const { printHtml } = await import(MODULE_URL);
    const { target, nodes, listeners, fire, prints } = printTarget();
    printHtml('<h1>First</h1>', { target });
    printHtml('<h1>Second</h1>', { target });
    assert.equal(prints(), 2);
    assert.equal(nodes.length, 2);
    assert.equal(nodes[0].removed, true, 'a second print replaces the first root');
    assert.equal(nodes[1].id, 'ks-print-root');
    assert.equal(nodes[1].style.display, 'none');
    assert.match(nodes[1].innerHTML, /@media print[\s\S]*<h1>Second<\/h1>$/);
    fire('afterprint');
    assert.equal(nodes[1].removed, true);
    assert.equal(listeners.length, 0);
});
