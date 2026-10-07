import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, ArrowUpRight, Check, Copy, FileCheck2, History, ListChecks, Lock, Maximize2, Minimize2, Plus, Search, Sparkles, Square, Trash2, X } from 'lucide-react';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { JumpingBalls } from '@/components/JumpingBalls';
import { MarkdownText } from '@/components/MarkdownText';
import { useMeetingChat } from '@/hooks/useMeetingChat';
import { apiRequest, normalizeMeeting } from '@/lib/backend';
import { citationTarget, citationTime, copyAnswerText, citationDate, scopeKey } from '@/lib/chat';
import { copyToClipboard } from '@/lib/clipboard';

const NO_CITATIONS = [];

function ResponseActions({ message, question, disabled, onFollowUp }) {
    const [copyState, setCopyState] = useState('idle');
    useEffect(() => {
        if (copyState === 'idle') return;
        const timer = setTimeout(() => setCopyState('idle'), 2500);
        return () => clearTimeout(timer);
    }, [copyState]);
    const copy = async () => {
        try {
            await copyToClipboard(copyAnswerText(message));
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
                    : `${citation.sourceKind || 'Meeting'}${citation.startedAt ? ` · ${citationDate(citation.startedAt)}` : ''}`}
            </span>
            <q>{citation.excerpt}</q>
        </button>
    );
}

// Mail-style dates: today's threads show the time, this week's the weekday, older ones the date.
function threadTime(value) {
    if (!Number.isFinite(value)) return '';
    const date = new Date(value);
    const now = new Date();
    const day = moment => new Date(moment.getFullYear(), moment.getMonth(), moment.getDate()).getTime();
    const days = Math.round((day(now) - day(date)) / 86_400_000);
    if (days <= 0) return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    if (days === 1) return 'Yesterday';
    if (days < 7) return date.toLocaleDateString([], { weekday: 'long' });
    return date.toLocaleDateString([], { month: 'short', day: 'numeric', ...(date.getFullYear() !== now.getFullYear() && { year: 'numeric' }) });
}

// Replaces the log and composer while open, the way a sidebar list pushes over its detail view
// in a narrow column. A native <select> could not show dates or the current thread, and buried
// the list under the composer where it read as a footnote.
function ConversationHistory({ threads, currentId, disabled, hasMore, onOpen, onNew, onLoadMore, onClose, note }) {
    const list = useRef(null);
    useEffect(() => {
        const node = list.current;
        (node?.querySelector('[aria-current="true"]') || node?.querySelector('button:not(:disabled)'))?.focus();
    }, []);
    return (
        <div
            ref={list}
            className="ks-chat-threads"
            role="region"
            aria-label="Conversation history"
            onKeyDown={event => {
                if (event.key !== 'Escape') return;
                event.stopPropagation();
                onClose();
            }}
        >
            <div className="ks-chat-threads-head">
                <h3>Conversations</h3>
                <button type="button" className="ks-chat-threads-new" onClick={onNew} disabled={disabled}>
                    <Plus aria-hidden="true" />
                    New
                </button>
            </div>
            {threads.length ? (
                <ul className="ks-chat-threads-list">
                    {threads.map(thread => {
                        const current = thread.id === currentId;
                        return (
                            <li key={thread.id}>
                                <button type="button" aria-current={current ? 'true' : undefined} disabled={disabled} onClick={() => (current ? onClose() : onOpen(thread))}>
                                    <span className="ks-chat-thread-title">{thread.title || 'Untitled conversation'}</span>
                                    <span className="ks-chat-thread-time">{threadTime(thread.updatedAt)}</span>
                                    {current && <Check className="ks-chat-thread-check" aria-label="Open now" />}
                                </button>
                            </li>
                        );
                    })}
                </ul>
            ) : (
                <div className="ks-chat-threads-empty">
                    <History aria-hidden="true" />
                    <p>No saved conversations yet</p>
                    <small>Questions you ask here are saved so you can come back to them.</small>
                </div>
            )}
            {hasMore && (
                <button type="button" className="ks-text-button ks-chat-threads-more" onClick={onLoadMore}>
                    Show older conversations
                </button>
            )}
            <p className="ks-chat-threads-note" role="status">{note}</p>
        </div>
    );
}

