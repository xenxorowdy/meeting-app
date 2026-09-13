import React, { useEffect, useId, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, ArrowUpRight, Check, Copy, FileCheck2, ListChecks, Plus, Search, Sparkles, Square, Trash2, X } from 'lucide-react';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { JumpingBalls } from '@/components/JumpingBalls';
import { MarkdownText } from '@/components/MarkdownText';
import { useMeetingChat } from '@/hooks/useMeetingChat';
import { apiRequest, normalizeMeeting } from '@/lib/backend';
import { citationTarget, citationTime, copyAnswerText, scopeKey } from '@/lib/chat';

function ResponseActions({ message, question, disabled, onFollowUp }) {
    const [copyState, setCopyState] = useState('idle');
    useEffect(() => {
        if (copyState === 'idle') return;
        const timer = setTimeout(() => setCopyState('idle'), 2500);
        return () => clearTimeout(timer);
    }, [copyState]);
    const copy = async () => {
        try {
            await navigator.clipboard.writeText(copyAnswerText(message));
            setCopyState('copied');
        } catch {
            setCopyState('failed');
        }
    };
    const context = question ? `\n\nRegarding: ${Array.from(question).slice(0, 600).join('')}` : '';
    return (
        <div className="ks-chat-response-actions">
            <button type="button" onClick={copy} className="ks-chat-copy" aria-label="Copy response">
                {copyState === 'copied' ? <Check size={13} /> : <Copy size={13} />}
                {copyState === 'copied' ? 'Copied' : 'Copy response'}
            </button>
            <span className={copyState === 'failed' ? 'ks-chat-copy-status' : 'sr-only'} role="status">
                {copyState === 'failed'
                    ? 'Couldn’t copy. Select the response to copy it manually.'
                    : copyState === 'copied'
                      ? 'Response copied.'
                      : ''}
            </span>
            <p className="ks-chat-followup-label">Explore this answer</p>
            <div className="ks-chat-followups">
                {[
                    ['Make it shorter', 'Give me a concise answer in three bullets.'],
                    ['Explain more', 'Explain the answer in more detail using the meeting evidence.'],
                    ['Next steps', 'What next steps, owners, and deadlines were discussed? Flag anything unspecified.'],
                ].map(([label, prompt]) => (
                    <button key={label} type="button" disabled={disabled} onClick={() => onFollowUp(prompt + context)}>
                        {label}
                        <ArrowUpRight size={12} />
                    </button>
                ))}
            </div>
        </div>
    );
}

function CitationCard({ citation, onOpen }) {
    return (
        <button type="button" className="ks-chat-source" disabled={citation.available === false} onClick={() => onOpen(citation)}>
            <span className="ks-chat-source-title">
                {citation.title} {citationTime(citation.startMs)}
            </span>
            <span className="ks-chat-source-meta">
                {citation.available === false
                    ? citation.unavailableReason || 'Source unavailable'
                    : `${citation.sourceKind || 'Meeting'}${citation.startedAt ? ` · ${new Date(citation.startedAt).toLocaleDateString()}` : ''}`}
            </span>
            <q>{citation.excerpt}</q>
        </button>
    );
}

