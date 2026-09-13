(() => {
    const names = globalThis.AlphaNames;
    if (!names) return;

    const profile = {
        source: 'zoom',
        tiles: [
            '.participants-item__item-view',
            '.participants-li',
            '[class*="participants-item"]',
            '[class*="video-avatar__avatar"]',
            '[class*="speaker-bar-container__video-frame"]',
            '[class*="gallery-video-container__video-frame"]',
        ],
        name: [
            '.participants-item__display-name',
            '[class*="participants-item__display-name"]',
            '[class*="video-avatar__avatar-name"]',
            '[class*="display-name"]',
            '.video-avatar__avatar-title',
        ],
        speaking: [
            '[class*="audio-status"] [class*="speak"]',
            '[class*="participants-item__audio-status"][class*="speak"]',
            '[class*="speaker-active"]',
            '[class*="video-avatar__avatar--active"]',
            '[class*="avatar__border--active"]',
            '[aria-label*="is speaking" i]',
        ],
        self() {
            const items = Array.from(document.querySelectorAll('[class*="participants-item"]'));
            const mine = items.find(item => /\((me|host, me|co-host, me)\)/i.test(item.textContent || ''));
            if (!mine) return '';
            const label = mine.querySelector('[class*="display-name"]');
            return label ? label.textContent || '' : '';
        },
    };

    names.start(profile);
})();