export function MeetingChatPanel({ scope, scopeLabel, isConnected, onSelectMeeting, isLive = false, scopeControl = null, filterControl = null, draft = null, onClose = null, onUpgrade = null, isExpanded = false, onToggleExpand = null }) {
    const chat = useMeetingChat(scope, isConnected);
    const [sourceError, setSourceError] = useState(null);
    const log = useRef(null);
    const composer = useRef(null);
    const followLatest = useRef(true);
    const previousLog = useRef({ messages: [], height: 0 });
    const [hasNewResponse, setHasNewResponse] = useState(false);
    const [confirmDelete, setConfirmDelete] = useState(false);
    const [deleting, setDeleting] = useState(false);
    const [showHistory, setShowHistory] = useState(false);
    const historyButton = useRef(null);
    // Where keyboard focus lands once the history list closes; the list unmounts, so focus must be placed explicitly.
    const historyReturn = useRef(null);
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
    const locked = chat.requiresPro;
    const actionsDisabled = !isConnected || chat.busy || chat.loading || locked;
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
        textarea.style.height = '0px';
        textarea.style.height = `${Math.max(38, Math.min(120, textarea.scrollHeight))}px`;
    }, [chat.question, showHistory]);
    useEffect(() => { setShowHistory(false); }, [scopeKey(scope)]);
    useEffect(() => {
        if (showHistory) return;
        // The log remounts at the top; put the reader back at the latest message.
        jumpToLatest();
        const target = historyReturn.current;
        historyReturn.current = null;
        target?.current?.focus();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [showHistory]);
    const closeHistory = (focus = historyButton) => {
        historyReturn.current = focus;
        setShowHistory(false);
    };
    useEffect(() => {
        followLatest.current = true;
        setHasNewResponse(false);
        setSourceError(null);
        setConfirmDelete(false);
    }, [scopeKey(scope), chat.thread?.id]);
    // A quoted transcript turn (or any caller) hands us a pre-filled question.
    // The key changes on every seed, so quoting the same turn twice re-seeds.
    useEffect(() => {
        if (!draft?.text) return;
        chat.setQuestion(draft.text);
        composer.current?.focus();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [draft?.key]);
    const openSource = useCallback(
        async citation => {
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
        },
        [onSelectMeeting]
    );
    const searchStatus = !isConnected
        ? 'Kesami is offline'
        : chat.index?.modelStatus === 'loading'
          ? 'Preparing search · your meetings are searchable now'
          : chat.index?.mode === 'hybrid'
            ? 'Meeting search is ready'
            : 'Searching meeting text';
    const matchingThreads = chat.threads.filter(thread => scopeKey(thread.scope) === scopeKey(scope));
    const singleMeeting = scope?.type === 'meetings' && scope.meetingIds?.length === 1;
    const starters = isLive
        ? [['Catch me up', 'Summarize the discussion so far', Search], ['Find decisions', 'What decisions have we made so far?', FileCheck2], ['Plan next steps', 'What next steps have been discussed?', ListChecks]]
        : [['Find decisions', 'What decisions did we make?', FileCheck2], ['Find open tasks', 'What action items are still unresolved?', ListChecks],
            [singleMeeting ? 'Catch me up' : 'Find commitments', singleMeeting ? 'Summarize the key discussion points' : 'What commitments did I make across these meetings?', Search]];
    return (
        <section className={`ks-chat${isLive ? ' ks-chat-is-live' : ''}`} aria-label="Meeting AI assistant">
            <header className="ks-chat-head">
                <span className="ks-chat-brand"><Sparkles className="ks-chat-head-icon" aria-hidden="true" /></span>
                <div className="ks-chat-head-text">
                    <div className="ks-chat-title-line"><h2>Ask Kesami</h2>{isLive && isConnected && <span className="ks-chat-live-badge">Live</span>}</div>
                    {scopeLabel && <p title={scopeLabel}>{scopeLabel}</p>}
                </div>
                {scopeControl}
                <button
                    ref={historyButton}
                    type="button"
                    className="ks-icon-button"
                    onClick={() => (showHistory ? closeHistory() : setShowHistory(true))}
                    disabled={deleting}
                    aria-label="Conversation history"
                    aria-pressed={showHistory}
                    title="Conversation history"
                >
                    <History />
                </button>
                <button type="button" className="ks-icon-button" onClick={() => { chat.newThread(); if (showHistory) closeHistory(composer); else composer.current?.focus(); }} disabled={deleting} aria-label="New conversation" title="New conversation">
                    <Plus />
                </button>
                {chat.thread && (
                    <button type="button" className="ks-icon-button" onClick={() => setConfirmDelete(true)} disabled={chat.busy || deleting} aria-label="Delete conversation" title="Delete conversation">
                        <Trash2 />
                    </button>
                )}
                {onToggleExpand && <button type="button" className="ks-icon-button" onClick={onToggleExpand} aria-label={isExpanded ? 'Restore AI panel' : 'Expand AI panel'} title={isExpanded ? 'Restore panel' : 'Expand panel'} aria-pressed={isExpanded}>{isExpanded ? <Minimize2 /> : <Maximize2 />}</button>}
                {onClose && <button type="button" className="ks-icon-button ks-chat-header-close" onClick={onClose} aria-label="Close Ask AI" title="Close Ask AI"><X /></button>}
            </header>
            {filterControl}
            {isLive && !showHistory && (
                <p className="ks-chat-live" role="status">
                    Answers use the transcript captured when you send your question. Ask again to include newer speech.
                </p>
            )}
            {!isConnected && <p className="ks-chat-live" role="status">Kesami is offline. Questions work again once it reconnects.</p>}
            {showHistory ? (
                <ConversationHistory
                    threads={matchingThreads}
                    currentId={chat.thread?.id}
                    disabled={!isConnected || deleting}
                    hasMore={chat.nextOffset !== null}
                    onOpen={thread => { chat.openThread(thread); closeHistory(); }}
                    onNew={() => { chat.newThread(); closeHistory(composer); }}
                    onLoadMore={chat.loadMoreThreads}
                    onClose={() => closeHistory()}
                    note={`${searchStatus} · Relevant meeting excerpts are sent for AI processing when you ask.`}
                />
            ) : (
                <>
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
                        {!chat.messages.length && !chat.loading && locked && (
                            <div className="ks-chat-upgrade">
                                <Lock aria-hidden="true" />
                                <h3>Free AI allowance used</h3>
                                <p>Your three shared AI summaries or chat replies for this month are used. Upgrade to keep asking questions.</p>
                                {onUpgrade && <button type="button" className="ks-button ks-primary" onClick={onUpgrade}>See plans</button>}
                            </div>
                        )}
                        {!chat.messages.length && !chat.loading && !locked && (
                            <div className="ks-chat-empty">
                                <h3>{isLive ? 'Stay with the conversation' : singleMeeting ? 'How can I help?' : 'Ask across your meetings'}</h3>
                                <p>{isLive ? 'Catch up, find a decision, or check next steps while the meeting continues.' : 'Ask about decisions, follow-ups, or anything that was said. Answers link back to their source.'}</p>
                                <ul className="ks-chat-starters" aria-label="Suggested questions">
                                    {starters.map(([label, prompt, Icon]) => (
                                        <li key={prompt}>
                                            <button type="button" disabled={actionsDisabled} onClick={() => chat.send(prompt)}>
                                                <Icon aria-hidden="true" /><span><strong>{label}</strong><small>{prompt}</small></span><ArrowUpRight aria-hidden="true" />
                                            </button>
                                        </li>
                                    ))}
                                </ul>
                            </div>
                        )}
                        {chat.messages.map((message, i) => (
                            <div
                                key={`${message.requestId}-${message.role}-${i}`}
                                className={`ks-chat-row ${message.role === 'user' ? 'ks-chat-row-user' : ''}`}
                            >
                                <div className={`ks-chat-bubble ${message.role === 'user' ? 'ks-chat-user' : 'ks-chat-assistant'}`}>
                                    {message.role !== 'user' && <span className="ks-chat-ai-label"><Sparkles aria-hidden="true" /> Kesami AI</span>}
                                    <MarkdownText
                                        markdown={message.content}
                                        className="ks-chat-markdown"
                                        citations={message.role === 'assistant' ? message.citations : NO_CITATIONS}
                                        onOpenCitation={openSource}
                                    />
                                    {message.coverage?.eligibleMeetings > 0 && (
                                        <p className="ks-chat-coverage">
                                            {message.retrievalMode === 'structured'
                                                ? `${message.coverage.shownItems} of ${message.coverage.totalItems} recorded items`
                                                : message.coverage.retrievedMeetings > 0
                                                  ? `Evidence from ${message.coverage.retrievedMeetings} of ${message.coverage.eligibleMeetings} meetings`
                                                  : 'No matching transcript evidence yet'}
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
                                            onClick={() => chat.send(`${message.coverage.unresolved ? "List unresolved action items" : "List every action item"}, page ${message.coverage.nextPage}`)}
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
                    {((chat.error && !locked) || sourceError) && (
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
                            placeholder={!isConnected ? 'Waiting to reconnect…' : locked ? 'Monthly free AI allowance used' : 'Ask about the meeting…'}
                            aria-label="Meeting question"
                            disabled={!isConnected || chat.busy || chat.loading || locked}
                        />
                        {chat.busy ? (
                            <button type="button" className="ks-chat-send" onClick={chat.cancel} aria-label="Cancel question">
                                <Square />
                            </button>
                        ) : (
                            <button
                                type="submit"
                                className="ks-chat-send"
                                disabled={!chat.question.trim() || !isConnected || chat.loading || locked}
                                aria-label="Send question"
                            >
                                <ArrowUp />
                            </button>
                        )}
                        </div>
                        <div className="ks-chat-composer-hint" id={composerHintId}>
                            <span>{chat.busy ? 'Finding an answer in your meetings…' : <><kbd>Enter</kbd> to send · <kbd>Shift + Enter</kbd> for a new line</>}</span>
                            {chat.question.length > 3200 && <span className="ks-chat-count">{chat.question.length.toLocaleString()} / 4,000</span>}
                        </div>
                        <p className="ks-chat-disclaimer">AI can miss details. Check the linked sources.</p>
                    </form>
                </>
            )}
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
