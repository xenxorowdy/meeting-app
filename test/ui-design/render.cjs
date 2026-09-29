// Native Electron render / interaction check, isolated from all user meetings.
// Run after build:ui: node_modules/.bin/electron test/ui-design/render.cjs
const { app, BrowserWindow } = require('electron');
const { build } = require('esbuild');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');

const CONTRAST_PROBE = `(() => {
    const channels = value => (value.match(/[\\d.]+/g) || []).map(Number);
    const luminance = rgb => {
        const [r, g, b] = rgb.map(value => {
            const channel = value / 255;
            return channel <= 0.03928 ? channel / 12.92 : Math.pow((channel + 0.055) / 1.055, 2.4);
        });
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const over = (top, alpha, bottom) => top.map((value, index) => value * alpha + bottom[index] * (1 - alpha));
    const backdrop = node => {
        const layers = [];
        for (let el = node; el; el = el.parentElement) {
            const parts = channels(getComputedStyle(el).backgroundColor);
            if (parts.length < 3) continue;
            const alpha = parts.length > 3 ? parts[3] : 1;
            if (alpha === 0) continue;
            layers.push({ rgb: parts.slice(0, 3), alpha });
            if (alpha === 1) break;
        }
        let base = channels(getComputedStyle(document.documentElement).backgroundColor).slice(0, 3);
        if (base.length < 3) base = [255, 255, 255];
        for (let i = layers.length - 1; i >= 0; i -= 1) base = over(layers[i].rgb, layers[i].alpha, base);
        return base;
    };
    const ratio = node => {
        const back = backdrop(node);
        const parts = channels(getComputedStyle(node).color);
        const alpha = parts.length > 3 ? parts[3] : 1;
        const front = luminance(over(parts.slice(0, 3), alpha, back));
        const behind = luminance(back);
        return Math.round(((Math.max(front, behind) + 0.05) / (Math.min(front, behind) + 0.05)) * 100) / 100;
    };
    return SELECTORS.map(selector => {
        const nodes = [...document.querySelectorAll(selector)].filter(node => node.textContent.trim());
        if (!nodes.length) return { selector, ratio: null };
        return { selector, ratio: Math.min(...nodes.map(ratio)), count: nodes.length };
    });
})()`;

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
    const evaluate = async script => {
        try {
            return await window.webContents.executeJavaScript(script);
        } catch (cause) {
            throw new Error(`Renderer script failed:\n${String(script).trim().slice(0, 400)}\n-> ${cause.message}`);
        }
    };
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
        await evaluate('new Promise(resolve => setTimeout(resolve, 250))');
        await settle();
        await fs.writeFile(path.join(output, `${name}.png`), (await window.webContents.capturePage()).toPNG());
    };
    await window.loadFile(path.join(output, 'index.html'));
    await evaluate('document.fonts.ready');
    await capture('01-sign-in');
    if (process.argv.includes('--workspace-only')) {
        await evaluate('window.fixtureEnterWorkspace()');
    } else {
        await click('Create account');
        assert(await evaluate("!!document.querySelector('input[autocomplete=name]')"));
        await click('I already have an account');
        await click('Use it locally, no account');
    }
    await capture('02-home');
    assert.equal(await evaluate("document.querySelectorAll('.ks-meeting-card').length"), 3);
    for (const theme of ['light', 'dark']) {
        await evaluate(`window.fixtureSetTheme(${JSON.stringify(theme)})`);
        await settle();
        await capture(`02-home-${theme}`);
        assert(await evaluate(`(() => {
            const agenda = document.querySelector('.ks-agenda').getBoundingClientRect();
            const meetings = document.querySelector('.ks-meetings-list').getBoundingClientRect();
            return agenda.left >= meetings.right;
        })()`), 'desktop schedule sits beside the meeting library');
        window.setContentSize(620, 860);
        await settle();
        assert(await evaluate(`document.querySelector('.ks-home-scroll').scrollWidth <= document.querySelector('.ks-home-scroll').clientWidth`), 'narrow dashboard has no horizontal overflow');
        await capture(`02-home-narrow-${theme}`);
        window.setContentSize(1280, 824);
    }
    await evaluate(`(() => {
        const input = document.querySelector('[aria-label="Search meetings"]');
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'Design System');
        input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await settle();
    assert.equal(await evaluate("document.querySelectorAll('.ks-meeting-card').length"), 1, 'global search opens and filters the library');
    await evaluate("document.querySelector('[aria-label=\"Clear search\"]').click()");
    await settle();
    assert.equal(await evaluate("document.querySelectorAll('.ks-meeting-card').length"), 3);
    await click('Home');
    await click('Schedule meeting');
    assert(await evaluate('window.fixtureScheduleOpened'), 'schedule action still opens the scheduling flow');
    await evaluate("document.querySelector('[aria-label=\"Workspace tools\"]').click()");
    await settle();
    await evaluate("document.querySelector('[aria-label=\"Noise cancellation\"]').click()");
    await settle();
    assert.equal(await evaluate("document.querySelector('[aria-label=\"Noise cancellation\"]').getAttribute('aria-checked')"), 'false');
    await capture('02-workspace-tools');
    await evaluate("document.querySelector('[aria-label=\"Workspace tools\"]').click()");
    await evaluate('window.fixtureSetEmpty(true)');
    await capture('02-home-empty');
    assert(await evaluate("document.body.textContent.includes('Your next conversation starts here')"));
    assert(await evaluate("document.body.textContent.includes('Nothing scheduled today')"));
    await evaluate('window.fixtureSetEmpty(false)');
    await settle();
    window.setContentSize(794, 1000);
    await evaluate("document.documentElement.dataset.textSize = 'large'");
    await settle();
    await click('Ask AI');
    await evaluate("document.querySelector('[aria-label=\"New conversation\"]').click()");
    await settle();
    assert(
        await evaluate(`(() => {
            const empty = document.querySelector('.ks-chat-empty').getBoundingClientRect();
            return [...document.querySelectorAll('.ks-chat-starters button')].every(button => {
                const card = button.getBoundingClientRect();
                const title = button.querySelector('strong').getBoundingClientRect();
                const prompt = button.querySelector('small').getBoundingClientRect();
                return card.left >= empty.left && card.right <= empty.right && prompt.top >= title.bottom;
            });
        })()`),
        'chat starters keep their title and prompt on separate lines inside the empty state'
    );
    await evaluate(`(() => {
        const textarea = document.querySelector('[aria-label="Meeting question"]');
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(textarea, 'At 00:10, You said: “How are you?”');
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await settle();
    assert(
        (await evaluate("document.querySelector('[aria-label=\"Meeting question\"]').getBoundingClientRect().height")) <= 60,
        'a one-line quoted draft keeps the composer compact'
    );
    await capture('02-chat-empty');
    window.setContentSize(1280, 824);
    await evaluate("delete document.documentElement.dataset.textSize");
    await settle();
    await click('Home');
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
    const midStream = await evaluate("document.querySelector('li[aria-live=\"polite\"] p').textContent");
    await evaluate('new Promise(resolve => setTimeout(resolve, 800))');
    await capture('03-transcript');
    assert(await evaluate(`(() => {
        const panel = document.querySelector('.ks-meeting-panel').getBoundingClientRect();
        const controls = document.querySelector('.ks-recording-hud').getBoundingClientRect();
        return controls.top >= panel.bottom && controls.bottom <= innerHeight;
    })()`), 'recording controls stay below the transcript and inside the window');
    await evaluate("document.querySelector('[aria-label=\"Search and filter transcript\"]').click()");
    await settle();
    assert(await evaluate("!!document.querySelector('[aria-label=\"Search transcript\"]')"), 'live transcript filters are reachable');
    await evaluate("document.querySelector('[aria-label=\"Search and filter transcript\"]').click()");
    assert.equal(await evaluate("document.querySelectorAll('.ks-meeting-panel li[data-turn-id]').length"), 6);
    const settledInterim = await evaluate("document.querySelector('li[aria-live=\"polite\"] p').textContent");
    assert.equal(settledInterim, 'One more thing before we');
    assert(midStream.length < settledInterim.length, `live speech arrives word by word, not all at once (saw "${midStream}")`);
    assert(await evaluate("document.querySelectorAll('li[aria-live=\"polite\"] .ks-word').length") >= 5, 'each revealed word is its own element');
    assert.equal(await evaluate("document.querySelectorAll('.ks-meeting-panel li[data-turn-id] .ks-word').length"), 0, 'a stored transcript renders at once');
    await evaluate("document.querySelector('[aria-label=\"Pause recording\"]').click()");
    await settle();
    assert(await evaluate("document.querySelector('.ks-transcript-heading').textContent.includes('Recording paused')"));
    await evaluate("document.querySelector('[aria-label=\"Resume recording\"]').click()");
    await settle();
    assert.deepEqual(
        await evaluate("[...document.querySelectorAll('.ks-meeting-tabs > button')].map(button => button.id)"),
        ['tab-transcript', 'tab-notes'],
        'a running meeting offers only the views that have something to show'
    );
    assert.equal(await evaluate("[...document.querySelectorAll('button')].some(button => button.textContent.trim() === 'Export')"), false);
    assert(await evaluate("document.querySelector('.ks-meeting-chat') !== null"), 'Ask AI opens alongside a meeting');
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
    await settle();
    assert(await evaluate("window.fixtureCalls.some(call => call.path === '/api/chat/threads/fixture-live-chat/messages' && call.body?.question === 'Summarize the discussion so far')"), 'a suggested question sends to the real chat flow');
    assert(await evaluate("document.querySelector('.ks-meeting-chat').textContent.includes('Transcript captured through 0:23')"));
    assert(await evaluate("document.querySelector('.ks-recording-hud') !== null"));
    await capture('03-live-answer');
    await evaluate("window.fixtureSetTheme('light'); document.documentElement.dataset.textSize = 'large'");
    await settle();
    assert.equal(
        await evaluate("getComputedStyle(document.querySelector('.ks-chat-assistant')).borderTopWidth"),
        '0px',
        'assistant answers use the clean unboxed treatment'
    );
    assert(await evaluate("document.querySelector('.ks-meeting-chat').scrollWidth <= document.querySelector('.ks-meeting-chat').clientWidth"));
    await capture('03-live-answer-light-large');
    await evaluate("window.fixtureSetTheme('dark'); delete document.documentElement.dataset.textSize");
    await settle();
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
    await evaluate("document.querySelector('.ks-meeting-actions button:last-child').click()");
    await settle();
    for (const theme of ['light', 'dark']) {
        await evaluate(`window.fixtureSetTheme(${JSON.stringify(theme)})`);
        await capture(`05-summary-${theme}`);
    }
    await evaluate("document.querySelector('.ks-meeting-actions button:last-child').click()");
    await settle();
    assert(await evaluate("!document.querySelector('.ks-summary-recording').open"), 'summary leads with notes and a collapsed recording');
    await evaluate("document.querySelector('.ks-summary-recording > summary').click()");
    await evaluate("new Promise((resolve, reject) => { const start = Date.now(); const timer = setInterval(() => { if (document.querySelector('.ks-replay-compact video')) { clearInterval(timer); resolve(); } else if (Date.now() - start > 5000) { clearInterval(timer); reject(new Error('Summary recording preview never loaded')); } }, 25); })");
    assert(await evaluate("!document.querySelector('.ks-replay-compact .ks-replay-transcript')"), 'summary preview avoids duplicating the transcript');
    await capture('05-summary-recording');
    await evaluate("document.querySelector('.ks-summary-recording > summary').click()");
    await settle();
    assert(await evaluate("!document.querySelector('.ks-replay-compact video')"), 'collapsing the preview unmounts the media');
    await evaluate(
        "new Promise((resolve, reject) => { const start = Date.now(); const timer = setInterval(() => { if (window.fixtureReady) { clearInterval(timer); resolve(); } else if (Date.now() - start > 5000) { clearInterval(timer); reject(new Error('Fixture video timeout')); } }, 50); })"
    );
    await click('Recording');
    await evaluate(
        "new Promise((resolve, reject) => { const start = Date.now(); const timer = setInterval(() => { if (document.querySelector('video')) { clearInterval(timer); resolve(); } else if (Date.now() - start > 5000) { clearInterval(timer); reject(new Error('Lazy recording player never loaded')); } }, 25); })"
    );
    await capture('06-replay');
    assert.equal(await evaluate("document.querySelector('.ks-replay-body').scrollTop"), 0, 'transcript following does not scroll the recording out of view');
    await evaluate(`(() => {
        const speed = document.querySelector('[aria-label="Playback speed"]');
        speed.value = '2';
        speed.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await settle();
    assert.equal(await evaluate("document.querySelector('video').playbackRate"), 2);
    await click('Copy timestamp');
    assert(await evaluate("window.fixtureCopiedText.includes('Q4 Product Roadmap Review')"));
    await evaluate("window.fixturePatchMeeting({ recording: { videoPath: 'fixture.webm', durationMs: 25000, mode: 'audio' } })");
    await capture('06-audio-replay');
    assert(await evaluate("!!document.querySelector('audio') && !document.querySelector('[aria-label=\"Zoom in\"]')"), 'audio recording uses audio playback and omits video zoom');
    await evaluate("window.fixturePatchMeeting({ recording: { videoPath: 'fixture.webm', durationMs: 25000, mode: 'screen' } })");
    await settle();
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
    const chip = await evaluate(
        "(() => { const rect = document.querySelector('.ks-chat-citation:not(:disabled)').getBoundingClientRect(); return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) }; })()"
    );
    window.webContents.sendInputEvent({ type: 'mouseMove', ...chip });
    await evaluate(
        "new Promise((resolve, reject) => { const start = Date.now(); const timer = setInterval(() => { if (document.querySelector('[role=\"tooltip\"]')) { clearInterval(timer); resolve(); } else if (Date.now() - start > 3000) { clearInterval(timer); reject(new Error('Source tooltip never opened')); } }, 25); })"
    );
    assert(await evaluate("document.querySelector('[role=\"tooltip\"]').textContent.includes('Q4 Product Roadmap Review')"));
    window.webContents.sendInputEvent({ type: 'mouseMove', x: 8, y: 8 });
    await settle();
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
    window.setContentSize(1280, 824);
    await settle();
    window.setContentSize(720, 780);
    await capture('08-narrow');
    assert(await evaluate('document.documentElement.scrollWidth <= innerWidth'));
    await evaluate("document.querySelector('.ks-chat-citation:not(:disabled)').click()");
    await settle();
    assert.equal(await evaluate('window.fixtureSourceTarget?.startMs'), 4000);
    window.setContentSize(1280, 824);
    await settle();

    const probe = selectors => evaluate(CONTRAST_PROBE.replace('SELECTORS', JSON.stringify(selectors)));
    for (const theme of ['dark', 'light']) {
        await evaluate(`window.fixtureSetTheme(${JSON.stringify(theme)})`);
        await settle();
        await click('Home');
        await click('New Meeting');
        await evaluate('new Promise(resolve => setTimeout(resolve, 800))');
        await capture(`11-live-${theme}`);
        window.setContentSize(620, 860);
        await settle();
        await capture(`11-live-narrow-${theme}`);
        assert(await evaluate("document.querySelector('.ks-meeting-main').scrollWidth <= document.querySelector('.ks-meeting-main').clientWidth"), 'live transcript fits a narrow window');
        window.setContentSize(1280, 824);
        await settle();
        const live = await probe([
            '.ks-rec',
            '.ks-meeting-panel li[data-turn-id] p',
            '.ks-meeting-panel li[data-turn-id] .tnum',
            '.ks-meeting-panel li[data-turn-id] button[title="Rename speaker"]',
            '.ks-meeting-panel li[data-turn-id] > div:first-child',
            '.ks-meeting-tabs > button[aria-selected="true"]',
            '.ks-sidebar-nav button',
        ]);
        for (const { selector, ratio } of live) {
            assert(ratio !== null, `${theme}: ${selector} is rendered`);
            assert(ratio >= 4.5, `${theme}: ${selector} contrast ${ratio} must reach 4.5:1`);
        }
        assert(await evaluate("document.querySelectorAll('.ks-balls i').length >= 3"), `${theme}: the listening indicator is animated`);
        await click('Stop');
        if (!(await evaluate("document.querySelector('.ks-meeting-chat') !== null"))) await click('Ask AI');
        await evaluate("new Promise((resolve, reject) => { const start = Date.now(); const timer = setInterval(() => { if (document.querySelector('.ks-chat-starters button:not(:disabled)')) { clearInterval(timer); resolve(); } else if (Date.now() - start > 5000) { clearInterval(timer); reject(new Error('Chat fixture timeout')); } }, 25); })");
        await click('What decisions did we make?');
        await evaluate("new Promise((resolve, reject) => { const start = Date.now(); const timer = setInterval(() => { if (document.querySelector('.ks-chat-assistant')) { clearInterval(timer); resolve(); } else if (Date.now() - start > 5000) { clearInterval(timer); reject(new Error('Chat answer timeout')); } }, 25); })");
        await capture(`12-ask-${theme}`);
        const chat = await probe(['.ks-chat-bubble', '.ks-chat-ai-label', '.ks-chat-head-text h2']);
        for (const { selector, ratio } of chat) {
            assert(ratio !== null, `${theme}: ${selector} is rendered`);
            assert(ratio >= 4.5, `${theme}: ${selector} contrast ${ratio} must reach 4.5:1`);
        }
        assert(await evaluate('document.documentElement.scrollWidth <= innerWidth'), `${theme}: no horizontal overflow`);
    }
    await evaluate("window.fixtureSetTheme('dark')");
    await settle();

    for (const theme of ['dark', 'light']) {
        await evaluate(`window.fixtureSetTheme(${JSON.stringify(theme)})`);
        await evaluate("document.querySelector('[aria-label=\"Workspace tools\"]').click()");
        await settle();
        await click('Plans & pricing');
        await evaluate("new Promise(resolve => setTimeout(resolve, 100))");
        assert.equal(await evaluate("document.querySelectorAll('.ks-plan-card').length"), 2);
        assert(await evaluate("[...document.querySelectorAll('.ks-plan-card button')].find(b => b.textContent.includes('Not available')).disabled"));
        assert(await evaluate("document.body.textContent.includes('Price to be announced')"));
        await capture(`13-pricing-${theme}`);
        window.setContentSize(794, 1000);
        await settle();
        assert(await evaluate('document.documentElement.scrollWidth <= innerWidth'));
        await capture(`14-pricing-narrow-${theme}`);
        window.setContentSize(1280, 824);
        await click('Open workspace');
    }
    await evaluate("window.fixtureSetAccount({ id: 'fixture-account', name: 'Asha Verma', email: 'asha@work.com' })");
    await settle();
    await evaluate("document.querySelector('.ks-profile').click()");
    await settle();
    assert(await evaluate("document.body.textContent.includes('asha@work.com')"));
    await evaluate(`(() => {
        const values = ['first password', 'second password', 'second password'];
        [...document.querySelectorAll('.ks-account-password input')].forEach((input, i) => {
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, values[i]);
            input.dispatchEvent(new Event('input', { bubbles: true }));
        });
    })()`);
    await settle();
    await click('Update password');
    await evaluate("new Promise(resolve => setTimeout(resolve, 100))");
    assert(await evaluate("document.body.textContent.includes('Password updated')"));
    assert(await evaluate("[...document.querySelectorAll('.ks-account-password input')].every(input => input.value === '')"));
    await capture('15-account-password');
    await evaluate("sessionStorage.clear(); localStorage.clear()");
    assert.deepEqual(errors, []);
    // Smoke-test the actual production entry as well, with backend requests blocked.
    await window.loadFile(path.resolve(__dirname, '../../apps/ui/dist/index.html'));
    await evaluate('document.fonts.ready');
    await capture('09-production-sign-in');
    if (!process.argv.includes('--workspace-only')) {
        await click('Use it locally, no account');
        await capture('10-production-home-offline');
        assert(await evaluate("!!document.querySelector('.ks-workspace')"));
        assert(await evaluate("document.querySelector('.ks-new-meeting button').disabled"));
        await window.reload();
        await evaluate("new Promise(resolve => setTimeout(resolve, 250))");
        assert(await evaluate("!!document.querySelector('.ks-workspace')"), 'local access survives a reload without sign-in');
        // Code-split surfaces are fetched at runtime; over file:// that is exactly
        // where a dynamic import would fail, so prove one actually loads.
        await click('Settings');
        await evaluate(
            "new Promise((resolve, reject) => { const start = Date.now(); const timer = setInterval(() => { if (document.querySelector('[role=\"dialog\"]')) { clearInterval(timer); resolve(); } else if (Date.now() - start > 5000) { clearInterval(timer); reject(new Error('Lazy settings chunk never loaded')); } }, 25); })"
        );
        assert(await evaluate("document.querySelector('[role=\"dialog\"]').textContent.length > 0"), 'the lazily loaded settings surface rendered');
        assert(!errors.some(message => /ReferenceError|TypeError|Minified React error/.test(message)));
    }
    console.log(
        `PASS: ${process.argv.includes('--workspace-only') ? 'workspace-only (auth/local-entry checks excluded), dashboard layout and search,' : 'sign-in, persistent local entry,'} Free/Pro pricing in both themes, password rotation UI, folder filtering, live transcript and tab narrowing, dark+light contrast (AA), meeting tabs, task completion, recording stop, replay zoom/bookmark, AI citations/copy/follow-ups, responsive overflow. Screenshots: ${output}`
    );
    window.destroy();
    app.quit();
}
run().catch(error => {
    console.error(error);
    app.exit(1);
});
