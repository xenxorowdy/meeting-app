// Pure helpers shared by the chat hook and focused tests.
export function scopeKey(scope) {
    if (scope.type === 'meetings') return JSON.stringify({ ...scope, meetingIds: [...scope.meetingIds].sort() });
    return JSON.stringify(scope);
}

export function citationTime(milliseconds) {
    if (!Number.isFinite(milliseconds)) return '';
    const seconds = Math.floor(Math.max(0, milliseconds) / 1000);
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

export function copyAnswerText(message) {
    const citations = message.citations || [];
    const known = new Set(citations.map(citation => String(citation.number)));
    const answer = (message.content || '').replace(/`[^`]+`|[ \t]*\[(\d+)\]/g, (match, number) => known.has(number) ? '' : match);
    if (!citations.length) return answer;
    const sources = citations.map(citation => `• ${citation.title || 'Meeting'}${Number.isFinite(citation.startMs) ? ` · ${citationTime(citation.startMs)}` : ''}${citation.available === false ? ' (unavailable)' : ''}`);
    return `${answer}\n\nSources\n${sources.join('\n')}`;
}

export function citationTarget(citation, meeting) {
    if (!meeting || meeting.id !== citation.meetingId || citation.available === false) return null;
    const ids = new Set(citation.turnIds || []);
    const turn = meeting.transcript?.find(turn => ids.has(turn.id));
    if (ids.size && !turn) return null;
    return { meetingId: meeting.id, turnIds: [...ids], startMs: turn?.startMs ?? citation.startMs ?? null, chunkId: citation.chunkId };
}

export function mergeMessages(current, incoming) {
    const known = new Set(current.map(message => `${message.requestId}:${message.role}`));
    return [...current, ...incoming.filter(message => !known.has(`${message.requestId}:${message.role}`))];
}
