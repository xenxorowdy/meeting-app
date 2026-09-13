export const FOLDER_COLORS = ['var(--ks-speaker-1)', 'var(--ks-speaker-2)', 'var(--ks-speaker-3)', 'var(--ks-speaker-4)', 'var(--ks-speaker-5)'];

export function speakerColor(name = '') {
    const hash = [...name].reduce((sum, char) => sum + char.charCodeAt(0), 0);
    return FOLDER_COLORS[hash % FOLDER_COLORS.length];
}

export function dateLabel(value) {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return '';
    const now = new Date();
    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    const day =
        date.toDateString() === now.toDateString()
            ? 'Today'
            : date.toDateString() === yesterday.toDateString()
              ? 'Yesterday'
              : date.toLocaleDateString([], { month: 'short', day: 'numeric' });
    return `${day}, ${date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
}

export function durationLabel(seconds = 0) {
    const minutes = Math.max(0, Math.round(seconds / 60));
    return minutes >= 60 ? `${Math.floor(minutes / 60)}h${minutes % 60 ? ` ${minutes % 60} min` : ''}` : `${minutes} min`;
}

export function taskValue(item) {
    return typeof item === 'string' ? { task: item, completed: false, owner: 'You' } : item;
}

export function leadParagraph(markdown = '') {
    const headingIndex = markdown.search(/\n#{1,6}\s/);
    return (headingIndex === -1 ? markdown : markdown.slice(0, headingIndex)).trim();
}

export function turnIndex(transcript) {
    return new Map((transcript || []).map(turn => [turn.id, turn]));
}

export function turnsForIds(index, ids) {
    if (!ids?.length) return [];
    const found = [];
    for (const id of ids) {
        const turn = index.get(id);
        if (turn) found.push(turn);
    }
    return found;
}
