// Facts the page states about the product. Each one is copied from the source of truth named beside it, so
// check there before changing a number here — the page must never promise more than the app does.

// Releases are published by .github/workflows/release.yml to the kesami-releases repository.
export const LATEST_URL = 'https://github.com/xenxorowdy/kesami-releases/releases/latest';
export const RELEASES_URL = 'https://github.com/xenxorowdy/kesami-releases/releases';

// Every "Get Kesami" button lands on the download choice in the closing section, so a visitor picks
// their platform once instead of the page guessing it.
export const GET_URL = '/#download';

export const CONTACT = {
    email: 'riyam.jain.3@gmail.com',
    phone: { href: 'tel:+919799434838', label: '+91 97994 34838' },
};

// apps/desktop/package.json → build.mac (arm64 only, minimumSystemVersion 13.0) and build.win (NSIS, x64).
// Both installers have fixed names (dmg.artifactName and nsis.artifactName), so GitHub's latest/download
// path serves the file itself instead of the release page.
export const PLATFORMS = {
    mac: {
        name: 'macOS',
        href: `${LATEST_URL}/download/Kesami-arm64.dmg`,
        action: 'Download for macOS',
        requires: 'macOS 13 or later · Apple silicon',
        file: '.dmg disk image',
    },
    windows: {
        name: 'Windows',
        href: `${LATEST_URL}/download/Kesami-Setup-x64.exe`,
        action: 'Download for Windows',
        requires: 'Windows 10 or 11 · 64-bit',
        file: '.exe installer',
    },
} as const;

export const PLATFORM_NOTE = 'Available for macOS and Windows';

// apps/core-backend/src/plans.rs. Pro's "Priority email support" is left out on purpose: there is no
// support address yet, and the page must not promise one.
export const PLANS = {
    free: {
        name: 'Free',
        features: [
            '2 hours of meeting recording a month',
            '3 AI summaries or chat replies a month',
            'Keep and export your meeting library',
            'Search and transcripts on your computer',
        ],
    },
    pro: {
        name: 'Pro',
        usd: 10,
        inr: 499,
        features: ['Unlimited meeting recording', 'AI briefs with decisions and next steps', 'Ask Kesami across every meeting'],
    },
    enterprise: {
        name: 'Enterprise',
        features: ['Volume and multi-workspace licensing', 'Custom contracts, invoicing and procurement', 'Deployment and integration support'],
    },
} as const;

// apps/ui/src/components/SettingsModal.jsx → SARVAM_LANGUAGES ("Detect automatically" plus these), written
// in each language's own script and tagged so browsers pick the right font and direction.
export const LANGUAGES = [
    { native: 'English', name: 'English', lang: 'en' },
    { native: 'हिन्दी', name: 'Hindi', lang: 'hi' },
    { native: 'বাংলা', name: 'Bengali', lang: 'bn' },
    { native: 'ગુજરાતી', name: 'Gujarati', lang: 'gu' },
    { native: 'ಕನ್ನಡ', name: 'Kannada', lang: 'kn' },
    { native: 'മലയാളം', name: 'Malayalam', lang: 'ml' },
    { native: 'मराठी', name: 'Marathi', lang: 'mr' },
    { native: 'ਪੰਜਾਬੀ', name: 'Punjabi', lang: 'pa' },
    { native: 'தமிழ்', name: 'Tamil', lang: 'ta' },
    { native: 'తెలుగు', name: 'Telugu', lang: 'te' },
    { native: 'اردو', name: 'Urdu', lang: 'ur' },
] as const;
