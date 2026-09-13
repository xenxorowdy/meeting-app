import React, { useEffect, useRef, useState } from 'react';
import { ArrowUpRight, Bot, Check, Copy, LoaderCircle, MessageCircle, Plus, Send, Square, Trash2 } from 'lucide-react';
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
    const bottom = useRef(null);
    const composer = useRef(null);
    const prepareQuestion = question => {
        chat.setQuestion(question);
        composer.current?.focus();
    };
    const actionsDisabled = !isConnected || chat.busy || chat.loading;
    useEffect(() => {
        bottom.current?.scrollIntoView({ block: 'nearest' });
    }, [chat.messages, chat.busy]);
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
    const starters = isLive
        ? ['Summarize the discussion so far', 'What decisions have we made so far?', 'What next steps have been discussed?']
        : ['What decisions did we make?', 'List every action item', 'What changed between these meetings?'];
    return (
        <section className="ks-chat">
            <header className="ks-chat-head">
                <MessageCircle className="ks-chat-head-icon" aria-hidden="true" />
                <div className="ks-chat-head-text">
                    <h2>Ask AI</h2>
                    {scopeLabel && <p title={scopeLabel}>{scopeLabel}</p>}
                </div>
                {scopeControl}
                <button type="button" className="ks-icon-button" onClick={chat.newThread} aria-label="New conversation">
                    <Plus />
                </button>
                {chat.thread && (
                    <button type="button" className="ks-icon-button" onClick={chat.deleteThread} aria-label="Delete conversation">
                        <Trash2 />
                    </button>
                )}
            </header>
            {isLive && (
                <p className="ks-chat-live" role="status">
                    Answers use the transcript captured when you send your question. Ask again to include newer speech.
                </p>
            )}
            <div className="ks-chat-log" aria-label="Conversation messages" aria-live="polite">
                {chat.before && (
                    <button type="button" className="ks-text-button" disabled={chat.loading} onClick={chat.loadEarlier}>
                        Load earlier messages
                    </button>
                )}
                {chat.loading && <p className="ks-chat-note">Loading conversation…</p>}
                {!chat.messages.length && !chat.loading && (
                    <div className="ks-chat-empty">
                        <Bot />
                        <h3>{isLive ? 'Ask about the meeting so far' : 'Ask about these meetings'}</h3>
                        <p>Find decisions, compare discussions, or ask a follow-up. Answers link to the passages used.</p>
                        <div className="ks-chat-starters">
                            {starters.map(prompt => (
                                <button key={prompt} type="button" disabled={actionsDisabled} onClick={() => prepareQuestion(prompt)}>
                                    {prompt}
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
                            {message.role !== 'user' && <span className="ks-chat-ai-label">● AI</span>}
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
                    <p className="ks-chat-note ks-chat-busy" role="status">
                        <LoaderCircle /> Searching passages and preparing an answer…
                    </p>
                )}
                <div ref={bottom} />
            </div>
            {(chat.error || sourceError) && (
                <p className="ks-chat-error" role="alert">
                    {sourceError || chat.error}
                    {chat.error && (
                        <button type="button" disabled={chat.busy} onClick={() => chat.send()}>
                            Retry
                        </button>
                    )}
                </p>
            )}
            <form
                className="ks-chat-composer"
                onSubmit={event => {
                    event.preventDefault();
                    chat.send();
                }}
            >
                <textarea
                    ref={composer}
                    rows={1}
                    maxLength={4000}
                    value={chat.question}
                    onChange={event => chat.setQuestion(event.target.value)}
                    onKeyDown={event => {
                        if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                            event.preventDefault();
                            chat.send();
                        }
                    }}
                    placeholder={isLive ? 'Ask about the meeting so far…' : 'Ask a question…'}
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
                        <Send />
                    </button>
                )}
            </form>
            <details className="ks-chat-history">
                <summary>Conversations & search status</summary>
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
                        ? 'Backend disconnected'
                        : chat.index?.modelStatus === 'loading'
                          ? 'Preparing local semantic search · keyword search available'
                          : chat.index?.mode === 'hybrid'
                            ? `Local hybrid search · ${chat.index.pendingChunks} passages awaiting embeddings`
                            : 'Keyword search only · local embeddings unavailable'}{' '}
                    · Only relevant excerpts are sent to AI
                </p>
            </details>
        </section>
    );
}
