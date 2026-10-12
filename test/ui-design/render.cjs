// Native Electron render / interaction check, isolated from all user meetings.
// Run after build:ui: node_modules/.bin/electron test/ui-design/render.cjs
const { app, BrowserWindow } = require('electron');
const { build } = require('esbuild');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');

const UI_DIST = process.env.KESAMI_UI_DIST ? path.resolve(process.env.KESAMI_UI_DIST) : path.resolve(__dirname, '../../apps/ui/dist');

const CONTRAST_PROBE = `(() => {
    // Resolve modern CSS colors (including OKLCH) to sRGB before WCAG math.
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    const cache = new Map();
    const channels = value => {
        if (cache.has(value)) return cache.get(value);
        context.clearRect(0, 0, 1, 1);
        context.fillStyle = value;
        context.fillRect(0, 0, 1, 1);
        const pixel = context.getImageData(0, 0, 1, 1).data;
        const result = [pixel[0], pixel[1], pixel[2], pixel[3] / 255];
        cache.set(value, result);
        return result;
    };
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
    const assets = path.join(UI_DIST, 'assets');
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
    window.webContents.on('console-message', ({ level, message }) => {
        if (level === 'error' && !message.includes('Content Security Policy')) errors.push(message);
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
    const setDateTime = async (label, value) => {
        const parts = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/);
        assert(parts, 'device-local date and time');
        for (const [index, type] of ['year', 'month', 'day', 'hour', 'minute'].entries()) {
            await evaluate(`document.querySelector('[data-date-field="${label}"] [data-type="${type}"]').focus()`);
            for (const digit of String(Number(parts[index + 1]))) {
                window.webContents.sendInputEvent({ type: 'keyDown', keyCode: digit });
                window.webContents.sendInputEvent({ type: 'char', keyCode: digit });
                window.webContents.sendInputEvent({ type: 'keyUp', keyCode: digit });
            }
            await settle();
        }
        await evaluate('document.activeElement.blur()');
        await settle();
    };
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
    const captureResponsive = async (name, selector) => {
        const size = window.getContentSize();
        const theme = await evaluate("document.querySelector('.ks-app')?.dataset.theme || 'dark'");
        for (const mode of ['dark', 'light']) {
            await evaluate(`window.fixtureSetTheme(${JSON.stringify(mode)})`);
            for (const width of [320, 375, 414, 768]) {
                window.setContentSize(width, 900);
                await settle();
                const layout = await evaluate(`(() => { const node = document.querySelector(${JSON.stringify(selector)}); return { root: document.documentElement.scrollWidth, viewport: innerWidth, scroll: node?.scrollWidth, width: node?.clientWidth, overflowing: [...(node?.querySelectorAll('*') || [])].filter(el => el.getBoundingClientRect().right > node.getBoundingClientRect().right + 1).slice(0, 6).map(el => el.className) }; })()`);
                await capture(`rounded-${name}-${mode}-${width}`);
                assert(layout.root <= layout.viewport && layout.scroll <= layout.width, `${name} ${mode} ${width}px: ${JSON.stringify(layout)}`);
                if (await evaluate("!!document.querySelector('.ks-recording-hud')")) {
                    assert(await evaluate(`(() => {
                        const panel = document.querySelector('.ks-meeting-panel').getBoundingClientRect();
                        const hud = document.querySelector('.ks-recording-hud').getBoundingClientRect();
                        const input = document.querySelector('.ks-notes-composer textarea')?.getBoundingClientRect();
                        return panel.height > 80 && hud.top >= panel.bottom && hud.bottom <= innerHeight
                            && (!input || (input.top >= panel.top && input.bottom <= panel.bottom));
                    })()`), `${name} ${mode} ${width}px keeps the content and recording controls visible`);
                }
            }
        }
        window.setContentSize(...size);
        await evaluate(`window.fixtureSetTheme(${JSON.stringify(theme)})`);
        await settle();
    };
    const waitFor = async (expression, label, timeoutMs = 5000) => {
        assert(
            await evaluate(
                `new Promise(resolve => { const start = Date.now(); const timer = setInterval(() => { if (${expression}) { clearInterval(timer); resolve(true); } else if (Date.now() - start > ${timeoutMs}) { clearInterval(timer); resolve(false); } }, 25); })`
            ),
            label
        );
    };
    await window.loadFile(path.join(output, 'index.html'));
    await evaluate('document.fonts.ready');
    await waitFor("document.querySelector('.ks-welcome-primary')", 'development sign-in offers Google');
    assert(await evaluate("!document.querySelector('.ks-welcome input') && !document.body.textContent.includes('Connection & preferences') && !document.body.textContent.includes('NEW ACCOUNT')"), 'sign-in has no credential fields or anonymous entry');
    assert(await evaluate("document.querySelector('.ks-welcome-primary').disabled && document.body.textContent.includes('Open the Kesami desktop app')"), 'browser-only sign-in explains why Google is unavailable');
    await capture('01-sign-in');
    await captureResponsive('sign-in', '.ks-welcome');
    for (const mode of ['light', 'dark']) {
        await evaluate(`window.fixtureSetTheme(${JSON.stringify(mode)})`);
        const contrast = await evaluate(CONTRAST_PROBE.replace('SELECTORS', JSON.stringify(['.ks-welcome-poster h1', '.ks-welcome-primary'])));
        assert(contrast.every(item => item.ratio >= 4.5), `${mode} sign-in contrast: ${JSON.stringify(contrast)}`);
    }
    await evaluate("window.fixtureSetTheme('dark')");
    if (process.argv.includes('--workspace-only')) {
        await evaluate('window.fixtureEnterWorkspace()');
    } else {
        await evaluate("window.fixtureGoogleAttempts = 0; window.kesamiGoogleSignIn = { start: async () => { window.fixtureGoogleAttempts++; if (window.fixtureGoogleError) throw new Error(window.fixtureGoogleError); return { code: 'fixture-local-code', verifier: 'v'.repeat(64) }; } }; window.fixtureSetTheme('light')");
        await waitFor("!document.querySelector('.ks-welcome-primary').disabled", 'configured desktop Google sign-in is enabled');
        assert(await evaluate("!document.querySelector('.ks-welcome input')"), 'light-theme sign-in also has no credential fields');
        await capture('01-sign-in-google-light');
        await evaluate("window.fixtureGoogleError = 'Google sign-in was cancelled or denied.'");
        await click('Continue with Google');
        await waitFor("document.querySelector('.ks-welcome-error')?.textContent.includes('cancelled or denied')", 'Google cancellation is visible');
        assert(await evaluate("!document.querySelector('.ks-welcome-primary').disabled"), 'failed sign-in allows retry');
        for (const mode of ['dark', 'light']) {
            await evaluate(`window.fixtureSetTheme(${JSON.stringify(mode)})`);
            const target = await evaluate("(() => { const r = document.querySelector('.ks-welcome-primary').getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()");
            window.webContents.sendInputEvent({ type: 'mouseMove', ...target });
            await settle();
            const contrast = await evaluate(CONTRAST_PROBE.replace('SELECTORS', JSON.stringify(['.ks-welcome-primary'])));
            assert(contrast[0].ratio >= 4.5, `${mode} Google hover contrast: ${JSON.stringify(contrast)}`);
        }

        await evaluate("window.fixtureGoogleError = null; window.kesamiGoogleSignIn.start = () => { window.fixtureGoogleAttempts++; return new Promise(resolve => { window.fixtureResolveGoogle = resolve; }); }; void 0");
        await evaluate("document.querySelector('.ks-welcome-primary').click(); document.querySelector('.ks-welcome-primary').click()");
        await waitFor("document.querySelector('.ks-welcome-primary').textContent.includes('Waiting for Google')", 'pending Google sign-in shows loading');
        assert.equal(await evaluate('window.fixtureGoogleAttempts'), 2, 'rapid clicks launch only one new Google attempt');
        assert(await evaluate("document.querySelector('.ks-welcome-primary').disabled"));
        await evaluate("window.fixtureResolveGoogle({ code: 'fixture-local-code', verifier: 'v'.repeat(64) })");
        await waitFor("document.querySelector('.ks-workspace')", 'Google sign-in opens the workspace');
        assert(await evaluate("window.fixtureCalls.some(call => call.path === '/api/auth/google' && call.body?.code === 'fixture-local-code')"), 'local Google proof uses the existing backend exchange');
        assert(await evaluate("!window.fixtureCalls.some(call => ['/api/auth/login', '/api/auth/register'].includes(call.path))"), 'the sign-in screen never submits password credentials');
    }
    await capture('02-home');
    assert.equal(await evaluate("document.querySelectorAll('.ks-meeting-card').length"), 3);
    assert.equal(await evaluate("document.querySelectorAll('.ks-agenda-day').length"), 2, 'calendar shows two days per page');
    assert(await evaluate("document.querySelector('[aria-label=\"Previous two days\"]').disabled"), 'calendar cannot page into the past');
    const initialDates = await evaluate("[...document.querySelectorAll('.ks-agenda-date')].map(date => date.getAttribute('aria-label'))");
    await evaluate('window.fixtureCalendarRequests = []');
    await evaluate("document.querySelector('[aria-label=\"Next two days\"]').click()");
    await settle();
    assert.notDeepEqual(await evaluate("[...document.querySelectorAll('.ks-agenda-date')].map(date => date.getAttribute('aria-label'))"), initialDates);
    assert(await evaluate("document.querySelector('.ks-agenda-card').textContent.includes('Sprint Planning')"), 'the second page shows meetings from the six-day fetch');
    assert.equal(await evaluate('window.fixtureCalendarRequests.length'), 0, 'paging the agenda never refetches');
    assert(await evaluate("!document.querySelector('[aria-label=\"Next two days\"]').disabled"), 'calendar offers a third page');
    await evaluate("document.querySelector('[aria-label=\"Next two days\"]').click()");
    await settle();
    assert(await evaluate("document.querySelector('[aria-label=\"Next two days\"]').disabled"), 'calendar stops after six days');
    await click('Today');
    await evaluate('window.fixtureCalls = []');
    await evaluate("document.querySelector('[aria-label=\"Choose a folder for Design System Weekly\"]').click()");
    await settle();
    assert(await evaluate("document.activeElement?.closest('.ks-folder-picker') !== null"), 'the folder picker takes focus');
    assert(await evaluate("document.querySelector('.ks-folder-picker').textContent.includes('New folder “Design System”')"), 'the picker suggests a folder name from the meeting title');
    await capture('02-agenda-folder-picker');
    await evaluate("[...document.querySelectorAll('.ks-folder-picker-list [role^=\"menuitem\"]')].find(item => item.textContent.includes('Design Sync')).click()");
    await waitFor("document.querySelector('.ks-folder-picker-series')", 'choosing a folder for a recurring meeting offers to auto-add future ones');
    assert.deepEqual(
        await evaluate("window.fixtureCalls.filter(call => call.path === '/api/folders/rules' && call.method === 'POST').map(call => call.body)"),
        [{ provider: 'google', eventId: '1', seriesId: 'design-weekly', folderId: 'design', applyToSeries: false }],
        'the event is filed before the series question'
    );
    await capture('02-agenda-folder-auto-add');
    await click('Auto-add');
    await waitFor("!document.querySelector('.ks-folder-picker') && !document.querySelector('.ks-folder-picker-series')", 'answering closes the picker and series confirmation');
    assert.equal(await evaluate("window.fixtureCalls.filter(call => call.path === '/api/folders/rules' && call.method === 'POST').at(-1).body.applyToSeries"), true);
    assert(await evaluate("document.querySelector('[aria-label=\"Folder for Design System Weekly: Design Sync\"]') !== null"), 'the agenda row shows its folder');
    await evaluate("document.querySelector('[aria-label=\"Choose a folder for 1:1 with Alex\"]').click()");
    await settle();
    await evaluate("document.querySelector('.ks-folder-picker-create').click()");
    await waitFor("document.querySelector('[aria-label=\"Folder for 1:1 with Alex: 1:1 with Alex\"]')", 'a one-off meeting creates its suggested folder and closes without the series question');
    await evaluate("document.querySelector('.ks-sidebar-toggle').click()");
    await settle();
    assert(await evaluate("document.querySelector('.ks-workspace').classList.contains('is-sidebar-collapsed') && document.querySelector('.ks-sidebar').getBoundingClientRect().width === 0"), 'sidebar collapses out of view');
    assert.equal(await evaluate("document.querySelector('.ks-sidebar-expand')?.getAttribute('aria-expanded')"), 'false', 'collapsed sidebar leaves an expand control in the toolbar');
    await capture('02-home-sidebar-collapsed');
    await evaluate("document.querySelector('.ks-sidebar-expand').click()");
    await settle();
    assert(await evaluate("document.querySelector('.ks-sidebar').getBoundingClientRect().width > 150"), 'sidebar expands again');
    assert.deepEqual(await evaluate("[...document.querySelectorAll('.ks-agenda-date')].map(date => date.getAttribute('aria-label'))"), initialDates, 'Today resets calendar paging');
    for (const theme of ['light', 'dark']) {
        await evaluate(`window.fixtureSetTheme(${JSON.stringify(theme)})`);
        await settle();
        await capture(`02-home-${theme}`);
        assert(await evaluate(`(() => {
            const rows = [...document.querySelectorAll('.ks-agenda-row')];
            return rows.length > 0 && rows.every(row => {
                const main = row.querySelector('.ks-agenda-main').getBoundingClientRect();
                const join = row.querySelector('.ks-agenda-link').getBoundingClientRect();
                return join.left >= main.right && join.top < main.bottom;
            });
        })()`), `${theme} Join links align to the right of event details`);
        assert(await evaluate(`(() => {
            const cards = [...document.querySelectorAll('.ks-meeting-card')];
            return cards.every(card => parseFloat(getComputedStyle(card).borderRadius) > 0)
                && cards.slice(1).every((card, i) => card.getBoundingClientRect().top - cards[i].getBoundingClientRect().bottom >= 8);
        })()`), `${theme} meeting rows have rounded corners and gaps`);
        await evaluate("document.querySelector('[aria-label=\"Search meetings\"]').focus()");
        assert(await evaluate("getComputedStyle(document.querySelector('.ks-global-search')).outlineStyle === 'none'"), 'search has one focus border without an outer outline');
        await evaluate("document.activeElement.blur()");
        assert(await evaluate(`(() => {
            const agenda = document.querySelector('.ks-agenda').getBoundingClientRect();
            const meetings = document.querySelector('.ks-meetings-list').getBoundingClientRect();
            return agenda.bottom <= meetings.top;
        })()`), 'desktop schedule sits above the meeting library');
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
    for (const theme of ['dark', 'light']) {
        await evaluate(`window.fixtureSetTheme(${JSON.stringify(theme)})`);
        for (const width of [320, 375, 414, 768]) {
            window.setContentSize(width, 900);
            await settle();
            assert(await evaluate('document.documentElement.scrollWidth <= innerWidth'), `${theme} home fits ${width}px`);
            assert(await evaluate("document.querySelector('.ks-home').scrollWidth <= document.querySelector('.ks-home').clientWidth"), `${theme} home content fits ${width}px`);
            assert(await evaluate("!!document.querySelector('.ks-new-meeting button') && !!document.querySelector('[aria-label=\"Workspace tools\"]')"), 'recording and tools remain reachable');
            await capture(`02-rounded-home-${theme}-${width}`);
        }
    }
    window.setContentSize(1280, 824);
    await evaluate("window.fixtureSetTheme('dark')");
    await settle();
    await click('All meetings');
    await captureResponsive('library', '.ks-home');
    for (const theme of ['dark', 'light']) {
        await evaluate(`window.fixtureSetTheme(${JSON.stringify(theme)})`);
        await evaluate("document.querySelector('[aria-label=\"Cards view\"]').click()");
        await settle();
        assert.equal(await evaluate("document.querySelector('[aria-label=\"Cards view\"]').getAttribute('aria-pressed')"), 'true', 'the chosen layout is announced');
        assert.equal(await evaluate("localStorage.getItem('kesami.meeting-layout')"), 'cards', 'the layout preference is saved');
        assert.equal(await evaluate("document.querySelectorAll('.ks-meeting-card').length"), 3, 'switching layout preserves the visible meetings');
        for (const width of [1280, 620, 375, 320]) {
            window.setContentSize(width, 900);
            await settle();
            assert(await evaluate("document.querySelector('.ks-home').scrollWidth <= document.querySelector('.ks-home').clientWidth"), `${theme} meeting cards fit ${width}px`);
            assert(await evaluate(`(() => {
                const cards = [...document.querySelectorAll('.ks-meeting-card')];
                return cards.every(card => {
                    const rect = card.getBoundingClientRect();
                    const button = card.querySelector('.ks-meeting-card-body');
                    return button.getAttribute('aria-label').startsWith('Open ')
                        && card.querySelector('.ks-meeting-card-footer').getBoundingClientRect().bottom <= rect.bottom
                        && card.scrollWidth <= card.clientWidth;
                });
            })()`), `${theme} cards keep opening controls and metadata within their surface at ${width}px`);
            await capture(`meeting-cards-${theme}-${width}`);
        }
        window.setContentSize(1280, 824);
        await evaluate("document.querySelector('.ks-card-more').click()");
        await waitFor("document.querySelector('[role=\"menu\"]')", 'card options remain reachable');
        assert(await evaluate("document.querySelector('[role=\"menu\"]').textContent.includes('Delete meeting')"));
        window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
        window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
        await waitFor("!document.querySelector('[role=\"menu\"]')", 'card options close with Escape');
        await click('Home');
        assert.equal(await evaluate("document.querySelector('[aria-label=\"Cards view\"]').getAttribute('aria-pressed')"), 'true', 'Home shares the library layout preference');
        await click('All meetings');
        await evaluate("document.querySelector('[aria-label=\"List view\"]').click()");
        await settle();
        assert.equal(await evaluate("document.querySelector('[aria-label=\"List view\"]').getAttribute('aria-pressed')"), 'true');
    }
    await evaluate("window.fixtureSetTheme('dark')");
    if (process.argv.includes('--meeting-cards-only')) {
        await evaluate("document.querySelector('[aria-label=\"Cards view\"]').click()");
        await settle();
        await evaluate("document.querySelector('.ks-meeting-card-body').focus()");
        window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
        window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
        await waitFor("document.querySelector('.ks-meeting-main')", 'a meeting opens from its card with the keyboard');
        await evaluate("document.querySelector('[aria-label=\"Back to home\"]').click()");
        await waitFor("document.querySelector('.ks-meetings-cards')", 'returning home preserves Cards view');
        assert(!errors.some(message => /ReferenceError|TypeError|Minified React error/.test(message)));
        console.log(`PASS: HeroUI meeting cards/list, shared saved layout, options menus, keyboard opening, dashboard/search/folder flow, both themes and 320–1280px layouts. Screenshots: ${output}`);
        window.destroy();
        app.quit();
        return;
    }
    if (process.argv.includes('--manual-summary-only')) {
        const generations = () => evaluate("window.fixtureCalls.filter(call => call.path.endsWith('/summarize') && call.method === 'POST').length");
        const confirmGeneration = () => evaluate("[...document.querySelector('.ks-summary-regenerate-dialog').querySelectorAll('button')].find(button => button.textContent.trim() === 'Regenerate').click()");
        await evaluate("document.querySelector('.ks-meeting-card-body').click()");
        await waitFor("document.querySelector('#tab-summary')", 'completed meeting opens');
        await click('Summary');
        for (const theme of ['dark', 'light']) {
            await evaluate(`window.fixtureSetTheme(${JSON.stringify(theme)}); window.fixturePatchMeeting(window.fixtureBase)`);
            await settle();
            const before = await generations();
            assert.equal(await evaluate("document.querySelector('.ks-summary-generate').textContent.trim()"), 'Regenerate');
            await evaluate("document.querySelector('.ks-template-picker summary').click()");
            await click('Weekly Team Meeting');
            assert.equal(await generations(), before, 'opening notes and selecting a layout never generates a summary');
            await evaluate("document.querySelector('.ks-template-picker summary').click()");
            await click('Enhanced notes');
            await evaluate("document.querySelector('.ks-summary-generate').click()");
            await waitFor("document.querySelector('.ks-summary-regenerate-dialog')", 'regeneration requires replacement confirmation');
            for (const width of [1280, 375, 320]) {
                window.setContentSize(width, 900);
                await settle();
                assert(await evaluate("(() => { const node = document.querySelector('.ks-summary-regenerate-dialog'); return node.scrollWidth <= node.clientWidth && node.getBoundingClientRect().right <= innerWidth; })()"), `${theme} confirmation fits ${width}px`);
                await capture(`manual-summary-confirm-${theme}-${width}`);
            }
            await click('Keep current notes');
            assert.equal(await generations(), before, 'keeping notes makes no generation request');
            await evaluate("window.fixtureDeferSummary = true; document.querySelector('.ks-summary-generate').click()");
            await waitFor("document.querySelector('.ks-summary-regenerate-dialog')", 'regeneration confirmation opens again');
            await confirmGeneration();
            await waitFor("document.querySelector('[aria-label=\"Stop summary generation\"]')", 'generation exposes Cancel');
            assert.equal(await generations(), before + 1);
            assert(await evaluate("document.querySelector('.ks-summary-generate').disabled && document.querySelector('.ks-brief-lead').textContent.includes('Team aligned')"), 'current notes remain visible during generation');
            await evaluate("document.querySelector('[aria-label=\"Stop summary generation\"]').click()");
            await waitFor("!document.querySelector('[aria-label=\"Stop summary generation\"]') && !document.querySelector('.ks-summary-generate').disabled", 'cancel returns to the existing summary');
            assert(await evaluate("window.fixtureMeeting.summaryMarkdown === window.fixtureBase.summaryMarkdown"), 'cancellation preserves notes');
            await evaluate("window.fixturePatchMeeting({ summaryMarkdown: '', summarySections: [], actionItems: [], keyDecisions: [], emailDraft: '' }); window.fixtureSummaryFails = true; window.fixtureDeferSummary = false");
            await settle();
            assert.equal(await evaluate("document.querySelector('.ks-summary-generate').textContent.trim()"), 'Generate');
            assert(await evaluate("document.querySelector('.ks-brief-lead').textContent.includes('only when you request')"));
            await evaluate("document.querySelector('.ks-summary-generate').click()");
            await waitFor("document.querySelector('.ks-summary-generation-error')", 'generation errors are actionable');
            assert(await evaluate("!document.querySelector('.ks-summary-generate').disabled"), 'failed generation can be retried');
            await evaluate("window.fixtureSummaryFails = false; window.fixtureDeferSummary = true");
            const retryBefore = await generations();
            await evaluate("(() => { const button = document.querySelector('.ks-summary-generate'); button.click(); button.click(); })()");
            await waitFor("document.querySelector('[aria-label=\"Stop summary generation\"]')", 'retry shows progress');
            assert.equal(await generations(), retryBefore + 1, 'rapid clicks dispatch only one generation request');
            await capture(`manual-summary-generating-${theme}`);
            await evaluate('window.fixtureCompleteSummary()');
            await waitFor("document.querySelector('.ks-summary-generate').textContent.trim() === 'Regenerate'", 'successful generation switches to Regenerate');
            assert(await evaluate("document.querySelector('.ks-brief-lead').textContent.includes('Manually generated recap.')"), 'generated notes appear without reopening the meeting');
            assert(await evaluate("!document.querySelector('.ks-summary-generation-error')"), 'successful retry clears the error');
            await capture(`manual-summary-complete-${theme}`);
            await evaluate('window.fixtureSetConnected(false)');
            await settle();
            assert(await evaluate("document.querySelector('.ks-summary-generate').disabled"), 'offline generation is disabled');
            await evaluate('window.fixtureSetConnected(true); window.fixturePatchMeeting({ transcript: [] })');
            await settle();
            assert(await evaluate("document.querySelector('.ks-summary-generate').disabled && document.querySelector('.ks-summary-generation-hint')"), 'no transcript explains why generation is unavailable');
            await evaluate('window.fixturePatchMeeting(window.fixtureBase)');
            await settle();
            assert(await evaluate("document.querySelector('.ks-meeting-main').scrollWidth <= document.querySelector('.ks-meeting-main').clientWidth"), 'notes controls fit the narrow meeting view');
            window.setContentSize(1280, 824);
        }
        assert(!errors.some(message => /ReferenceError|TypeError|Minified React error/.test(message)));
        console.log(`PASS: manual Generate/Regenerate, no automatic calls on view/template changes, replacement confirmation, progress/cancel, errors/retry, duplicate clicks, offline/empty transcript, both themes and responsive controls. Screenshots: ${output}`);
        window.destroy(); app.quit(); return;
    }
    await click('List recent todos');
    await waitFor("document.querySelector('[aria-label=\"Meeting question\"]')?.value.includes('List recent action items')", 'library shortcut drafts a grounded question');

    await click('Ask Kesami');
    await captureResponsive('ask', '.ks-chat');
    await click('Home');
    await click('Schedule meeting');
    assert(await evaluate('window.fixtureScheduleOpened'), 'schedule action still opens the scheduling flow');
    await waitFor("document.querySelector('[data-date-field=Starts]')", 'new meeting uses the date picker');
    await evaluate("document.querySelector('[aria-label=\"Choose starts\"]').click()");
    await waitFor("document.querySelector('.ks-date-time-popover [role=grid]')", 'calendar opens inside the meeting dialog');
    await capture('02-new-meeting-date-picker');
    await evaluate("document.querySelector('.ks-date-time-popover [role=button][data-selected=true]').click()");
    await waitFor("!document.querySelector('.ks-date-time-popover')", 'selecting a day closes the calendar');
    assert(await evaluate("document.querySelector('[data-date-field=Starts]') !== null"), 'choosing a day preserves the meeting dialog');
    await evaluate("document.querySelector('[data-date-field=Starts] [data-type=day]').focus()");
    for (let count = 0; count < 3; count++) {
        window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Backspace' });
        window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Backspace' });
        await settle();
    }
    assert(await evaluate("[...document.querySelectorAll('button')].find(button => button.textContent.trim() === 'Create meeting').disabled"), 'incomplete dates cannot submit the previous value');
    await setDateTime('Starts', '2026-10-13T10:00');
    await evaluate(`(() => { const input = document.querySelector('#meeting-title'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'Date picker fixture'); input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await click('Create meeting');
    await waitFor('window.fixtureMeetingCreated', 'scheduling succeeds against the synthetic API');
    assert.equal(await evaluate("window.fixtureCalls.find(call => call.path === '/api/calendar/events' && call.method === 'POST').body.start"), new Date('2026-10-13T10:00').toISOString(), 'scheduling preserves device-local time conversion');
    if (process.argv.includes('--date-fields-only')) {
        await evaluate("document.querySelector('.ks-meeting-card-body').click()");
        await settle();
        await click('Actions');
        await waitFor("document.querySelector('.ks-action[data-action-kind=calendar] > .ks-button')", 'calendar action loads');
        await evaluate("document.querySelector('.ks-action[data-action-kind=calendar] > .ks-button').click()");
        await settle();
        await setDateTime('Action start', '2026-10-13T10:00');
        await setDateTime('Action end', '2026-10-13T09:30');
        assert(await evaluate("document.querySelector('[data-date-field=\"Action end\"]').textContent.includes('on or after the start')"), 'invalid end time explains the required range');
        await evaluate("document.querySelector('.ks-action[data-action-kind=calendar] [aria-label=\"Confirm reviewed action\"]').click()");
        assert(await evaluate("document.querySelector('.ks-action[data-action-kind=calendar] button[type=submit]').disabled"), 'end before start cannot submit');
        await setDateTime('Action end', '2026-10-13T10:30');
        assert(await evaluate("!document.querySelector('.ks-action[data-action-kind=calendar] [aria-label=\"Confirm reviewed action\"]').checked"), 'editing dates clears confirmation');
        for (const theme of ['light', 'dark']) {
            await evaluate(`window.fixtureSetTheme(${JSON.stringify(theme)})`);
            await settle();
            for (const width of [1280, 375]) {
                window.setContentSize(width, 900);
                await settle();
                await evaluate("document.querySelector('[aria-label=\"Choose action end\"]').scrollIntoView({ block: 'center' })");
                await settle();
                await evaluate("document.querySelector('[aria-label=\"Choose action end\"]').click()");
                await waitFor("document.querySelector('.ks-date-time-popover [role=grid]')", 'action calendar opens');
                assert(await evaluate("[...document.querySelectorAll('.ks-date-time-popover .calendar__cell')].some(cell => cell.textContent.trim() === '12' && cell.dataset.disabled === 'true')"), 'calendar prevents selecting days before the start');
                await capture(`date-fields-${theme}-${width}`);
                assert(await evaluate(`(() => {
                    const bounds = document.querySelector('.ks-date-time-popover').getBoundingClientRect();
                    return bounds.left >= 0 && bounds.right <= innerWidth && bounds.top >= 0 && bounds.bottom <= innerHeight;
                })()`), `${theme} action calendar fits ${width}px`);
                window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
                window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
                await waitFor("!document.querySelector('.ks-date-time-popover')", 'Escape dismisses the calendar');
            }
        }
        await evaluate("document.querySelector('.ks-action[data-action-kind=calendar] [aria-label=\"Confirm reviewed action\"]').click()");
        await evaluate("document.querySelector('.ks-action[data-action-kind=calendar] button[type=submit]').click()");
        await waitFor("document.querySelector('.ks-action[data-action-kind=calendar][data-action-status=succeeded]')", 'reviewed calendar action is saved');
        const payload = await evaluate("window.fixtureCalls.find(call => call.path.endsWith('/actions/calendar-action') && call.method === 'POST').body");
        assert.equal(payload.start, new Date('2026-10-13T10:00').toISOString());
        assert.equal(payload.end, new Date('2026-10-13T10:30').toISOString());
        assert(payload.confirmed);
        assert.equal(payload.providerRevision, 'fixture-google-target');
        assert(!errors.some(message => /ReferenceError|TypeError|Minified React error/.test(message)));
        console.log(`PASS: meeting/calendar date pickers, incomplete and invalid dates, confirmation reset, local timezone, popovers in both themes at desktop/mobile widths. Screenshots: ${output}`);
        window.destroy();
        app.quit();
        return;
    }
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
    assert(await evaluate("document.body.textContent.includes('No events today')"));
    await evaluate('window.fixtureSetEmpty(false)');
    await settle();
    window.setContentSize(794, 1000);
    await evaluate("document.documentElement.dataset.textSize = 'large'");
    await settle();
    await click('Ask Kesami');
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
    await evaluate("document.querySelector('.ks-memory-filters').open = true");
    await evaluate("document.querySelector('[aria-label=\"Memory entity type\"]').click()");
    await waitFor("document.querySelector('[role=option]')", 'entity options open');
    await evaluate("[...document.querySelectorAll('[role=option]')].find(option => option.textContent.trim() === 'Company').click()");
    await settle();
    await evaluate(`(() => {
        const set = (label, value) => { const input = document.querySelector('[aria-label="' + label + '"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })); };
        set('Memory entity name', 'Acme'); set('Memory start date', '2026-10-01'); set('Memory end date', '2026-09-01');
    })()`);
    await settle();
    await evaluate("document.querySelector('.ks-memory-filters form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))");
    await settle();
    assert(await evaluate("document.querySelector('.ks-memory-filters [role=alert]').textContent.includes('precede')"));
    await evaluate(`(() => { const input = document.querySelector('[aria-label="Memory end date"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '2026-10-31'); input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await settle();
    await evaluate("document.querySelector('.ks-memory-filters form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))");
    await settle();
    await evaluate(`(() => { const textarea = document.querySelector('[aria-label="Meeting question"]'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(textarea, 'What commitments were made?'); textarea.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await settle();
    await evaluate("document.querySelector('.ks-chat-composer').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))");
    await settle();
    assert(await evaluate("window.fixtureCalls.some(call => call.path === '/api/chat/threads' && call.body?.scope?.entity?.name === 'Acme' && call.body.scope.entity.kind === 'company' && call.body.scope.fromMs < call.body.scope.toMs)"), 'filters reach the chat request');
    await capture('02-meeting-memory-filters');
    await click('Clear filters');
    await evaluate("document.querySelector('.ks-memory-filters').open = false");
    await settle();

    window.setContentSize(1280, 824);
    await evaluate("delete document.documentElement.dataset.textSize");
    await settle();
    await click('Home');
    await click('Product1');
    assert.equal(await evaluate("document.querySelectorAll('.ks-meeting-card').length"), 1);
    await evaluate('document.querySelector(\'[aria-label="New folder"]\').click()');
    for (const theme of ['light', 'dark']) {
        await evaluate(`window.fixtureSetTheme(${JSON.stringify(theme)})`);
        await settle();
        assert(await evaluate(`(() => {
            const dialog = document.querySelector('[role="dialog"].ks-modal');
            if (!dialog?.closest('.ks-app')) return false;
            const style = getComputedStyle(dialog);
            const swatches = [...dialog.querySelectorAll('.ks-color-picker button')];
            const canvas = document.createElement('canvas');
            canvas.width = canvas.height = 1;
            const context = canvas.getContext('2d');
            const opaque = color => {
                context.clearRect(0, 0, 1, 1);
                context.fillStyle = color;
                context.fillRect(0, 0, 1, 1);
                return context.getImageData(0, 0, 1, 1).data[3] === 255;
            };
            return opaque(style.backgroundColor) && swatches.length === 5
                && swatches.every(button => opaque(getComputedStyle(button).backgroundColor));
        })()`), `${theme} folder dialog has an opaque surface and visible color choices`);
        await capture(`02-new-folder-${theme}`);
    }
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
    assert(await evaluate("!document.querySelector('.ks-meeting-chat')"), 'recording starts with Ask AI closed');
    const midStream = await evaluate("document.querySelector('li[aria-live=\"polite\"] p').textContent");
    await evaluate('new Promise(resolve => setTimeout(resolve, 800))');
    await capture('03-transcript');
    await captureResponsive('live-transcript', '.ks-meeting-main');
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
    await evaluate("window.fixturePatchMeeting({ transcript: window.fixtureBase.transcript.map(turn => (turn.id === 'turn-5' ? { ...turn, speaker: 'Speaker 2' } : turn)), metadata: { ...window.fixtureBase.metadata, participants: ['Maya Chen', 'Alex Rivera', 'Sam Park', 'Jo Nguyen', 'Priya Das'], speakingActivity: [{ name: 'Jo Nguyen', startMs: 20000, endMs: 23500 }, { name: 'Priya Das', startMs: 20400, endMs: 20700 }] } })");
    await settle();
    await evaluate("document.querySelector('[data-turn-id=\"turn-5\"] .ks-speaker-name').click()");
    await settle();
    assert(await evaluate("!!document.querySelector('.ks-speaker-editor')"), 'clicking a speaker opens the speaker editor');
    assert.equal(await evaluate("document.querySelector('.ks-speaker-editor [data-state=on]').textContent"), 'Every line', 'a generic speaker is renamed everywhere by default');
    assert.equal(await evaluate("document.querySelector('.ks-speaker-suggestion').dataset.recommended"), 'true', 'the person the meeting showed talking is recommended');
    assert(await evaluate("document.querySelector('.ks-speaker-suggestion').textContent.includes('Jo Nguyen') && document.querySelector('.ks-speaker-suggestion').textContent.includes('100% of these lines')"));
    assert(await evaluate("[...document.querySelectorAll('.ks-speaker-suggestion')].some(button => button.textContent.includes('Priya Das'))"), 'other people in the call are offered too');
    await capture('17-speaker-editor');
    await evaluate("document.querySelector('.ks-speaker-suggestion').click()");
    await settle();
    await settle();
    assert(await evaluate("window.fixtureSpeakerEdits.some(([scope, from, to]) => scope === 'all' && from === 'Speaker 2' && to === 'Jo Nguyen')"));
    assert.equal(await evaluate("document.querySelector('[data-turn-id=\"turn-5\"] .ks-speaker-name').textContent"), 'Jo Nguyen');
    assert(await evaluate("document.querySelector('.ks-speaker-notice').textContent.includes('Speaker 2 is now Jo Nguyen')"));
    assert(await evaluate("document.activeElement === document.querySelector('[data-turn-id=\"turn-5\"] .ks-speaker-name')"), 'focus returns to the speaker after a change');
    await evaluate("document.querySelector('[data-turn-id=\"turn-1\"] .ks-speaker-name').click()");
    await settle();
    assert.equal(await evaluate("document.querySelector('.ks-speaker-editor [data-state=on]').textContent"), 'Just this line', 'a named speaker changes one line by default');
    await evaluate(`(() => {
        const input = document.querySelector('.ks-speaker-editor input');
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'Priya Das');
        input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await settle();
    await evaluate("document.querySelector('.ks-speaker-editor form').requestSubmit()");
    await settle();
    await settle();
    assert(await evaluate("window.fixtureSpeakerEdits.some(([scope, turnId, to]) => scope === 'line' && turnId === 'turn-1' && to === 'Priya Das')"));
    assert.equal(await evaluate("document.querySelector('[data-turn-id=\"turn-1\"] .ks-speaker-name').textContent"), 'Priya Das');
    assert.equal(await evaluate("document.querySelector('[data-turn-id=\"turn-4\"] .ks-speaker-name').textContent"), 'Alex Rivera', 'changing one line leaves the speaker’s other lines alone');
    await evaluate("document.querySelector('[data-turn-id=\"turn-0\"] .ks-speaker-name').click()");
    await settle();
    await evaluate("document.querySelector('.ks-speaker-editor input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
    await settle();
    assert(await evaluate("!document.querySelector('.ks-speaker-editor')"), 'Escape closes the speaker editor');
    await evaluate("window.fixturePatchMeeting({ transcript: window.fixtureBase.transcript, metadata: window.fixtureBase.metadata })");
    await settle();
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
    await click('Notes');
    await captureResponsive('live-notes', '.ks-meeting-main');
    for (const theme of ['dark', 'light']) {
        await evaluate(`window.fixtureSetTheme(${JSON.stringify(theme)})`);
        await capture(`03-live-notes-${theme}`);
        assert(await evaluate(`(() => {
            const editor = document.querySelector('.ks-notes-editor');
            const panel = document.querySelector('.ks-meeting-panel').getBoundingClientRect();
            const input = editor.querySelector('textarea').getBoundingClientRect();
            const controls = document.querySelector('.ks-recording-hud').getBoundingClientRect();
            return getComputedStyle(editor).borderTopWidth === '0px' && input.top >= panel.top
                && input.bottom <= panel.bottom && panel.bottom <= controls.top && controls.bottom <= innerHeight;
        })()`), `${theme} notes use one panel and keep the editor and recording controls visible`);
    }
    await click('Transcript');
    await evaluate("document.querySelector('.ks-talk-time summary').click()");
    assert(await evaluate("document.querySelector('.ks-talk-time').open"), 'speaker activity opens on request');
    await capture('03-speaker-activity');
    await evaluate("document.querySelector('.ks-talk-time summary').click()");
    assert(await evaluate("!document.querySelector('.ks-meeting-chat')"), 'switching recording tabs keeps Ask AI closed');
    await click('Ask AI');
    assert(await evaluate("document.querySelector('.ks-meeting-chat') !== null"), 'Ask AI opens only when requested');
    await settle();
    assert(await evaluate("document.querySelector('.ks-meeting-chat').textContent.includes('transcript captured when you send')"));
    assert(await evaluate("document.querySelector('.ks-recording-hud') !== null"));
    assert(await evaluate(`(() => {
        const log = document.querySelector('.ks-chat-log').getBoundingClientRect();
        const last = [...document.querySelectorAll('.ks-chat-starters button')].at(-1).getBoundingClientRect();
        return last.bottom <= log.bottom;
    })()`), 'all three suggestions are visible in the default desktop panel');
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
    await evaluate(`(() => {
        const textarea = document.querySelector('[aria-label="Meeting question"]');
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(textarea, 'Keep this question while expanding');
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
        textarea.focus();
    })()`);
    await settle();
    assert(await evaluate(`(() => {
        const style = getComputedStyle(document.querySelector('[aria-label="Meeting question"]'));
        return style.outlineStyle === 'none' && style.boxShadow === 'none' && style.borderTopWidth === '0px';
    })()`), 'the composer owns the focus ring; the textarea has no nested outline');
    await evaluate("document.querySelector('[aria-label=\"Expand AI panel\"]').click()");
    await settle();
    assert(await evaluate("document.querySelector('.ks-meeting-chat').getBoundingClientRect().width > 800"), 'expanded chat uses the meeting workspace');
    assert.equal(await evaluate("document.querySelector('[aria-label=\"Meeting question\"]').value"), 'Keep this question while expanding');
    assert.equal(await evaluate("document.querySelector('[aria-label=\"Resize AI chat\"]')"), null);
    await capture('03-live-chat-expanded');
    await evaluate("document.querySelector('[aria-label=\"Restore AI panel\"]').click()");
    await settle();
    assert.equal(await evaluate("document.querySelector('.ks-meeting-chat').getBoundingClientRect().width"), startingWidth + 60);
    assert.equal(await evaluate("document.querySelector('[aria-label=\"Meeting question\"]').value"), 'Keep this question while expanding');
    for (const theme of ['dark', 'light']) {
        await evaluate(`window.fixtureSetTheme('${theme}'); document.documentElement.dataset.textSize = 'large'`);
        window.setContentSize(620, 540);
        await settle();
        assert(await evaluate(`(() => {
            const panel = document.querySelector('.ks-meeting-chat');
            const composer = document.querySelector('.ks-chat-composer').getBoundingClientRect();
            const history = document.querySelector('[aria-label="Conversation history"]').getBoundingClientRect();
            const bounds = panel.getBoundingClientRect();
            return panel.scrollWidth <= panel.clientWidth && composer.bottom <= bounds.bottom && history.bottom <= bounds.bottom;
        })()`), 'large text keeps the composer and history button inside a short, narrow panel');
        await evaluate("document.querySelector('[aria-label=\"Conversation history\"]').click()");
        await settle();
        assert(await evaluate("document.querySelector('.ks-chat-threads').scrollWidth <= document.querySelector('.ks-chat-threads').clientWidth"), 'history fits a narrow panel');
        await evaluate("document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
        await settle();
        assert.equal(await evaluate("document.querySelector('[aria-label=\"Meeting question\"]').value"), 'Keep this question while expanding');
        await evaluate("document.querySelector('[aria-label=\"Meeting question\"]').focus()");
        await capture(`03-live-chat-short-${theme}`);
    }
    window.setContentSize(1280, 824);
    await evaluate("window.fixtureSetTheme('dark'); delete document.documentElement.dataset.textSize");
    await settle();
    await click('Summarize the discussion so far');
    await settle();
    assert(await evaluate("window.fixtureCalls.some(call => call.path === '/api/chat/threads/fixture-live-chat/messages' && call.body?.question === 'Summarize the discussion so far')"), 'a suggested question sends to the real chat flow');
    assert(await evaluate("document.querySelector('.ks-meeting-chat').textContent.includes('Transcript captured through 0:23')"));
    assert(await evaluate("document.querySelector('.ks-recording-hud') !== null"));
    await capture('03-live-answer');
    await evaluate("document.querySelector('[aria-label=\"Expand AI panel\"]').click()");
    await settle();
    assert(await evaluate("document.querySelector('.ks-chat-assistant').textContent.includes('Oct 15')"), 'expanding preserves the current answer');
    await evaluate("window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))");
    await settle();
    assert(await evaluate("!!document.querySelector('.ks-meeting-chat:not(.is-expanded)')"), 'Escape restores an expanded panel');
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
    assert.deepEqual(
        await evaluate("[...document.querySelectorAll('.ks-meeting-tabs > button')].map(button => button.id)"),
        ['tab-summary', 'tab-transcript', 'tab-commitments', 'tab-actions', 'tab-replay'],
        'a finished meeting offers summary, transcript, commitments, actions and recording'
    );
    await click('Summary');
    await evaluate("document.querySelector('.ks-brief-task input').click()");
    await settle();
    assert(
        await evaluate("document.querySelector('.ks-brief-task input').checked && document.querySelector('.ks-brief-task').classList.contains('is-done')"),
        'next steps tick off from the summary'
    );
    await evaluate("document.querySelector('.ks-template-picker summary').click()");
    await click('Weekly Team Meeting');
    await waitFor("document.querySelector('.ks-template-picker summary').textContent.includes('Weekly Team Meeting')", 'template selection persists locally');
    assert(await evaluate("document.querySelector('.ks-template-content').textContent.includes('Decisions') && document.querySelector('.ks-template-content').textContent.includes('Action items')"), 'template displays existing structured sections');
    await evaluate("document.querySelector('.ks-template-picker summary').click()");
    await click('New template');
    await evaluate(`(() => { const input = document.querySelector('[aria-label="Template name"]'); const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; setter.call(input, 'Project review'); input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await settle();
    await click('Save template');
    await waitFor("document.querySelector('.ks-template-picker summary').textContent.includes('Project review')", 'custom template saved and selected');
    await evaluate("document.querySelector('.ks-template-picker summary').click()");
    await capture('05-template-picker');
    await captureResponsive('template-picker', '.ks-meeting-main');
    assert(await evaluate("(() => { const r = document.querySelector('.ks-template-menu').getBoundingClientRect(); const root = document.querySelector('.ks-meeting-main').getBoundingClientRect(); return r.left >= root.left && r.right <= root.right; })()"), 'template menu stays within meeting view');

    await click('Enhanced notes');
    await capture('05-summary');
    await captureResponsive('summary', '.ks-meeting-main');
    await click('Commitments');
    await waitFor("[...document.querySelectorAll('button')].some(b => b.textContent === 'Detect commitments' && !b.disabled)", 'commitments empty state loads');
    await evaluate('window.fixtureCommitmentsFails = true');
    await click('Detect commitments');
    await waitFor("document.querySelector('.ks-commitments [role=alert]')", 'detection errors are visible');
    assert(await evaluate("document.querySelector('.ks-commitments [role=alert]').textContent.includes('Synthetic commitment service unavailable')"));
    await evaluate('window.fixtureCommitmentsFails = false');
    await click('Retry loading');
    await waitFor("!document.querySelector('.ks-commitments [role=alert]') && !document.querySelector('.ks-commitments [role=status]')", 'loading retry clears the error');
    await click('Detect commitments');
    await waitFor("document.querySelectorAll('.ks-commitment').length === 3", 'local candidates render');
    assert.equal(await evaluate("document.querySelectorAll('.ks-commitment[data-classification=explicit_commitment]').length"), 1);
    assert(await evaluate("document.querySelector('.ks-commitments').textContent.includes('Alex Rivera') && document.querySelector('.ks-commitments').textContent.includes('Confidence: High')"));
    assert(await evaluate("!document.querySelector('.ks-commitment[data-classification=unclear] .ks-button')"), 'unclear speech cannot be confirmed');
    await click('Review suggestion');
    assert(await evaluate("document.querySelector('.ks-commitment[data-classification=suggested_action] button[type=submit]').disabled"), 'suggestion needs a reviewed owner');
    await click('Cancel review');
    await click('Review commitment');
    assert.equal(await evaluate("document.querySelector('[aria-label=\"Commitment person\"]').value"), 'Alex Rivera');
    const beforeReview = await evaluate('window.fixtureMeeting.actionItems.length');
    assert.equal(beforeReview, 1, 'detection does not create action items');
    await click('Confirm & add action');
    await waitFor("document.querySelector('.ks-commitment[data-status=confirmed]')", 'human review is persisted');
    assert.equal(await evaluate('window.fixtureMeeting.actionItems.length'), 2);
    const reviewCall = await evaluate("window.fixtureCalls.find(call => call.method === 'PATCH' && call.path.endsWith('/commitments/promise'))");
    assert.equal(reviewCall.body.transcriptRevision, 'fixture-transcript');
    assert.equal(reviewCall.body.person, 'Alex Rivera');
    for (const theme of ['dark', 'light']) {
        await evaluate(`window.fixtureSetTheme(${JSON.stringify(theme)})`);
        await capture(`05-commitments-${theme}`);
        assert(await evaluate("document.querySelector('.ks-commitments').scrollWidth <= document.querySelector('.ks-commitments').clientWidth"), 'commitments fit the meeting panel');
    }
    await evaluate("document.querySelector('.ks-commitment[data-classification=suggested_action] .ks-text-button:last-child').click()");
    await waitFor("document.querySelector('.ks-commitment[data-status=dismissed]')", 'suggestions can be dismissed');
    await evaluate("document.querySelector('.ks-commitment[data-status=confirmed] > .ks-text-button').click()");
    await settle();
    assert.deepEqual(await evaluate('window.fixtureSourceTarget.turnIds'), ['turn-4']);
    assert.equal(await evaluate('window.fixtureSourceTarget.preferTranscript'), true);
    assert.equal(await evaluate("document.querySelector('.ks-meeting-tabs [aria-selected=true]').id"), 'tab-transcript');
    await click('Commitments');
    await waitFor("document.querySelector('.ks-commitment[data-status=confirmed]')", 'review persists when tab is reopened');
    await click('Summary');
    assert.equal(await evaluate("document.querySelectorAll('.ks-brief-task').length"), 2, 'confirmed commitment appears among local tasks');
    await evaluate('window.fixtureActionsFails = true');
    await click('Actions');
    await waitFor("document.querySelector('.ks-actions [role=alert]')", 'actions loading errors are visible');
    await evaluate('window.fixtureActionsFails = false; window.fixtureActionsEmpty = true');
    await click('Reload actions');
    await waitFor("document.querySelector('.ks-actions .ks-commitment-empty')", 'actions empty state');
    await evaluate('window.fixtureActionsEmpty = false');
    await click('Refresh actions');
    await waitFor("document.querySelectorAll('.ks-action').length === 6 && document.querySelectorAll('.ks-share-option').length === 2", 'all action types and summary destinations load');
    assert.equal(await evaluate("window.fixtureCalls.filter(c => c.method === 'POST' && c.path.includes('/actions/')).length"), 0, 'viewing suggestions executes nothing');
    const actionField = async (kind, label, value) => {
        if (label === 'Action start' || label === 'Action end') {
            await setDateTime(label, value);
            return;
        }
        await evaluate(`(() => { const input = document.querySelector('.ks-action[data-action-kind=${kind}] [aria-label="${label}"]'); Object.getOwnPropertyDescriptor(input.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(value)}); input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
        await settle();
    };
    const reviewAction = async kind => {
        await evaluate(`document.querySelector('.ks-action[data-action-kind=${kind}] > .ks-button').click()`);
        await settle();
        assert(await evaluate(`document.querySelector('.ks-action[data-action-kind=${kind}] button[type=submit]').disabled`), 'review is required before execution');
    };
    const confirmAction = async (kind, status = 'succeeded') => {
        await evaluate(`document.querySelector('.ks-action[data-action-kind=${kind}] [aria-label="Confirm reviewed action"]').click()`);
        await settle();
        await evaluate(`document.querySelector('.ks-action[data-action-kind=${kind}] button[type=submit]').click()`);
        await waitFor(`document.querySelector('.ks-action[data-action-kind=${kind}][data-action-status=${status}]')`, `${kind} persists ${status}`);
    };
    await click('Summary');
    await click('Share summary');
    await waitFor("document.querySelector('.ks-share-form') && !document.querySelector('.ks-share-scroll').getAttribute('aria-busy').includes('true')", 'summary dialog loads');
    assert(await evaluate("document.querySelector('#tab-summary').getAttribute('aria-selected') === 'true'"), 'sharing keeps the Summary tab selected');
    assert.equal(await evaluate("window.fixtureCalls.filter(c => c.method === 'POST' && c.path.includes('/actions/')).length"), 0);
    assert(await evaluate("document.querySelector('.ks-share-target').textContent.includes('#meeting-recaps')"), 'Slack destination is shown');
    assert.equal(await evaluate("document.querySelectorAll('.ks-share-dialog select').length"), 0, 'no redundant destination dropdown');
    const shareField = async (label, value) => {
        await evaluate(`(() => { const input = document.querySelector('.ks-share-dialog [aria-label="${label}"]'); Object.getOwnPropertyDescriptor(input.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(value)}); input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
        await settle();
    };
    const share = async status => {
        await evaluate("(() => { const input = document.querySelector('[aria-label=\"Confirm reviewed summary\"]'); if (!input.checked) input.click(); })()");
        await settle();
        await evaluate("document.querySelector('.ks-share-form button[type=submit]').click()");
        await waitFor(`document.querySelector('.ks-share-form[data-action-status=${status}]')`, `summary persists ${status}`);
    };
    await evaluate("document.querySelector('[aria-label=\"Confirm reviewed summary\"]').click()");
    await shareField('Summary body', 'Only the edited, reviewed recap');
    await evaluate('window.fixtureSlackDisconnected = true; document.querySelector(\'[aria-label="Refresh summary connection"]\').click()');
    await waitFor("document.querySelector('.ks-share-target').textContent.includes('Connect Slack')", 'missing connection has a setup action');
    assert(await evaluate("document.querySelector('[aria-label=\"Confirm reviewed summary\"]').disabled && document.querySelector('.ks-share-form button[type=submit]').disabled"), 'disconnected providers cannot be confirmed');
    await click('Connect Slack');
    await waitFor("!document.querySelector('.ks-share-dialog')", 'setup closes the review');
    assert.equal(await evaluate('window.settingsTabOpened'), 'connectors');
    await evaluate('window.fixtureSlackDisconnected = false');
    await click('Share summary');
    await waitFor("document.querySelector('.ks-share-form') && document.querySelector('.ks-share-scroll').getAttribute('aria-busy') === 'false'", 'setup return refreshes destinations');
    assert.equal(await evaluate("document.querySelector('[aria-label=\"Summary body\"]').value"), 'Only the edited, reviewed recap');
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
    await waitFor("!document.querySelector('.ks-share-dialog')", 'Escape cancels review');
    assert.equal(await evaluate("window.fixtureCalls.filter(c => c.method === 'POST' && c.path.includes('/actions/')).length"), 0, 'cancel and setup execute nothing');
    await click('Share summary');
    await waitFor("document.querySelector('.ks-share-form') && document.querySelector('.ks-share-scroll').getAttribute('aria-busy') === 'false'", 'cancelled review reopens');
    assert.equal(await evaluate("document.querySelector('[aria-label=\"Summary body\"]').value"), 'Only the edited, reviewed recap', 'cancel retains draft');
    assert(await evaluate("document.querySelector('.ks-share-form button[type=submit]').disabled"), 'editing summary clears confirmation');
    await shareField('Summary body', '界'.repeat(7000));
    assert(await evaluate("document.querySelector('.ks-share-form [role=alert]').textContent.includes('20 KB')"), 'large Unicode summary requires explicit shortening');
    await shareField('Summary body', 'Only the edited, reviewed recap');
    await evaluate("document.querySelector('[aria-label=\"Confirm reviewed summary\"]').click()");
    for (const theme of ['dark', 'light']) {
        await evaluate(`window.fixtureSetTheme(${JSON.stringify(theme)})`);
        await capture(`05-summary-share-${theme}`);
        const contrast = await evaluate(CONTRAST_PROBE.replace('SELECTORS', JSON.stringify(['.ks-share-heading p', '.ks-share-target p', '.ks-share-content-note', '.ks-share-footer label', '.ks-share-footer .ks-primary'])));
        assert(contrast.every(row => row.ratio >= 4.5), `summary sharing contrast ${theme}: ${JSON.stringify(contrast)}`);
    }
    const shareSize = window.getContentSize();
    window.setContentSize(520, 650); await settle();
    await capture('05-summary-share-narrow');
    const shareLayout = await evaluate("(() => { const node = document.querySelector('.ks-share-dialog'), rect = node.getBoundingClientRect(); return { scroll: node.scrollWidth, width: node.clientWidth, right: rect.right, viewport: innerWidth }; })()");
    assert(shareLayout.scroll <= shareLayout.width && shareLayout.right <= shareLayout.viewport + 1, `sharing fits a narrow window: ${JSON.stringify(shareLayout)}`);
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Tab' });
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Tab' });
    await settle();
    assert(await evaluate("document.querySelector('.ks-share-dialog').contains(document.activeElement)"), 'keyboard focus stays in the dialog');
    window.setContentSize(...shareSize); await settle();
    await evaluate('window.fixtureActionPermission = true');
    await share('failed');
    assert.equal(await evaluate("document.querySelector('[aria-label=\"Summary body\"]').value"), 'Only the edited, reviewed recap', 'permission errors retain edits');
    await click('Reconnect Slack');
    await waitFor("!document.querySelector('.ks-share-dialog')", 'connection setup closes review');
    assert.equal(await evaluate('window.settingsTabOpened'), 'connectors', 'connection recovery opens the Connectors tab');
    await evaluate('window.fixtureActionPermission = false');
    await click('Share summary');
    await waitFor("document.querySelector('.ks-share-form') && document.querySelector('.ks-share-scroll').getAttribute('aria-busy') === 'false'", 'review reopens');
    assert.equal(await evaluate("document.querySelector('[aria-label=\"Summary body\"]').value"), 'Only the edited, reviewed recap', 'settings detour retains draft');
    await evaluate("document.querySelector('[aria-label=\"Confirm reviewed summary\"]').click(); window.fixtureSlackTargetRevision = 'changed-slack-target'");
    await evaluate("document.querySelector('[aria-label=\"Refresh summary connection\"]').click()");
    await waitFor("!document.querySelector('[aria-label=\"Confirm reviewed summary\"]').checked", 'provider changes reset confirmation');
    await share('succeeded');
    const slackCall = await evaluate("window.fixtureCalls.findLast(c => c.path.endsWith('/actions/summary-slack'))");
    assert.equal(slackCall.body.body, 'Only the edited, reviewed recap');
    assert.equal(slackCall.body.providerRevision, 'changed-slack-target');
    assert.equal(slackCall.body.destination, 'slack');
    assert(await evaluate("document.querySelector('.ks-share-result').textContent.includes('Summary posted to Slack')"));
    assert(await evaluate("document.querySelector('[aria-label=\"Summary body\"]').readOnly && !document.querySelector('.ks-share-form button[type=submit]')"), 'saved summaries cannot be edited or resent');
    await evaluate("[...document.querySelectorAll('.ks-share-switch button')].find(b => b.textContent === 'Jira').click()");
    await settle();
    assert(await evaluate("document.querySelector('.ks-share-target').textContent.includes('API') && document.querySelector('.ks-share-target').textContent.includes('example.atlassian.net')"));
    await shareField('Summary body', 'One recap issue, with no task bulk export');
    await share('succeeded');
    assert.equal(await evaluate("window.fixtureCalls.filter(c => c.path.endsWith('/actions/summary-jira') && c.method === 'POST').length"), 1);
    await click('Done');
    await click('Actions');
    await waitFor("document.querySelectorAll('.ks-action').length === 6", 'local actions remain accessible');
    for (const kind of ['action_item', 'commitment', 'follow_up']) {
        await reviewAction(kind); await confirmAction(kind);
    }
    await reviewAction('email');
    await actionField('email', 'Action recipients', 'acme@example.com');
    await evaluate("document.querySelector('.ks-action[data-action-kind=email] [aria-label=\"Confirm reviewed action\"]').click()");
    await actionField('email', 'Action title', 'Proposal for Acme');
    assert(await evaluate("document.querySelector('.ks-action[data-action-kind=email] button[type=submit]').disabled"), 'editing content clears confirmation');
    await confirmAction('email');
    await evaluate("document.querySelector('.ks-action[data-action-kind=email] details').open = true");
    await settle();
    await click('Copy draft');
    await waitFor("document.querySelector('.ks-action[data-action-kind=email]').textContent.includes('Draft copied')", 'saved draft copies');
    assert(await evaluate("document.querySelector('.ks-action[data-action-kind=email]').textContent.includes('not sent')"), 'draft is local, never sent');
    await evaluate('window.fixtureActionPermission = true');
    await reviewAction('calendar');
    await actionField('calendar', 'Action start', '2026-10-13T10:00');
    await actionField('calendar', 'Action end', '2026-10-13T09:30');
    assert(await evaluate("document.querySelector('.ks-action[data-action-kind=calendar] button[type=submit]').disabled"), 'invalid calendar end is blocked');
    await actionField('calendar', 'Action end', '2026-10-13T10:30');
    await evaluate("document.querySelector('.ks-action[data-action-kind=calendar] [aria-label=\"Confirm reviewed action\"]').click()");
    await actionField('calendar', 'Action start', '2026-10-13T10:05');
    assert(await evaluate("!document.querySelector('.ks-action[data-action-kind=calendar] [aria-label=\"Confirm reviewed action\"]').checked"), 'date edits clear confirmation');
    await actionField('calendar', 'Action start', '2026-10-13T10:00');
    await actionField('calendar', 'Action recipients', 'john@example.com');
    assert(await evaluate("document.querySelector('.ks-action[data-action-kind=calendar]').textContent.includes('alex@example.com')"), 'calendar account is reviewed');
    await confirmAction('calendar', 'failed');
    await click('Open Settings');
    assert(await evaluate('window.settingsOpened'), 'permission error opens settings');
    await evaluate('window.fixtureActionPermission = false');
    await reviewAction('calendar');
    await actionField('calendar', 'Action start', '2026-10-13T10:00');
    await actionField('calendar', 'Action end', '2026-10-13T10:30');
    await confirmAction('calendar');
    const eventCall = await evaluate("window.fixtureCalls.find(c => c.path.endsWith('/actions/calendar-action'))");
    assert.equal(eventCall.body.providerRevision, 'fixture-google-target');
    assert.deepEqual(eventCall.body.recipients, ['john@example.com']);
    assert(Number.isFinite(Date.parse(eventCall.body.start))); assert(eventCall.body.confirmed);
    assert.equal(eventCall.body.start, new Date('2026-10-13T10:00').toISOString());
    assert.equal(eventCall.body.end, new Date('2026-10-13T10:30').toISOString());
    await evaluate('window.fixtureActionUnknown = true');
    await reviewAction('jira');
    assert(await evaluate("document.querySelector('.ks-action[data-action-kind=jira]').textContent.includes('example.atlassian.net') && document.querySelector('.ks-action[data-action-kind=jira]').textContent.includes('Project: API')"), 'Jira destination is reviewed');
    await confirmAction('jira', 'unknown');
    assert(await evaluate("!document.querySelector('.ks-action[data-action-kind=jira] > .ks-button')"), 'unknown provider outcome cannot be resent');
    assert(await evaluate("window.fixtureMeeting.metadata.postMeetingActions.items.filter(r => r.result?.draft).every(r => r.result.sent === false)"));
    for (const theme of ['dark', 'light']) {
        await evaluate(`window.fixtureSetTheme(${JSON.stringify(theme)})`);
        await capture(`05-actions-${theme}`);
        assert(await evaluate("document.querySelector('.ks-actions').scrollWidth <= document.querySelector('.ks-actions').clientWidth"), 'actions fit the panel');
    }
    await evaluate("document.querySelector('.ks-action[data-action-kind=commitment] > .ks-text-button').click()");
    await settle();
    assert.equal(await evaluate('window.fixtureSourceTarget.preferTranscript'), true);
    await click('Actions');
    await waitFor("document.querySelectorAll('.ks-action[data-action-status=succeeded]').length === 5 && [...document.querySelectorAll('.ks-share-option small')].every(node => node.textContent.includes('Shared'))", 'actions and summary receipts persist when reopened');
    await evaluate('window.fixtureActionSourceChanged = true');
    await click('Refresh actions');
    await waitFor("document.querySelector('.ks-action[data-action-kind=commitment]').textContent.includes('sources changed')", 'old action source is labelled historical');
    assert(await evaluate("!document.querySelector('.ks-action[data-action-kind=commitment] blockquote') && !document.querySelector('.ks-action[data-action-kind=commitment] > .ks-text-button')"), 'stale confirmed excerpts do not become current evidence');
    await evaluate('window.fixtureActionSourceChanged = false');

    await click('Summary');
    await click('Edit summary & follow-up email');
    await waitFor("document.querySelectorAll('.ks-notes [role=tab]').length === 4", 'the notes editor opens');
    assert.deepEqual(
        await evaluate("[...document.querySelectorAll('.ks-notes [role=tab]')].map(tab => tab.id)"),
        ['notes-tab-summary', 'notes-tab-decisions', 'notes-tab-actions', 'notes-tab-email'],
        'the notes editor lists its four sections'
    );
    await capture('05-notes-editor');
    await click('Back to brief');
    await evaluate("document.querySelector('.ks-meeting-actions button:last-child').click()");
    await settle();
    for (const theme of ['light', 'dark']) {
        await evaluate(`window.fixtureSetTheme(${JSON.stringify(theme)})`);
        await capture(`05-summary-${theme}`);
    }
    await evaluate("document.querySelector('.ks-meeting-actions button:last-child').click()");
    await settle();
    assert(
        await evaluate("!document.querySelector('.ks-summary-recording') && !document.querySelector('.ks-detail-scroll :is(video, audio)')"),
        'the summary stays text-only and leaves playback to the Recording tab'
    );
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
    await click('Ask Kesami');
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
    await evaluate("document.querySelector('.ks-chat-sources').open = true");
    assert(await evaluate("document.querySelector('.ks-chat-source-meta').textContent.includes(String(new Date().getFullYear()))"), 'source card includes the meeting date');
    assert(await evaluate("document.querySelector('.ks-chat-source q').textContent.length > 0"), 'source card includes its supporting excerpt');
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
    await evaluate("document.querySelector('[aria-label=\"Conversation history\"]').click()");
    await settle();
    assert(await evaluate("document.querySelector('.ks-chat-threads [aria-current=\"true\"]')?.textContent.includes('Roadmap decisions')"), 'history marks the open conversation');
    assert(await evaluate("document.activeElement === document.querySelector('.ks-chat-threads [aria-current=\"true\"]')"), 'history moves focus to the open conversation');
    assert.equal(await evaluate("document.querySelector('[aria-label=\"Meeting question\"]')"), null, 'history takes the composer’s place');
    await capture('07-ask-ai-history');
    await evaluate("document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
    await settle();
    assert(await evaluate("document.activeElement === document.querySelector('[aria-label=\"Conversation history\"]')"), 'Escape closes history and returns focus to its button');
    assert.equal(await evaluate("document.querySelectorAll('.ks-chat-response-actions').length"), 2, 'closing history keeps the conversation');
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
            '.ks-meeting-panel li[data-turn-id] button.ks-speaker-name',
            '.ks-meeting-panel li[data-turn-id] > div:first-child',
            '.ks-meeting-tabs > button[aria-selected="true"]',
            '.ks-sidebar-nav button',
        ]);
        for (const { selector, ratio } of live) {
            assert(ratio !== null, `${theme}: ${selector} is rendered`);
            assert(ratio >= 4.5, `${theme}: ${selector} contrast ${ratio} must reach 4.5:1`);
        }
        assert(await evaluate("document.querySelectorAll('.ks-transcribing-wave i, .ks-transcribing-wave-small i, .ks-balls i').length >= 3"), `${theme}: the listening indicator is animated`);
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
        assert.equal(await evaluate("document.querySelectorAll('.ks-plan-card').length"), 3);
        assert(await evaluate("[...document.querySelectorAll('.ks-plan-card button')].find(b => b.textContent.includes('Not available')).disabled"), 'Pro cannot be bought while billing is off');
        assert(await evaluate("[...document.querySelectorAll('.ks-plan-card button')].find(b => b.textContent.includes('Current plan')).disabled"), 'the current plan is marked, not offered');
        assert(await evaluate("document.body.textContent.includes('COMING LATER') && !/contact sales/i.test(document.body.textContent)"), 'Enterprise does not promise a contact path');
        await capture(`13-pricing-${theme}`);
        if (theme === 'dark') await captureResponsive('pricing', '.ks-account');
        window.setContentSize(794, 1000);
        await settle();
        assert(await evaluate('document.documentElement.scrollWidth <= innerWidth'));
        await capture(`14-pricing-narrow-${theme}`);
        window.setContentSize(1280, 824);
        await click('Home');
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
    await evaluate("window.fixtureCloud = true; window.kesamiGoogleSignIn = { start: async () => ({ code: 'fixture-code', verifier: 'v'.repeat(64) }) }; window.fixtureSignOut()");
    await waitFor("[...document.querySelectorAll('button')].some(b => b.textContent.includes('Continue with Google'))", 'cloud sign-in offers Google');
    assert(await evaluate("!document.querySelector('input[type=password]') && !document.body.textContent.includes('Connection & preferences')"), 'cloud sign-in hides password and local entry');
    await capture('16-sign-in-cloud');
    // Configuration failures stay on the Google-only screen and can recover without a reload.
    await evaluate("window.fixtureGoogleConfigured = false; window.fixtureEnterWorkspace()");
    await settle();
    await evaluate('window.fixtureSignOut()');
    await waitFor("document.body.textContent.includes('isn’t configured')", 'missing Google configuration is explained');
    assert(await evaluate("document.querySelector('.ks-welcome-primary').disabled && !document.querySelector('.ks-welcome input')"));
    await capture('16-sign-in-unconfigured');
    await evaluate('window.fixtureGoogleConfigured = true');
    await click('Check again');
    await waitFor("document.querySelector('.ks-welcome-primary') && !document.querySelector('.ks-welcome-primary').disabled", 'configuration recheck enables Google');
    await evaluate("window.fixtureAuthOffline = true; window.fixtureEnterWorkspace()");
    await settle();
    await evaluate('window.fixtureSignOut()');
    await waitFor("document.body.textContent.includes('isn’t responding yet')", 'offline engine offers retry without credentials');
    await evaluate('window.fixtureAuthOffline = false');
    await click('Try again now');
    await waitFor("document.querySelector('.ks-welcome-primary') && !document.querySelector('.ks-welcome-primary').disabled", 'offline recovery restores Google sign-in');
    await click('Continue with Google');
    await waitFor('window.fixtureAuthenticated?.authProvider === "google"', 'Google sign-in reaches the workspace');
    assert(await evaluate("window.fixtureCalls.some(call => call.path === '/api/auth/supabase/google' && call.body?.code === 'fixture-code')"));
    await evaluate("delete window.kesamiGoogleSignIn; window.fixtureCloud = false");
    await evaluate("sessionStorage.clear(); localStorage.clear()");
    assert.deepEqual(errors, []);
    // Smoke-test the actual production entry as well, with backend requests blocked.
    await window.loadFile(path.join(UI_DIST, 'index.html'));
    await evaluate('document.fonts.ready');
    await waitFor("document.body.textContent.includes('isn’t responding yet')", 'an unreachable engine is explained on the sign-in screen');
    assert(await evaluate("[...document.querySelectorAll('button')].some(b => b.textContent.includes('Try again now'))"));
    await capture('09-production-sign-in');
    if (!process.argv.includes('--workspace-only')) {
        await evaluate("localStorage.setItem('kesami.local-mode', 'true')");
        await window.reload();
        await waitFor("document.querySelector('.ks-workspace')", 'remembered local access opens the workspace');
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
        for (const width of [320, 375, 414, 768]) {
            window.setContentSize(width, 900);
            await settle();
            assert(await evaluate("(() => { const dialog = document.querySelector('.ks-settings-dialog'); return dialog.scrollWidth <= dialog.clientWidth && dialog.getBoundingClientRect().right <= innerWidth; })()"), `settings fits ${width}px`);
            await capture(`rounded-settings-${width}`);
        }
        assert(!errors.some(message => /ReferenceError|TypeError|Minified React error/.test(message)));
    }
    console.log(
        `PASS: ${process.argv.includes('--workspace-only') ? 'workspace-only (initial Google interaction checks excluded), dashboard layout and search,' : 'Google-only sign-in, cancellation/retry, duplicate-click protection, legacy local-session compatibility,'} cloud Google-only sign-in, missing configuration and offline recovery, speaker editor with recommendations, Free/Pro/Enterprise pricing in both themes, password rotation UI, folder filtering, live transcript and tab narrowing, dark+light contrast (AA), meeting tabs, commitment detection/review/errors/sources in both themes, post-meeting action types/confirmation/drafts/permissions/retries/source jumps, task completion, recording stop, replay zoom/bookmark, AI citations/copy/follow-ups, responsive overflow. Screenshots: ${output}`
    );
    window.destroy();
    app.quit();
}
run().catch(error => {
    console.error(error);
    app.exit(1);
});
