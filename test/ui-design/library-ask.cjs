// Synthetic Electron check for the library/folder/Ask restyle. No user data or backend.
// Run after build:ui: node_modules/.bin/electron test/ui-design/library-ask.cjs
const { app, BrowserWindow } = require('electron');
const { build } = require('esbuild');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');

async function run() {
    const output = await fs.mkdtemp(path.join(os.tmpdir(), 'kesami-library-ask-'));
    console.log(`Render output: ${output}`);
    await fs.mkdir(path.join(output, 'profile'), { recursive: true });
    app.setPath('userData', path.join(output, 'profile'));
    await build({
        entryPoints: [path.join(__dirname, 'fixture.jsx')], bundle: true, outdir: output,
        format: 'iife', loader: { '.woff2': 'file' },
        alias: { '@': path.resolve(__dirname, '../../apps/ui/src') },
        define: { 'process.env.NODE_ENV': '"development"', 'import.meta.env': '{}' },
    });
    const assets = path.resolve(__dirname, '../../apps/ui/dist/assets');
    const css = (await fs.readdir(assets)).find(name => /^index-.*\.css$/.test(name));
    assert(css, 'Build the UI before running this render check');
    await fs.writeFile(path.join(output, 'index.html'), `<!doctype html><html class="dark"><head><meta charset="utf-8"><link rel="stylesheet" href="file://${assets}/${css}"><link rel="stylesheet" href="fixture.css"><style>html,body,#root{height:100%;margin:0}</style></head><body><div id="root"></div><script src="fixture.js"></script></body></html>`);
    await app.whenReady();
    const window = new BrowserWindow({ show: false, width: 1280, height: 900, useContentSize: true,
        webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
    const errors = [];
    window.webContents.on('console-message', ({ level, message }) => {
        if (level === 'error' && !message.includes('Content Security Policy')) errors.push(message);
    });
    window.webContents.session.webRequest.onBeforeRequest(
        { urls: ['http://127.0.0.1:48900/*', 'ws://127.0.0.1:48900/*'] },
        (_, done) => done({ cancel: true })
    );
    const evaluate = script => window.webContents.executeJavaScript(script);
    const settle = () => evaluate('new Promise(resolve => setTimeout(resolve, 150))');
    const waitFor = async (expression, label) => assert(await evaluate(`new Promise(resolve => {
        const start = Date.now(); const timer = setInterval(() => {
            if (${expression}) { clearInterval(timer); resolve(true); }
            else if (Date.now() - start > 5000) { clearInterval(timer); resolve(false); }
        }, 25);
    })`), label);
    const click = async (selector, label = selector) => {
        assert(await evaluate(`(() => { const node = document.querySelector(${JSON.stringify(selector)}); if (!node || node.disabled) return false; node.click(); return true; })()`), `Available: ${label}`);
        await settle();
    };
    const clickText = async (text, selector = 'button') => {
        assert(await evaluate(`(() => { const node = [...document.querySelectorAll(${JSON.stringify(selector)})].find(n => n.textContent.trim().includes(${JSON.stringify(text)})); if (!node || node.disabled) return false; node.click(); return true; })()`), `Available: ${text}`);
        await settle();
    };
    const capture = async name => {
        await settle();
        await fs.writeFile(path.join(output, `${name}.png`), (await window.webContents.capturePage()).toPNG());
    };
    const checkLayouts = async (name, selector) => {
        if (process.argv.includes('--interactions-only')) return;
        for (const theme of ['dark', 'light']) {
            await evaluate(`window.fixtureSetTheme(${JSON.stringify(theme)})`);
            for (const width of [1280, 320, 375, 414, 768]) {
                window.setContentSize(width, 900);
                await settle();
                const layout = await evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); const r = el?.getBoundingClientRect(); return {
                    root: document.documentElement.scrollWidth, viewport: innerWidth,
                    width: el?.clientWidth, scroll: el?.scrollWidth,
                    left: r?.left, right: r?.right,
                }; })()`);
                assert(layout.width > 0 && layout.root <= layout.viewport && layout.scroll <= layout.width && layout.left >= 0 && layout.right <= layout.viewport + 1, `${name} ${theme} ${width}: ${JSON.stringify(layout)}`);
                await capture(`${name}-${theme}-${width}`);
            }
        }
        window.setContentSize(1280, 900);
        await settle();
        console.log(`${name}: both themes, desktop and four narrow widths passed`);
    };
    await window.loadFile(path.join(output, 'index.html'));
    await waitFor('!!window.fixtureEnterWorkspace', 'Fixture ready');
    await evaluate('window.fixtureEnterWorkspace()');
    await waitFor("!!document.querySelector('.ks-workspace')", 'Workspace ready');
    await click('[aria-label="Choose a folder for Design System Weekly"]');
    await waitFor("!!document.querySelector('.ks-folder-dropdown [role=\"menu\"]')", 'Agenda uses HeroUI Dropdown.Menu');
    await waitFor("document.activeElement === document.querySelector('.ks-folder-picker-search input')", 'Folder search receives focus');
    await checkLayouts('agenda-folder-dropdown', '.ks-folder-dropdown');
    await window.webContents.insertText('Design');
    await settle();
    assert(await evaluate("![...document.querySelectorAll('.ks-folder-dropdown [role^=\"menuitem\"]')].some(el => el.textContent.includes('Product'))"), 'Search filters folder choices');
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Down' });
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Down' });
    await settle();
    const folderFocus = await evaluate("({role: document.activeElement?.getAttribute('role'), text: document.activeElement?.textContent, tag: document.activeElement?.tagName})");
    assert(folderFocus.role?.startsWith('menuitem'), `ArrowDown moves from search into folder choices: ${JSON.stringify(folderFocus)}`);
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
    await waitFor("!document.querySelector('.ks-folder-dropdown')", 'Escape closes agenda dropdown');
    await click('[aria-label="Choose a folder for Design System Weekly"]');
    await evaluate(`window.fixtureOriginalFetch = window.fetch; window.fixtureFolderFails = true;
        window.fetch = (url, options = {}) => window.fixtureFolderFails && String(url).endsWith('/api/folders/rules') && options.method === 'POST'
            ? Promise.resolve(new Response(JSON.stringify({error: 'Synthetic filing failure'}), {status: 503})) : window.fixtureOriginalFetch(url, options); void 0;`);
    await clickText('Design Sync', '.ks-folder-dropdown [role^="menuitem"]');
    await waitFor("document.querySelector('.ks-folder-picker-error')?.textContent.includes('Synthetic filing failure')", 'Failed filing is explained and dropdown stays open');
    await evaluate('window.fixtureFolderFails = false');
    await clickText('Design Sync', '.ks-folder-dropdown [role^="menuitem"]');
    await waitFor("!!document.querySelector('.ks-folder-picker-series')", 'Recurring filing asks before applying to future meetings');
    assert.equal(await evaluate("window.fixtureCalls.filter(c => c.path === '/api/folders/rules' && c.method === 'POST').at(-1).body.applyToSeries"), false, 'Initial filing applies only to this occurrence');
    await capture('agenda-series-confirmation');
    await clickText('Auto-add', '.ks-folder-picker-series button');
    await waitFor("!document.querySelector('.ks-folder-picker-series')", 'Series confirmation closes after success');
    assert.equal(await evaluate("window.fixtureCalls.filter(c => c.path === '/api/folders/rules' && c.method === 'POST').at(-1).body.applyToSeries"), true, 'Only confirmation assigns the recurring series');
    await click('[aria-label="Folder for Design System Weekly: Design Sync"]');
    assert(await evaluate("[...document.querySelectorAll('.ks-folder-dropdown [role^=\"menuitem\"]')].some(el => el.textContent.includes('Design Sync') && el.getAttribute('aria-checked') === 'true')"), 'Dropdown marks the current folder');
    await clickText('Remove from folder', '.ks-folder-dropdown [role^="menuitem"]');
    await waitFor("!document.querySelector('.ks-folder-dropdown')", 'Removing closes dropdown');
    assert.deepEqual(await evaluate("window.fixtureCalls.filter(c => c.path === '/api/folders/rules' && c.method === 'POST').at(-1).body"), { provider: 'google', eventId: '1', seriesId: 'design-weekly', folderId: null, applyToSeries: true }, 'Remove preserves existing series-rule behavior');
    await click('[aria-label="Choose a folder for 1:1 with Alex"]');
    await click('.ks-folder-picker-create');
    await waitFor("!!document.querySelector('[aria-label=\"Folder for 1:1 with Alex: 1:1 with Alex\"]')", 'Create-folder action creates and files a one-off event');
    console.log('Agenda dropdown: current folder, creation, removal, error/retry and explicit series confirmation passed');
    await clickText('All meetings', '.ks-sidebar button');
    await waitFor("document.querySelectorAll('.ks-meeting-card').length === 3", 'Library meetings visible');
    await checkLayouts('library', '.ks-library-view');
    assert(await evaluate("parseFloat(getComputedStyle(document.querySelector('.ks-meeting-card')).borderRadius) >= 16"), 'Rounded meeting rows');
    await click('.ks-card-more');
    await waitFor("!!document.querySelector('.ks-card-popover')", 'Folder menu opens');
    assert(await evaluate("document.querySelector('.ks-card-popover').textContent.includes('Delete meeting')"), 'Folder menu keeps delete action');
    assert(await evaluate("[...document.querySelectorAll('.ks-card-popover [role^=\"menuitem\"]')].find(el => el.textContent.includes('Delete meeting')).getAttribute('role') === 'menuitem'"), 'Delete is an action, not a selectable folder');
    await capture('library-folder-menu');
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'ESC' });
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'ESC' });
    await waitFor("!document.querySelector('.ks-card-popover')", 'Escape closes folder menu');

    await clickText('Investors', '.ks-sidebar button');
    await waitFor("!!document.querySelector('.ks-library-empty')", 'Empty folder visible');
    assert(await evaluate("document.querySelector('.ks-library-ask input').placeholder.includes('Investors')"), 'Ask input carries folder context');
    await checkLayouts('folder', '.ks-library-view');

    await clickText('Ask Kesami', '.ks-sidebar button');
    await waitFor("!!document.querySelector('.ks-ask-workspace .ks-chat')", 'Ask workspace visible');
    assert(await evaluate("document.querySelector('[aria-label=\"Send question\"]').disabled"), 'Empty question cannot send');
    await checkLayouts('ask-empty', '.ks-ask-workspace .ks-chat');
    await click('[aria-label="Conversation history"]');
    await waitFor("!!document.querySelector('.ks-chat-threads')", 'Conversation history opens');
    await clickText('Roadmap decisions', '.ks-chat-threads button');
    await waitFor("!!document.querySelector('.ks-chat-assistant')", 'Saved answer loaded');
    await checkLayouts('ask-answer', '.ks-ask-workspace .ks-chat');
    assert(await evaluate("parseFloat(getComputedStyle(document.querySelector('.ks-chat')).borderRadius) >= 20"), 'Rounded Ask frame');
    assert(await evaluate("document.querySelectorAll('.ks-chat-citation').length > 0"), 'Answer citations remain interactive');
    await clickText('Explain more', '.ks-chat-followups button');
    assert(await evaluate("document.querySelector('.ks-chat-composer textarea').value.includes('Explain the answer')"), 'Follow-up prepares the editable question');
    assert(await evaluate("!document.querySelector('[aria-label=\"Send question\"]').disabled"), 'HeroUI send enables for a question');
    await click('[aria-label="Send question"]');
    await waitFor("window.fixtureCalls.some(call => call.path === '/api/chat/threads/fixture-chat/messages' && call.method === 'POST')", 'HeroUI send uses existing chat API');
    await click('[aria-label="New conversation"]');
    await waitFor("!document.querySelector('.ks-chat-assistant')", 'New conversation resets the view');
    assert.equal(await evaluate("document.querySelector('.ks-chat-composer textarea').value"), '', 'New conversation clears question');
    await evaluate("document.querySelector('.ks-chat-composer textarea').focus()");
    await window.webContents.insertText('What decisions were discussed?');
    await settle();
    assert.equal(await evaluate("document.querySelector('.ks-chat-composer textarea').value"), 'What decisions were discussed?', 'Native text input reaches the HeroUI textarea');
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter', modifiers: ['shift'] });
    window.webContents.sendInputEvent({ type: 'char', keyCode: '\r', modifiers: ['shift'] });
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter', modifiers: ['shift'] });
    await settle();
    assert(await evaluate("document.querySelector('.ks-chat-composer textarea').value.includes('\\n')"), 'Shift+Enter inserts a new line');
    assert(await evaluate("!window.fixtureCalls.some(call => call.path === '/api/chat/threads/fixture-live-chat/messages' && call.method === 'POST')"), 'Shift+Enter does not submit');
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
    await waitFor("window.fixtureCalls.some(call => call.path === '/api/chat/threads/fixture-live-chat/messages' && call.method === 'POST')", 'Enter submits through existing chat API');

    // Deliberately controllable requests exercise pending/error/cancel without
    // contacting a provider. Late responses ignore abort to test stale guards.
    await evaluate(`window.fixtureChatFetch = window.fetch;
        window.fixtureChatMode = 'normal'; window.fixturePendingChat = [];
        window.fixtureLongMessages = Array.from({length: 20}, (_, i) => ({
            requestId: 'long-' + Math.floor(i / 2), role: i % 2 ? 'assistant' : 'user',
            content: i % 2 ? ('Recorded decision ' + i + '. ' + 'Review the source before acting. '.repeat(18)) : 'What did we decide in meeting ' + i + '?',
        }));
        window.fetch = (url, options = {}) => {
            const path = new URL(url).pathname, method = options.method || 'GET';
            if (path === '/api/chat/threads/fixture-chat/messages' && method === 'GET') {
                return Promise.resolve(new Response(JSON.stringify(new URL(url).searchParams.has('before')
                    ? {messages: [{requestId: 'earlier', role: 'user', content: 'Earlier question'}, {requestId: 'earlier', role: 'assistant', content: 'Earlier recorded answer. '.repeat(20)}]}
                    : {messages: window.fixtureLongMessages, before: 123})));
            }
            if (path === '/api/chat/threads' && method === 'POST' && window.fixtureHoldCreate) {
                return new Promise(resolve => { window.fixturePendingCreate = {resolve, signal: options.signal}; });
            }
            if (/^\\/api\\/chat\\/threads\\/[^/]+\\/messages$/.test(path) && method === 'POST' && window.fixtureChatMode !== 'normal') {
                const body = JSON.parse(options.body);
                window.fixtureCalls.push({path, method, body});
                if (window.fixtureChatMode === 'fail') return Promise.resolve(new Response(JSON.stringify({error: 'Synthetic answer unavailable'}), {status: 503}));
                return new Promise(resolve => window.fixturePendingChat.push({resolve, signal: options.signal}));
            }
            return window.fixtureChatFetch(url, options);
        }; void 0;`);
    await click('[aria-label="Conversation history"]');
    await clickText('Roadmap decisions', '.ks-chat-threads button');
    await waitFor("document.querySelectorAll('[data-chat-message]').length === 20", 'Long saved conversation loaded');
    assert(await evaluate("(() => { const e = document.querySelector('.ks-chat-log'); return e.scrollHeight - e.scrollTop - e.clientHeight < 2; })()"), 'Saved conversation starts at latest message');
    await evaluate("window.fixtureChatMode = 'hold'; document.querySelector('.ks-chat-composer textarea').focus()");
    await window.webContents.insertText('Show the next decision');
    await click('[aria-label="Send question"]');
    await waitFor("!!document.querySelector('.chat-loader__skeleton .skeleton')", 'HeroUI response skeleton shown while waiting');
    await click('.chat-progress__trigger');
    await waitFor("document.querySelector('.chat-progress__trigger').getAttribute('aria-expanded') === 'true'", 'Request progress is keyboard-accessible disclosure');
    assert(await evaluate("document.querySelector('.chat-progress__steps').textContent.includes('Detailed search and model progress aren’t available')"), 'Progress explains actual endpoint limitation');
    await checkLayouts('ask-pending', '.ks-ask-workspace .ks-chat');
    await evaluate("document.documentElement.dataset.reducedMotion = 'true'");
    assert.equal(await evaluate("getComputedStyle(document.querySelector('.chat-loader__line'), '::before').animationName"), 'none', 'Skeleton respects app reduced-motion setting');
    await evaluate("delete document.documentElement.dataset.reducedMotion; const e = document.querySelector('.ks-chat-log'); e.scrollTop = 320; e.dispatchEvent(new Event('scroll')); void 0;");
    await waitFor("!!document.querySelector('[aria-label=\"Jump to latest message\"]')", 'Jump button appears while reading older messages');
    const readingTop = await evaluate("document.querySelector('.ks-chat-log').scrollTop");
    await evaluate("window.fixturePendingChat.at(-1).resolve(new Response(JSON.stringify({answer: 'Resolved answer. '.repeat(50)})))");
    await waitFor("!document.querySelector('.chat-loader__skeleton')", 'Pending skeleton removed after answer');
    const resolvedTop = await evaluate("document.querySelector('.ks-chat-log').scrollTop");
    assert(Math.abs(resolvedTop - readingTop) < 2, `Arriving answer preserves reader position: before=${readingTop}, after=${resolvedTop}`);
    await evaluate(`(() => { const e = document.querySelector('.ks-chat-log'), top = e.getBoundingClientRect().top;
        window.fixtureReadingAnchor = [...e.querySelectorAll('[data-chat-message]')].find(n => n.getBoundingClientRect().bottom > top);
        window.fixtureReadingOffset = window.fixtureReadingAnchor.getBoundingClientRect().top - top; })();`);
    await clickText('Load earlier messages');
    await waitFor("document.querySelectorAll('[data-chat-message]').length === 24", 'Earlier messages prepended');
    assert(await evaluate("Math.abs(window.fixtureReadingAnchor.getBoundingClientRect().top - document.querySelector('.ks-chat-log').getBoundingClientRect().top - window.fixtureReadingOffset) < 2"), 'Prepending preserves visible message offset');
    window.setContentSize(375, 900);
    await settle();
    assert(await evaluate("Math.abs(window.fixtureReadingAnchor.getBoundingClientRect().top - document.querySelector('.ks-chat-log').getBoundingClientRect().top - window.fixtureReadingOffset) < 2"), 'Responsive reflow preserves reading position');
    window.setContentSize(1280, 900);
    await settle();
    await click('[aria-label="Jump to latest message"]');
    assert(await evaluate("(() => { const e = document.querySelector('.ks-chat-log'); return e.scrollHeight - e.scrollTop - e.clientHeight < 2; })()"), 'Jump reaches bottom');

    await evaluate("document.querySelector('.ks-chat-composer textarea').focus()");
    await window.webContents.insertText('Cancel this question');
    await click('[aria-label="Send question"]');
    await waitFor("!!document.querySelector('.chat-loader__skeleton')", 'Cancellation has a pending answer');
    await click('[aria-label="Cancel question"]');
    assert.equal(await evaluate("document.querySelector('.ks-chat-composer textarea').value"), 'Cancel this question', 'Cancellation restores editable question');
    assert(await evaluate("window.fixturePendingChat.at(-1).signal.aborted"), 'Cancellation aborts transport');
    assert(await evaluate("window.fixtureCalls.some(c => c.path.endsWith('/cancel') && c.method === 'POST')"), 'Cancellation reaches existing request endpoint');
    await evaluate("window.fixturePendingChat.at(-1).resolve(new Response(JSON.stringify({answer: 'STALE CANCELLED ANSWER'})))");
    await settle();
    assert(await evaluate("!document.querySelector('.ks-chat-log').textContent.includes('STALE CANCELLED ANSWER') && !document.querySelector('.chat-loader__skeleton')"), 'Late cancelled response cannot revive pending UI or append answer');
    await evaluate("window.fixtureChatMode = 'fail'");
    await click('[aria-label="Send question"]');
    await waitFor("document.querySelector('.ks-chat-error')?.textContent.includes('Synthetic answer unavailable')", 'Failed answer shows retry state');
    const retryId = await evaluate("window.fixtureCalls.filter(c => c.path.endsWith('/messages') && c.method === 'POST').at(-1).body.requestId");
    const rowsBeforeRetry = await evaluate("document.querySelectorAll('.chat-message--user').length");
    await evaluate("window.fixtureChatMode = 'normal'");
    await clickText('Try again', '.ks-chat-error button');
    await waitFor("!document.querySelector('.ks-chat-error') && !document.querySelector('.chat-loader__skeleton')", 'Retry succeeds and clears error/loading');
    assert.equal(await evaluate("window.fixtureCalls.filter(c => c.path.endsWith('/messages') && c.method === 'POST').at(-1).body.requestId"), retryId, 'Retry keeps idempotent request ID');
    assert.equal(await evaluate("document.querySelectorAll('.chat-message--user').length"), rowsBeforeRetry, 'Retry does not duplicate user turn');

    await click('[aria-label="New conversation"]');
    await evaluate("window.fixtureHoldCreate = true; document.querySelector('.ks-chat-composer textarea').focus()");
    await window.webContents.insertText('Start a fresh conversation');
    await click('[aria-label="Send question"]');
    await waitFor("document.querySelector('.chat-progress__trigger')?.textContent.includes('Starting conversation')", 'Creating-thread phase is observed separately');
    await click('[aria-label="Cancel question"]');
    await evaluate("window.fixturePendingCreate.resolve(new Response(JSON.stringify({id: 'stale-created-thread', scope: {type: 'all'}})))");
    await settle();
    assert(await evaluate("!document.querySelector('[aria-label=\"Delete conversation\"]') && !document.querySelector('.chat-loader__skeleton')"), 'Cancelled thread creation cannot reopen a stale thread');
    await evaluate("window.fixtureHoldCreate = false; window.fixtureChatMode = 'hold'");
    await clickText('All meetings', '.ks-sidebar button');
    await click('.ks-meeting-card-body');
    await clickText('Ask AI');
    await waitFor("!!document.querySelector('.ks-meeting-chat .ks-chat-starters button:not(:disabled)')", 'Meeting-side chat ready');
    await clickText('Find decisions', '.ks-meeting-chat .ks-chat-starters button');
    await waitFor("!!document.querySelector('.ks-meeting-chat .chat-loader__skeleton')", 'Meeting-side chat uses shared response skeleton');
    await checkLayouts('meeting-chat-pending', '.ks-meeting-chat .ks-chat');
    await click('[aria-label="Cancel question"]');
    await click('[aria-label="Expand AI panel"]');
    assert(await evaluate("!!document.querySelector('.ks-meeting-chat.is-expanded .chat-conversation')"), 'New viewport retains expand/restore support');
    await click('[aria-label="Restore AI panel"]');
    console.log('Chat skeleton, truthful progress, reduced motion, scroll/reflow/prepend, cancellation, stale responses and idempotent retry passed');
    assert.equal(errors.length, 0, `Renderer errors: ${errors.join('\n')}`);
    console.log('Menus, history, follow-ups, send, new conversation, keyboard input and renderer error checks passed');
    window.destroy();
    app.quit();
}

const watchdog = setTimeout(() => { console.error('Render check exceeded 60 seconds'); app.exit(1); }, 60000);
run().then(() => clearTimeout(watchdog)).catch(error => { console.error(error); app.exit(1); });
