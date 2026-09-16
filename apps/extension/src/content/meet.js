(() => {
    const names = globalThis.AlphaNames;
    if (!names) return;

    const profile = {
        source: 'google-meet',
        tiles: ['[data-participant-id]', '[data-requested-participant-id]', '[role="listitem"][data-participant-id]'],
        name: ['[data-self-name]', '[data-participant-name]', '.notranslate', '.zWGUib', '.dwSJ2e', '.XWGOtd'],
        speaking: [
            '[data-is-speaking="true"]',
            '[aria-label*="is speaking" i]',
            '[aria-label*="speaking" i]:not([aria-label*="not speaking" i])',
            '.IisKdb',
            '[class*="IisKdb"]',
            '[jsname="dm1LIe"]',
            '.VfPpkd-A98nJf-xl07Ob',
            '[class*="speaking"]',
        ],
        self() {
            const label = document.querySelector('[data-self-name]');
            return label ? label.getAttribute('data-self-name') || label.textContent || '' : '';
        },
        micMuted() {
            // The toolbar control flips its accessible name between "turn off"
            // while live and "turn on" while muted; the verbs are checked in
            // that order so a partial match cannot read as the wrong state.
            const button = document.querySelector('button[aria-label*="microphone" i], button[aria-label*="mic" i]');
            if (button) {
                const label = (button.getAttribute('aria-label') || '').toLowerCase();
                if (/turn on|unmute/.test(label)) return true;
                if (/turn off|mute/.test(label)) return false;
                if (button.getAttribute('data-is-muted') === 'true') return true;
                if (button.getAttribute('data-is-muted') === 'false') return false;
                if (button.hasAttribute('aria-pressed')) return button.getAttribute('aria-pressed') === 'true';
            }
            const muted = document.querySelector('[data-is-muted="true"][aria-label*="mic" i], [data-is-muted="true"]');
            if (muted) return true;
            return null;
        },
        ended() {
            // While the in-call surface is present the meeting is running; the
            // text scan only runs on post-leave and landing screens.
            const inCall = document.querySelector('[data-self-name], [data-participant-id], [data-requested-participant-id], button[aria-label*="leave call" i]');
            if (inCall) return null;
            const text = (document.body && document.body.innerText || '').slice(0, 4000);
            if (/you (have |'ve )?left the meeting|call has ended|this call has ended|return to home screen|rejoin/i.test(text)) return 'ended';
            return 'left';
        },
    };

    names.start(profile);
})();
