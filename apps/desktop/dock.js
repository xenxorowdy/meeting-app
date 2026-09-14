const path = require('node:path');

const DEFAULT_ICON_PATH = path.join(__dirname, 'assets', 'kesami-dock.png');

async function showDockIcon({ app, nativeImage, platform = process.platform, iconPath = DEFAULT_ICON_PATH }) {
    if (platform !== 'darwin' || !app.dock) return false;

    // A tray/floating-widget shell can be classified as an accessory app by
    // macOS. Restore regular Dock presence before applying the branded image.
    await app.dock.show();

    const icon = nativeImage.createFromPath(iconPath);
    if (icon.isEmpty()) return false;

    app.dock.setIcon(icon);
    return true;
}

module.exports = { showDockIcon, _testing: { DEFAULT_ICON_PATH } };
