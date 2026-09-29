(() => {
    const names = globalThis.KesamiNames;
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
            if (mine) {
                const label = mine.querySelector('[class*="display-name"]');
                const text = label ? label.textContent || '' : mine.textContent || '';
                if (text) return text;
            }
            const selfTile = document.querySelector('[aria-label*="(me)" i], [aria-label*="(you)" i], [class*="self-view"] [class*="name"]');
            if (selfTile) {
                return selfTile.getAttribute('aria-label') || selfTile.textContent || '';
            }
            return '';
        },
        micMuted() {
            // The footer control reads "Unmute" while muted and "Mute" while
            // live, so the unmute form is checked first.
            const button = document.querySelector(
                'button[aria-label*="microphone" i], button[aria-label*="mute" i], [class*="footer"] button[aria-label*="audio" i], [class*="audio-option"] button'
            );
            if (!button) return null;
            const label = (button.getAttribute('aria-label') || '').toLowerCase();
            if (/unmute/.test(label)) return true;
            if (/\bmute\b/.test(label)) return false;
            if (button.classList.contains('is-muted')) return true;
            return null;
        },
        ended() {
            // While the in-call surface is present the meeting is running; the
            // text scan only runs on post-leave and landing screens.
            const inCall = document.querySelector('[class*="video-avatar"], [class*="participants-item"], [class*="footer__leave-btn"], button[aria-label*="leave" i]');
            if (inCall) return null;
            const text = (document.body && document.body.innerText || '').slice(0, 4000);
            if (/this meeting has ended|the host has ended the meeting|you (have |'ve )?left the meeting|meeting has ended/i.test(text)) return 'ended';
            return 'left';
        },
    };

    names.start(profile);
})();