export function MeetingChatPanel({ scope, scopeLabel, isConnected, onSelectMeeting, isLive = false, scopeControl = null }) {
    const chat = useMeetingChat(scope, isConnected);
    const [sourceError, setSourceError] = useState(null);
    const log = useRef(null);
    const composer = useRef(null);
    const followLatest = useRef(true);
    const previousLog = useRef({ messages: [], height: 0 });
    const [hasNewResponse, setHasNewResponse] = useState(false);
    const [confirmDelete, setConfirmDelete] = useState(false);
    const [deleting, setDeleting] = useState(false);
    const composerHintId = useId();
    const jumpToLatest = () => {
        followLatest.current = true;
        setHasNewResponse(false);
        if (log.current) log.current.scrollTop = log.current.scrollHeight;
    };
    const prepareQuestion = question => {
        chat.setQuestion(question);
        composer.current?.focus();
    };
    const actionsDisabled = !isConnected || chat.busy || chat.loading;
    useEffect(() => {
        const element = log.current;
        if (!element) return;
        const previous = previousLog.current;
        const prepended = previous.messages.length > 0 && chat.messages.length > previous.messages.length &&
            chat.messages.at(-1) === previous.messages.at(-1) && chat.messages[0] !== previous.messages[0];
        if (prepended) element.scrollTop += element.scrollHeight - previous.height;
        else if (followLatest.current || chat.busy) jumpToLatest();
        else if (chat.messages.length > previous.messages.length) setHasNewResponse(true);
        previousLog.current = { messages: chat.messages, height: element.scrollHeight };
    }, [chat.messages, chat.busy]);
    useEffect(() => {
        const textarea = composer.current;
        if (!textarea) return;
        textarea.style.height = 'auto';
        textarea.style.height = `${Math.min(160, textarea.scrollHeight)}px`;
    }, [chat.question]);
    useEffect(() => {
        followLatest.current = true;
        setHasNewResponse(false);
        setSourceError(null);
        setConfirmDelete(false);
    }, [scopeKey(scope), chat.thread?.id]);
    const openSource = async citation => {
        setSourceError(null);
        try {
            const params = new URLSearchParams({ revision: citation.sourceRevision });
            const response = await apiRequest(`/api/chat/sources/${encodeURIComponent(citation.meetingId)}?${params}`);
            const meeting = normalizeMeeting(response.meeting);
            const target = citationTarget(citation, meeting);
            if (!target) throw new Error('This passage is no longer available. Ask again to use the latest meeting.');
            onSelectMeeting?.(meeting, target);
        } catch (cause) {
            setSourceError(cause.message);
        }
    };
    const matchingThreads = chat.threads.filter(thread => scopeKey(thread.scope) === scopeKey(scope));
    const singleMeeting = scope?.type === 'meetings' && scope.meetingIds?.length === 1;
    const starters = isLive
        ? [['Catch me up', 'Summarize the discussion so far', Search], ['Find decisions', 'What decisions have we made so far?', FileCheck2], ['Plan next steps', 'What next steps have been discussed?', ListChecks]]
        : [['Find decisions', 'What decisions did we make?', FileCheck2], ['Plan next steps', 'List every action item', ListChecks],
            [singleMeeting ? 'Catch me up' : 'Connect the dots', singleMeeting ? 'Summarize the key discussion points' : 'What changed between these meetings?', Search]];
    return (
        <section className="ks-chat" aria-label="Meeting AI assistant">
            <header className="ks-chat-head">
                <Sparkles className="ks-chat-head-icon" aria-hidden="true" />
                <div className="ks-chat-head-text">
                    <h2>Ask AI</h2>
                    {scopeLabel && <p title={scopeLabel}>{scopeLabel}</p>}
                </div>
                {scopeControl}
                <button type="button" className="ks-icon-button" onClick={() => { chat.newThread(); composer.current?.focus(); }} disabled={deleting} aria-label="New conversation" title="New conversation">
                    <Plus />
                </button>
                {chat.thread && (
                    <button type="button" className="ks-icon-button" onClick={() => setConfirmDelete(true)} disabled={chat.busy || deleting} aria-label="Delete conversation" title="Delete conversation">
                        <Trash2 />
                    </button>
                )}
            </header>
            {isLive && (
                <p className="ks-chat-live" role="status">
                    Answers use the transcript captured when you send your question. Ask again to include newer speech.
                </p>
            )}
            {!isConnected && <p className="ks-chat-live" role="status">Connect to your meeting service to search conversations and ask a question.</p>}
            <div ref={log} className="ks-chat-log" role="log" aria-label="Conversation messages" aria-live="polite" aria-relevant="additions" onScroll={event => {
                const element = event.currentTarget;
                followLatest.current = element.scrollHeight - element.scrollTop - element.clientHeight < 64;
                if (followLatest.current) setHasNewResponse(false);
            }}>
                {chat.before && (
                    <button type="button" className="ks-text-button" disabled={chat.loading} onClick={chat.loadEarlier}>
                        Load earlier messages
                    </button>
                )}
                {chat.loading && <p className="ks-chat-note">Loading conversation…</p>}
                {!chat.messages.length && !chat.loading && (
                    <div className="ks-chat-empty">
                        <div className="ks-chat-empty-icon"><Sparkles aria-hidden="true" /></div>
                        <span className="ks-eyebrow">A LITTLE MORE CLARITY</span>
                        <h3>{isLive ? 'Stay with the conversation.' : singleMeeting ? 'Good questions. Clear next steps.' : 'Your meetings have answers.'}</h3>
                        <p>{isLive ? 'Catch up on what was said, find a decision, or check the next steps while the meeting continues.' : 'Find the decision, the next step, or the detail you missed. Ask a question and follow the answer back to its source.'}</p>
                        <div className="ks-chat-starters">
                            {starters.map(([label, prompt, Icon]) => (
                                <button key={prompt} type="button" disabled={actionsDisabled} aria-label={prompt} onClick={() => prepareQuestion(prompt)}>
                                    <Icon aria-hidden="true" /><span><strong>{label}</strong><small>{prompt}</small></span><ArrowUpRight aria-hidden="true" />
                                </button>
                            ))}
                        </div>
                    </div>
                )}
                {chat.messages.map((message, i) => (
                    <div
                        key={`${message.requestId}-${message.role}-${i}`}
                        className={`ks-chat-row ${message.role === 'user' ? 'ks-chat-row-user' : ''}`}
                    >
                        <div className={`ks-chat-bubble ${message.role === 'user' ? 'ks-chat-user' : ''}`}>
                            {message.role !== 'user' && <span className="ks-chat-ai-label"><Sparkles aria-hidden="true" /> Kesami AI</span>}
                            <MarkdownText
                                markdown={message.content}
                                className="ks-chat-markdown"
                                citations={message.role === 'assistant' ? message.citations : []}
                                onOpenCitation={openSource}
                            />
                            {message.coverage?.eligibleMeetings > 0 && (
                                <p className="ks-chat-coverage">
                                    {message.retrievalMode === 'structured'
                                        ? `${message.coverage.shownItems} of ${message.coverage.totalItems} recorded items`
                                        : `Evidence from ${message.coverage.retrievedMeetings || 0} of ${message.coverage.eligibleMeetings} meetings`}
                                    {message.status === 'partial' ? ' · Partial coverage' : ''}
                                </p>
                            )}
                            {message.coverage?.live && (
                                <p className="ks-chat-coverage">
                                    {Number.isFinite(message.coverage.capturedThroughMs)
                                        ? `Transcript captured through ${citationTime(message.coverage.capturedThroughMs)}`
                                        : 'Based on the transcript available when asked'}
                                    {' · '}Meeting in progress when asked
                                </p>
                            )}
                            {message.coverage?.nextPage && (
                                <button
                                    type="button"
                                    className="ks-text-button"
                                    disabled={actionsDisabled}
                                    onClick={() => chat.send(`List every action item, page ${message.coverage.nextPage}`)}
                                >
                                    Next 100 action items
                                </button>
                            )}
                            {message.citations?.length > 0 && (
                                <details className="ks-chat-sources">
                                    <summary>Sources ({message.citations.length})</summary>
                                    <div>
                                        {message.citations.map(citation => (
                                            <CitationCard key={citation.number} citation={citation} onOpen={openSource} />
                                        ))}
                                    </div>
                                </details>
                            )}
                            {message.role === 'assistant' && message.content?.trim() && (
                                <ResponseActions
                                    message={message}
                                    question={chat.messages.slice(0, i).findLast(item => item.role === 'user')?.content}
                                    disabled={actionsDisabled || !!chat.question.trim()}
                                    onFollowUp={prepareQuestion}
                                />
                            )}
                        </div>
                    </div>
                ))}
                {chat.busy && (
                    <div className="ks-chat-row">
                        <div className="ks-chat-bubble ks-chat-thinking" role="status">
                            <span className="ks-chat-ai-label"><Sparkles aria-hidden="true" /> Kesami AI</span>
                            <span className="ks-chat-thinking-row">
                                <JumpingBalls />
                                Reading the passages that matter…
                            </span>
                        </div>
                    </div>
                )}
            </div>
            {hasNewResponse && <button type="button" className="ks-chat-latest" onClick={jumpToLatest}><ArrowDown aria-hidden="true" />Latest response</button>}
            {(chat.error || sourceError) && (
                <p className="ks-chat-error" role="alert">
                    {sourceError || chat.error}
                    {sourceError ? <button type="button" aria-label="Dismiss source error" onClick={() => setSourceError(null)}><X /></button> : chat.question.trim() ? (
                        <button type="button" disabled={actionsDisabled} onClick={() => chat.send()}>Try again</button>
                    ) : chat.thread ? (
                        <button type="button" disabled={actionsDisabled} onClick={() => chat.openThread(chat.thread)}>Reload conversation</button>
                    ) : null}
                </p>
            )}
            <form
                className="ks-chat-composer"
                onSubmit={event => {
                    event.preventDefault();
                    followLatest.current = true;
                    chat.send();
                }}
            >
                <div className="ks-chat-input-wrap">
                <textarea
                    ref={composer}
                    rows={1}
                    maxLength={4000}
                    aria-describedby={composerHintId}
                    value={chat.question}
                    onChange={event => chat.setQuestion(event.target.value)}
                    onKeyDown={event => {
                        if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                            event.preventDefault();
                            followLatest.current = true;
                            chat.send();
                        }
                    }}
                    placeholder={!isConnected ? 'Waiting for your meeting service…' : isLive ? 'Ask about the meeting so far…' : 'Ask anything about your meetings…'}
                    aria-label="Meeting question"
                    disabled={!isConnected || chat.busy || chat.loading}
                />
                {chat.busy ? (
                    <button type="button" className="ks-chat-send" onClick={chat.cancel} aria-label="Cancel question">
                        <Square />
                    </button>
                ) : (
                    <button
                        type="submit"
                        className="ks-chat-send"
                        disabled={!chat.question.trim() || !isConnected || chat.loading}
                        aria-label="Send question"
                    >
                        <ArrowUp />
                    </button>
                )}
                </div>
                <div className="ks-chat-composer-hint" id={composerHintId}>
                    <span>{chat.busy ? 'Finding an answer in your meetings…' : 'Enter to send · Shift + Enter for a new line'}</span>
                    {chat.question.length > 3200 && <span className="ks-chat-count">{chat.question.length.toLocaleString()} / 4,000</span>}
                </div>
            </form>
            <p className="ks-chat-disclaimer">AI can miss details. Check the linked sources.</p>
            <details className="ks-chat-history">
                <summary>Conversation history</summary>
                <label>
                    Conversation
                    <select
                        value={chat.thread?.id || ''}
                        onChange={event => {
                            const selected = matchingThreads.find(thread => thread.id === event.target.value);
                            if (selected) chat.openThread(selected);
                            else chat.newThread();
                        }}
                    >
                        <option value="">New conversation</option>
                        {matchingThreads.map(thread => (
                            <option key={thread.id} value={thread.id}>
                                {thread.title} · {new Date(thread.updatedAt || Date.now()).toLocaleString()}
                            </option>
                        ))}
                    </select>
                </label>
                {chat.nextOffset !== null && (
                    <button type="button" className="ks-text-button" onClick={chat.loadMoreThreads}>
                        Load older conversations
                    </button>
                )}
                <p role="status">
                    {!isConnected
                        ? 'Meeting service disconnected'
                        : chat.index?.modelStatus === 'loading'
                          ? 'Preparing search · your meetings are searchable now'
                          : chat.index?.mode === 'hybrid'
                            ? 'Meeting search is ready'
                            : 'Searching meeting text'}{' '}
                    · Relevant meeting excerpts are sent to your AI provider
                </p>
            </details>
            <Dialog open={confirmDelete} onOpenChange={open => { if (!deleting) setConfirmDelete(open); }}>
                <DialogContent className="ks-modal">
                    <DialogTitle>Delete this conversation?</DialogTitle>
                    <DialogDescription>Your questions and AI responses in this thread will be deleted. Your meetings and transcripts stay in your workspace.</DialogDescription>
                    <footer>
                        <button type="button" className="ks-button" disabled={deleting} onClick={() => setConfirmDelete(false)}>Keep conversation</button>
                        <button type="button" className="ks-button ks-red" disabled={deleting} onClick={async () => {
                            setDeleting(true);
                            try { await chat.deleteThread(); setConfirmDelete(false); }
                            finally { setDeleting(false); }
                        }}>{deleting ? 'Deleting…' : 'Delete conversation'}</button>
                    </footer>
                </DialogContent>
            </Dialog>
        </section>
    );
}
