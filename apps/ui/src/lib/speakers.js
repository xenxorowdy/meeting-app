// Shared by the live transcript and the replay player so a speaker keeps the same
// colour and initials in both. When these lived privately in TranscriptView the
// player had to reimplement them, and the two drifted.

import { attendeeNames } from './calendarEvents.js';

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

// Older transcripts report ISO 639-1; only the languages the app offers need a name, and
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

const MATCH_SLACK_MS = 800;
const MAX_SUGGESTIONS = 8;
const RECOMMEND_SHARE = 0.5;

export function isGenericSpeaker(name = '') {
    return /^(speaker( \d+)?|others?|unknown)$/i.test(String(name).trim());
}

function spokenMs(turn) {
    return Math.max(0, (turn.endMs ?? turn.startMs ?? 0) - (turn.startMs ?? 0));
}

export function speakerSuggestions({ turns = [], metadata = {}, roster = [], speaker = '', turnId = null } = {}) {
    const selfName = String(metadata?.participantSelf || '').trim();
    const target = turnId ? turns.filter(turn => turn.id === turnId) : turns.filter(turn => turn.speaker === speaker);
    const current = turnId ? target[0]?.speaker || '' : speaker;
    const seen = new Set([current.trim().toLowerCase()]);
    const suggestions = [];
    const display = raw => {
        const trimmed = String(raw ?? '').trim();
        return selfName && trimmed === selfName ? 'You' : trimmed;
    };
    const add = (raw, source, share = null) => {
        const name = display(raw);
        const key = name.toLowerCase();
        if (!name || name.length > 80 || seen.has(key) || isGenericSpeaker(name)) return;
        seen.add(key);
        suggestions.push({ name, source, share });
    };

    const spoken = target.reduce((total, turn) => total + spokenMs(turn), 0);
    const activity = Array.isArray(metadata?.speakingActivity) ? metadata.speakingActivity : [];
    let evidence = [];
    if (spoken > 0) {
        const overlaps = new Map();
        for (const span of activity) {
            if (!span?.name || !Number.isFinite(span.startMs) || !Number.isFinite(span.endMs)) continue;
            let overlap = 0;
            for (const turn of target) {
                const start = Math.max(turn.startMs ?? 0, span.startMs - MATCH_SLACK_MS);
                const end = Math.min(turn.endMs ?? turn.startMs ?? 0, span.endMs + MATCH_SLACK_MS);
                overlap += Math.max(0, end - start);
            }
            if (overlap > 0) overlaps.set(span.name, (overlaps.get(span.name) || 0) + overlap);
        }
        evidence = [...overlaps]
            .map(([name, overlap]) => [name, Math.min(1, overlap / spoken)])
            .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
        evidence.forEach(([name, share]) => add(name, 'activity', share));
    }
    const inCall = [...(Array.isArray(metadata?.participants) ? metadata.participants : []), ...(Array.isArray(roster) ? roster : [])];
    inCall.forEach(name => add(name, 'call'));
    attendeeNames(metadata?.calendarEvent).forEach(name => add(name, 'invite'));
    turns.forEach(turn => add(turn.speaker, 'transcript'));

    const ranked = suggestions.slice(0, MAX_SUGGESTIONS);
    const [leader, runnerUp] = evidence;
    const leaderName = leader ? display(leader[0]) : '';
    if (leader && leaderName !== current && leader[1] >= RECOMMEND_SHARE && !(runnerUp && runnerUp[1] > leader[1] * RECOMMEND_SHARE)) {
        const recommended = ranked.find(suggestion => suggestion.name === leaderName);
        if (recommended) recommended.recommended = true;
    }
    return ranked;
}

export function suggestionReason(suggestion, single = false) {
    if (suggestion?.source === 'activity') {
        const share = Math.max(1, Math.round((suggestion.share || 0) * 100));
        return single ? `Talking during ${share}% of this line` : `Talking during ${share}% of these lines`;
    }
    if (suggestion?.source === 'call') return 'In the call';
    if (suggestion?.source === 'invite') return 'Invited';
    if (suggestion?.source === 'transcript') return 'Already in this transcript';
    return '';
}
