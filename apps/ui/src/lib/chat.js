// Pure helpers shared by the chat hook and focused tests.
export function scopeKey(scope) {
    if (scope.type === 'meetings') return JSON.stringify({ ...scope, meetingIds: [...scope.meetingIds].sort() });
    return JSON.stringify(scope);
}

export function memoryScope(base, filters) {
    const scope = { ...base };
    const name = filters.name?.trim();
    if (name) scope.entity = { kind: filters.kind || 'person', name };
    if (filters.from) scope.fromMs = new Date(`${filters.from}T00:00:00`).getTime();
    if (filters.to) scope.toMs = new Date(`${filters.to}T23:59:59.999`).getTime();
    if ([scope.fromMs, scope.toMs].some(value => value !== undefined && !Number.isFinite(value))) throw new Error('Choose valid dates.');
    if (scope.fromMs !== undefined && scope.toMs !== undefined && scope.fromMs > scope.toMs) throw new Error('Start date must precede end date.');
    return scope;
}

export function citationDate(milliseconds) {
    return Number.isFinite(milliseconds) ? new Date(milliseconds).toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' }) : '';
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
    const sources = citations.map(citation => `• ${citation.title || 'Meeting'}${citationDate(citation.startedAt) ? ` · ${citationDate(citation.startedAt)}` : ''}${Number.isFinite(citation.startMs) ? ` · ${citationTime(citation.startMs)}` : ''}${citation.available === false ? ' (unavailable)' : ''}`);
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
