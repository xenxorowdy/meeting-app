// Isolated Electron UI verification. No payment provider or user data is accessed.
const { app, BrowserWindow } = require('electron');
const { build } = require('esbuild');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
if (process.argv.includes('--inspect-payment')) app.commandLine.appendSwitch('remote-debugging-port', '9228');

async function run() {
    const output = await fs.mkdtemp(path.join(os.tmpdir(), 'kesami-payment-ui-'));
    app.setPath('userData', path.join(output, 'profile'));
    await fs.mkdir(path.join(output, 'profile'));
    await build({ entryPoints: [path.join(__dirname, 'fixture.jsx')], bundle: true, outdir: output, format: 'iife',
        loader: { '.woff2': 'file' }, alias: { '@': path.resolve(__dirname, '../../apps/ui/src') },
        define: { 'process.env.NODE_ENV': '"development"', 'import.meta.env': '{}' } });
    const assets = path.resolve(__dirname, '../../apps/ui/dist/assets');
    const css = (await fs.readdir(assets)).find(name => /^index-.*\.css$/.test(name));
    assert(css, 'Build the UI before the payment UI check');
    await fs.writeFile(path.join(output, 'index.html'), `<html><head><link rel="stylesheet" href="file://${assets}/${css}"><link rel="stylesheet" href="fixture.css"></head><body><div id="root"></div><script src="fixture.js"></script></body></html>`);
    await app.whenReady();
    const window = new BrowserWindow({ show: process.argv.includes('--inspect-payment'), width: 1280, height: 850, webPreferences: { contextIsolation: true, nodeIntegration: false } });
    const errors = [];
    window.webContents.on('console-message', ({ level, message }) => { if (level === 'error') errors.push(message); });
    await window.loadFile(path.join(output, 'index.html'));
    const evaluate = code => window.webContents.executeJavaScript(code);
    const wait = code => evaluate(`new Promise((resolve,reject)=>{const start=Date.now();const timer=setInterval(()=>{if(${code}){clearInterval(timer);resolve()}else if(Date.now()-start>5000){clearInterval(timer);reject(new Error('Payment UI timed out'))}},20)})`);
    const clickSubscribe = () => evaluate("[...document.querySelectorAll('button')].find(button=>button.textContent==='Subscribe with Razorpay').click()");
    await wait("document.querySelector('.ks-plan-card')");
    await clickSubscribe();
    await wait('window.paymentFixture.state.opened===1');
    await evaluate('window.paymentFixture.authorize()');
    await wait("document.querySelector('[data-testid=current-plan]').textContent==='Pro Plan'");
    assert(await evaluate("[...document.querySelectorAll('.ks-plan-card')].find(card=>card.textContent.includes('Pro')).textContent.includes('Current plan')"));
    assert(await evaluate("window.paymentFixture.state.calls.some(call=>call.path==='/api/billing/razorpay/confirm'&&call.body.signature==='fixture-proof')"));
    await fs.writeFile(path.join(output, 'pro-active.png'), (await window.webContents.capturePage()).toPNG());
    await evaluate('window.paymentFixture.billing()');
    await wait("document.querySelector('.ks-plan-summary')");
    assert(await evaluate("document.body.textContent.includes('₹499 / month')"));
    assert(await evaluate("!document.body.textContent.includes('Upgrade to Pro')"));
    await evaluate("window.paymentFixture.reset('confirmation-error')");
    await wait("document.querySelector('.ks-plan-card')");
    await clickSubscribe(); await wait('window.paymentFixture.state.opened===1');
    await evaluate('window.paymentFixture.authorize()');
    await wait("document.querySelector('[role=alert]')");
    assert(await evaluate("document.body.textContent.includes('Check payment status')"));
    await evaluate("[...document.querySelectorAll('button')].find(button=>button.textContent==='Check payment status').click()");
    await wait("document.querySelector('[data-testid=current-plan]').textContent==='Pro Plan'");
    assert.equal(await evaluate("window.paymentFixture.state.calls.filter(call=>call.path==='/api/billing/checkout').length"), 1);
    await evaluate('window.paymentFixture.reset()'); await wait("document.querySelector('.ks-plan-card')");
    await clickSubscribe(); await wait('window.paymentFixture.state.opened===1');
    await evaluate('window.paymentFixture.fail()'); await wait("document.querySelector('[role=alert]')");
    await evaluate('window.paymentFixture.dismiss()');
    await wait("[...document.querySelectorAll('button')].some(button=>button.textContent==='Subscribe with Razorpay'&&!button.disabled)");
    await evaluate("window.paymentFixture.reset('success',false)");
    await wait("document.body.textContent.includes('Sign in to subscribe')");
    await evaluate("[...document.querySelectorAll('button')].find(button=>button.textContent==='Sign in to subscribe').click()");
    assert(await evaluate('window.paymentFixture.state.signInRequested'));
    assert.equal(await evaluate('window.paymentFixture.state.opened'), 0);
    assert.deepEqual(errors, []);
    console.log(`PASS: Electron payment UI: signed confirmation, Pro plan refresh, billing view, safe retry, failure, dismissal, sign-in gate. Screenshots: ${output}`);
    if (!process.argv.includes('--inspect-payment')) app.quit();
}
run().catch(error => { console.error(error); app.exit(1); });
