const RELEASES_URL = 'https://github.com/xenxorowdy/kesami-releases/releases';
const FIRST_CHECK_DELAY_MS = 15_000;
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

let updater = null;
let electron = null;
let currentPlatform = process.platform;
let windowFor = () => null;
let firstCheckTimer = null;
let intervalTimer = null;
let manualCheck = false;
let promptedVersion = null;
let downloadedVersion = null;
let prompting = false;

function installsInPlace() {
    return currentPlatform === 'win32';
}

function downloadUrl(info) {
    const dmg = info?.files?.find(file => typeof file?.url === 'string' && file.url.endsWith('.dmg'));
    if (!info?.version) return RELEASES_URL;
    if (!dmg) return `${RELEASES_URL}/tag/v${info.version}`;
    return `${RELEASES_URL}/download/v${info.version}/${encodeURIComponent(dmg.url)}`;
}

async function showMessage(options) {
    const parent = windowFor();
    const message = { noLink: true, ...options };
    return parent && !parent.isDestroyed?.() ? electron.dialog.showMessageBox(parent, message) : electron.dialog.showMessageBox(message);
}

async function offerDownload(info) {
    if (prompting) return;
    prompting = true;
    try {
        const { response } = await showMessage({
            type: 'info',
            buttons: ['Download', 'Later'],
            defaultId: 0,
            cancelId: 1,
            message: `Kesami ${info.version} is available`,
            detail: `You have ${electron.app.getVersion()}. Download the new version, quit Kesami, and drag it into Applications to replace this one.`,
        });
        if (response === 0) await electron.shell.openExternal(downloadUrl(info));
    } finally {
        prompting = false;
    }
}

async function offerRestart(version) {
    if (prompting) return;
    prompting = true;
    try {
        const { response } = await showMessage({
            type: 'info',
            buttons: ['Restart Now', 'Later'],
            defaultId: 0,
            cancelId: 1,
            message: `Kesami ${version} is ready to install`,
            detail: 'Restart Kesami to finish updating. If you choose Later, the update installs the next time you quit.',
        });
        if (response === 0) updater.quitAndInstall(true, true);
    } finally {
        prompting = false;
    }
}

function onUpdateAvailable(info) {
    const manual = manualCheck;
    manualCheck = false;
    if (installsInPlace()) {
        if (manual) {
            void showMessage({
                type: 'info',
                buttons: ['OK'],
                message: `Downloading Kesami ${info.version}`,
                detail: 'You will be asked to restart when it is ready.',
            });
        }
        return;
    }
    if (!manual && promptedVersion === info.version) return;
    promptedVersion = info.version;
    void offerDownload(info);
}

function onUpdateNotAvailable() {
    if (!manualCheck) return;
    manualCheck = false;
    void showMessage({
        type: 'info',
        buttons: ['OK'],
        message: 'Kesami is up to date',
        detail: `You have the latest version, ${electron.app.getVersion()}.`,
    });
}

function onUpdateDownloaded(info) {
    downloadedVersion = info.version;
    void offerRestart(info.version);
}

function onError(cause) {
    console.error(`[Kesami] update check failed: ${cause?.message || cause}`);
    if (!manualCheck) return;
    manualCheck = false;
    void showMessage({
        type: 'warning',
        buttons: ['OK'],
        message: 'Could not check for updates',
        detail: 'Check your internet connection and try again.',
    });
}

function check() {
    if (!updater) return Promise.resolve(null);
    return updater.checkForUpdates().catch(onError);
}

function checkNow() {
    if (!updater) {
        void showMessage({ type: 'info', buttons: ['OK'], message: 'Updates are only available in installed builds of Kesami' });
        return Promise.resolve(null);
    }
    if (downloadedVersion && installsInPlace()) {
        void offerRestart(downloadedVersion);
        return Promise.resolve(null);
    }
    manualCheck = true;
    return check();
}

function start({ electronModule = require('electron'), autoUpdater, platform = process.platform, getWindow = () => null } = {}) {
    electron = electronModule;
    currentPlatform = platform;
    windowFor = getWindow;
    if (!electron.app.isPackaged || updater) return false;

    updater = autoUpdater || require('electron-updater').autoUpdater;
    updater.logger = null;
    updater.autoDownload = installsInPlace();
    updater.autoInstallOnAppQuit = installsInPlace();
    updater.on('update-available', onUpdateAvailable);
    updater.on('update-not-available', onUpdateNotAvailable);
    updater.on('update-downloaded', onUpdateDownloaded);
    updater.on('error', onError);

    firstCheckTimer = setTimeout(check, FIRST_CHECK_DELAY_MS);
    intervalTimer = setInterval(check, CHECK_INTERVAL_MS);
    firstCheckTimer.unref?.();
    intervalTimer.unref?.();
    return true;
}

function stop() {
    clearTimeout(firstCheckTimer);
    clearInterval(intervalTimer);
    firstCheckTimer = null;
    intervalTimer = null;
    updater?.off('update-available', onUpdateAvailable);
    updater?.off('update-not-available', onUpdateNotAvailable);
    updater?.off('update-downloaded', onUpdateDownloaded);
    updater?.off('error', onError);
    updater = null;
    manualCheck = false;
    promptedVersion = null;
    downloadedVersion = null;
    prompting = false;
}

module.exports = { start, stop, checkNow, _testing: { downloadUrl, RELEASES_URL, FIRST_CHECK_DELAY_MS, CHECK_INTERVAL_MS } };
