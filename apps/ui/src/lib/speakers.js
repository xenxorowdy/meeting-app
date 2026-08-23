// Shared by the live transcript and the replay player so a speaker keeps the same
// colour and initials in both. When these lived privately in TranscriptView the
// player had to reimplement them, and the two drifted.

const SPEAKER_PALETTE = ['bg-speaker-1', 'bg-speaker-2', 'bg-speaker-3', 'bg-speaker-4'];

/** Format a millisecond offset as MM:SS, or HH:MM:SS past an hour. */
export function formatMs(ms = 0) {
    const totalSeconds = Math.max(0, Math.floor(ms / 1000));
    const seconds = totalSeconds % 60;
    const minutes = Math.floor(totalSeconds / 60) % 60;
    const hours = Math.floor(totalSeconds / 3600);
    const pad = value => value.toString().padStart(2, '0');
    return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`;
}

/** Deterministic colour per speaker, with the local user always on the accent. */
export function getSpeakerStyle(speaker = '') {
    if (speaker === 'You' || speaker.toLowerCase().startsWith('you')) {
        return { avatar: 'bg-primary text-primary-foreground', bar: 'bg-primary', isYou: true };
    }

    const hash = speaker.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
    const fill = SPEAKER_PALETTE[hash % SPEAKER_PALETTE.length];
    return { avatar: `${fill} text-background`, bar: fill, isYou: false };
}

export function initialsFor(speaker = '') {
    const words = speaker
        .replace(/\(.*?\)/g, '')
        .trim()
        .split(/\s+/)
        .filter(Boolean);
    if (words.length === 0) return 'S';
    if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
    return (words[0][0] + words[1][0]).toUpperCase();
}

// Whisper reports ISO 639-1; only the languages the app offers need a name, and
// anything else falls back to the code itself rather than showing nothing.
const LANGUAGE_NAMES = {
    en: 'English',
    hi: 'Hindi',
    mr: 'Marathi',
    bn: 'Bengali',
    gu: 'Gujarati',
    pa: 'Punjabi',
    ta: 'Tamil',
    te: 'Telugu',
    kn: 'Kannada',
    ml: 'Malayalam',
    ur: 'Urdu',
    es: 'Spanish',
    fr: 'French',
    de: 'German',
    pt: 'Portuguese',
    ja: 'Japanese',
    ko: 'Korean',
    zh: 'Chinese',
};

export function languageName(code) {
    if (!code) return null;
    return LANGUAGE_NAMES[code] || code.toUpperCase();
}
