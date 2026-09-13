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
        ],
        self() {
            const label = document.querySelector('[data-self-name]');
            return label ? label.getAttribute('data-self-name') || label.textContent || '' : '';
        },
    };

    names.start(profile);
})();
