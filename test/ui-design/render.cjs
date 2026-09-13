// Native Electron render / interaction check, isolated from all user meetings.
// Run after build:ui: node_modules/.bin/electron test/ui-design/render.cjs
const { app, BrowserWindow } = require('electron');
const { build } = require('esbuild');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');

async function run() {
    const output = await fs.mkdtemp(path.join(os.tmpdir(), 'kesami-render-'));
    console.log(`Render output: ${output}`);
    app.setPath('userData', path.join(output, 'profile'));
    await build({
        entryPoints: [path.join(__dirname, 'fixture.jsx')],
        bundle: true,
        outdir: output,
        format: 'iife',
        loader: { '.woff2': 'file' },
        alias: { '@': path.resolve(__dirname, '../../apps/ui/src') },
        define: { 'process.env.NODE_ENV': '"development"', 'import.meta.env': '{}' },
    });
    const assets = path.resolve(__dirname, '../../apps/ui/dist/assets');
    const css = (await fs.readdir(assets)).find(name => /^index-.*\.css$/.test(name));
    await fs.writeFile(
        path.join(output, 'index.html'),
        `<!doctype html><html class="dark"><head><meta charset="utf-8"><link rel="stylesheet" href="file://${assets}/${css}"><link rel="stylesheet" href="fixture.css"><style>html,body,#root{height:100%;margin:0}</style></head><body><div id="root"></div><script src="fixture.js"></script></body></html>`
    );
    await app.whenReady();
    const window = new BrowserWindow({
        show: false,
        width: 1280,
        height: 824,
        useContentSize: true,
        webPreferences: { contextIsolation: true, nodeIntegration: false },
    });
    const errors = [];
    window.webContents.on('console-message', (_, level, message) => {
        if (level === 3 && !message.includes('Content Security Policy')) errors.push(message);
    });
    window.webContents.session.webRequest.onBeforeRequest(
        { urls: ['http://127.0.0.1:48900/*', 'ws://127.0.0.1:48900/*'] },
        (_, done) => done({ cancel: true })
    );
    const evaluate = script => window.webContents.executeJavaScript(script);
    const settle = () => evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    const click = async text => {
        assert(
            await evaluate(
                `(() => { const button = [...document.querySelectorAll('button')].find(b => b.textContent.trim().endsWith(${JSON.stringify(text)})); if (!button || button.disabled) return false; button.click(); return true; })()`
            ),
            `Button available: ${text}`
        );
        await settle();
    };
    const capture = async name => {
        await settle();
        await fs.writeFile(path.join(output, `${name}.png`), (await window.webContents.capturePage()).toPNG());
    };
    await window.loadFile(path.join(output, 'index.html'));
    await evaluate('document.fonts.ready');
    await capture('01-sign-in');
    await click('Continue with Google');
    assert(await evaluate("document.body.textContent.includes('Account sign-in is not connected')"));
    await click('Create Account');
    assert(await evaluate("!!document.querySelector('input[autocomplete=name]')"));
    await click('Sign In');
    await click('Continue locally ↗');
    await capture('02-home');
    assert.equal(await evaluate("document.querySelectorAll('.ks-meeting-card').length"), 3);
    await click('Product1');
    assert.equal(await evaluate("document.querySelectorAll('.ks-meeting-card').length"), 1);
    await evaluate('document.querySelector(\'[aria-label="New folder"]\').click()');
    await settle();
    await evaluate(`(() => {
        const input = document.querySelector('[role="dialog"] input');
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'Research');
        input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await settle();
    await click('Create folder');
    await settle();
    assert(await evaluate("window.fixtureCalls.some(call => call.path === '/api/folders' && call.method === 'POST' && call.body.name === 'Research')"));
    assert(await evaluate("document.body.textContent.includes('Research')"));
    await click('Home');
    await click('New Meeting');
    await capture('03-transcript');
    assert.equal(await evaluate("document.querySelectorAll('.ks-turn:not(.ks-turn-interim)').length"), 6);
    assert.equal(await evaluate("document.querySelector('.ks-turn-interim p').textContent"), 'One more thing before we');
    assert.deepEqual(
        await evaluate("[...document.querySelectorAll('.ks-meeting-tabs > button')].map(button => button.id)"),
        ['tab-transcript', 'tab-notes'],
        'a running meeting offers only the views that have something to show'
    );
    assert.equal(await evaluate("[...document.querySelectorAll('button')].some(button => button.textContent.trim() === 'Export')"), false);
    assert(await evaluate("(() => { const button = [...document.querySelectorAll('.ks-meeting-actions button')].find(b => b.textContent.trim() === 'Ask AI'); if (!button || button.disabled) return false; button.click(); return true; })()"));
    await settle();
    assert(await evaluate("document.querySelector('.ks-meeting-chat').textContent.includes('transcript captured when you send')"));
    assert(await evaluate("document.querySelector('.ks-recording-hud') !== null"));
    const startingWidth = await evaluate("document.querySelector('.ks-meeting-chat').getBoundingClientRect().width");
    const divider = await evaluate("(() => { const rect = document.querySelector('[aria-label=\"Resize AI chat\"]').getBoundingClientRect(); return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + 80) }; })()");
    window.webContents.sendInputEvent({ type: 'mouseMove', ...divider });
    window.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...divider });
    window.webContents.sendInputEvent({ type: 'mouseMove', x: divider.x - 80, y: divider.y });
    await settle();
    window.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, x: divider.x - 80, y: divider.y });
    await settle();
    assert.equal(await evaluate("document.querySelector('.ks-meeting-chat').getBoundingClientRect().width"), startingWidth + 80);
    await evaluate("document.querySelector('[aria-label=\"Resize AI chat\"]').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))");
    await settle();
    assert.equal(await evaluate("document.querySelector('.ks-meeting-chat').getBoundingClientRect().width"), startingWidth + 60);
    window.setContentSize(620, 780);
    await settle();
    assert(await evaluate("document.querySelector('.ks-meeting-chat').getBoundingClientRect().width <= document.querySelector('.ks-meeting').getBoundingClientRect().width"));
    assert(await evaluate('document.documentElement.scrollWidth <= innerWidth'));
    window.setContentSize(1280, 824);
    await settle();
    assert.equal(await evaluate("document.querySelector('.ks-meeting-chat').getBoundingClientRect().width"), startingWidth + 60);
    await capture('03-live-chat');
    await click('Summarize the discussion so far');
    assert.equal(await evaluate("document.querySelector('[aria-label=\"Meeting question\"]').value"), 'Summarize the discussion so far');
    await evaluate("document.querySelector('[aria-label=\"Send question\"]').click()");
    await settle();
    assert(await evaluate("document.querySelector('.ks-meeting-chat').textContent.includes('Transcript captured through 0:23')"));
    assert(await evaluate("document.querySelector('.ks-recording-hud') !== null"));
    await capture('03-live-answer');
    await evaluate("document.querySelector('[aria-label=\"Close Ask AI\"]').click()");
    await settle();
    await click('Stop');
    assert.equal(await evaluate("document.querySelectorAll('.ks-recording-hud').length"), 0);
    assert.equal(await evaluate("document.querySelectorAll('.ks-turn-interim').length"), 0);
    assert.equal(await evaluate("document.querySelectorAll('.ks-meeting-tabs > button').length"), 5);
    await click('Tasks1');
    await evaluate("document.querySelector('.ks-task-check').click()");
    await settle();
    assert.equal(await evaluate("document.querySelector('.ks-task-check').getAttribute('aria-pressed')"), 'true');
    await capture('04-tasks');
    await click('Summary');
    await capture('05-summary');
    await evaluate(
        "new Promise((resolve, reject) => { const start = Date.now(); const timer = setInterval(() => { if (window.fixtureReady) { clearInterval(timer); resolve(); } else if (Date.now() - start > 5000) { clearInterval(timer); reject(new Error('Fixture video timeout')); } }, 50); })"
    );
    await click('ScreenHD');
    await capture('06-replay');
    assert(await evaluate("!!document.querySelector('video')"));
    await click('Mark');
    assert.equal(await evaluate("document.querySelectorAll('.ks-bookmarks button').length"), 1);
    await evaluate('document.querySelector(\'[aria-label="Zoom in"]\').click()');
    await settle();
    assert.equal(await evaluate("document.querySelector('video').style.transform"), 'scale(1.1)');
    await click('Ask AI');
    await evaluate("new Promise((resolve, reject) => { const start = Date.now(); const timer = setInterval(() => { if (document.querySelector('.ks-chat-copy')) { clearInterval(timer); resolve(); } else if (Date.now() - start > 5000) { clearInterval(timer); reject(new Error('Chat fixture timeout')); } }, 25); })");
    assert.equal(await evaluate("document.querySelectorAll('.ks-chat-citation:not(:disabled)').length"), 2);
    assert.equal(await evaluate("document.querySelectorAll('.ks-chat-citation:disabled').length"), 1);
    assert(await evaluate("[...document.querySelectorAll('.ks-chat-citation')].every(chip => !/\\[\\d+\\]/.test(chip.textContent))"));
    assert.equal(await evaluate("document.querySelector('.ks-chat-citation').textContent"), '0:04');
    await evaluate("document.querySelector('.ks-chat-citation:not(:disabled)').focus()");
    await settle();
    assert(await evaluate("document.querySelector('[role=\"tooltip\"]').textContent.includes('Q4 Product Roadmap Review')"));
    await evaluate('document.activeElement.blur()');
    assert.equal(await evaluate("document.querySelector('code').textContent"), '[1]');
    assert.equal(await evaluate("document.querySelectorAll('code button').length"), 0);
    await click('Copy response');
    assert(await evaluate("window.fixtureCopiedText.includes('Ship AI search by Oct 15.') && window.fixtureCopiedText.includes('Sources')"));
    assert(await evaluate("document.querySelector('.ks-chat-copy').textContent.includes('Copied')"));
    await evaluate("window.fixtureCopyFails = true; document.querySelector('.ks-chat-copy').click()");
    await settle();
    assert(await evaluate("document.body.textContent.includes('Couldn’t copy')"));
    await evaluate("window.fixtureCopyFails = false; document.querySelector('.ks-chat-copy').click()");
    await settle();
    await click('Explain more');
    assert(await evaluate("document.activeElement === document.querySelector('[aria-label=\"Meeting question\"]')"));
    assert(await evaluate("document.activeElement.value.includes('Regarding: What decisions did we make?')"));
    assert(await evaluate("[...document.querySelectorAll('.ks-chat-followups button')].every(button => button.disabled)"));
    assert(await evaluate("!window.fixtureCalls.some(call => call.path === '/api/chat/threads/fixture-chat/messages' && call.method === 'POST')"));
    await evaluate("document.querySelector('[aria-label=\"Send question\"]').click()");
    await settle();
    assert(await evaluate("window.fixtureCalls.some(call => call.path.endsWith('/messages') && call.body?.question.includes('Explain the answer'))"));
    assert.equal(await evaluate("document.querySelectorAll('.ks-chat-response-actions').length"), 2);
    await capture('07-ask-ai');
    window.setContentSize(720, 780);
    await capture('08-narrow');
    assert(await evaluate('document.documentElement.scrollWidth <= innerWidth'));
    await evaluate("document.querySelector('.ks-chat-citation:not(:disabled)').click()");
    await settle();
    assert.equal(await evaluate('window.fixtureSourceTarget?.startMs'), 4000);
    assert.deepEqual(errors, []);
    // Smoke-test the actual production entry as well, with backend requests blocked.
    await window.loadFile(path.resolve(__dirname, '../../apps/ui/dist/index.html'));
    await evaluate('document.fonts.ready');
    await capture('09-production-sign-in');
    await click('Continue locally ↗');
    await capture('10-production-home-offline');
    assert(await evaluate("!!document.querySelector('.ks-workspace')"));
    assert(await evaluate("document.querySelector('.ks-new-meeting button').disabled"));
    assert(!errors.some(message => /ReferenceError|TypeError|Minified React error/.test(message)));
    console.log(
        `PASS: sign-in, local entry, folder filtering, live transcript and tab narrowing, meeting tabs, task completion, recording stop, replay zoom/bookmark, AI citations/copy/follow-ups, responsive overflow. Screenshots: ${output}`
    );
    window.destroy();
    app.quit();
}
run().catch(error => {
    console.error(error);
    app.exit(1);
});
