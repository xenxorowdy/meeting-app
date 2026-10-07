import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Calendar, Check, Copy, Mail, Pencil, Plus, RotateCw, Sparkles, Square, Trash2, User } from 'lucide-react';
import { cn } from '@/utils/cn';
import { MarkdownText } from '@/components/MarkdownText';
import { copyToClipboard } from '@/lib/clipboard';
import { initialsFor } from '@/lib/speakers';
import { readingMinutes, speakerColor } from '@/components/design/designHelpers';

const TABS = [
    ['summary', 'Summary'],
    ['decisions', 'Decisions'],
    ['actions', 'Actions'],
    ['email', 'Email'],
];
const LIST_TABS = { keyDecisions: 'decisions', actionItems: 'actions' };
const DUE_SUGGESTIONS = ['Today', 'Tomorrow', 'This week', 'Next week', 'End of month'];
const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent || '');
const SAVE_SHORTCUT = IS_MAC ? '⌘↩' : 'Ctrl+Enter';
const UNDO_SHORTCUT = IS_MAC ? '⌘Z' : 'Ctrl+Z';
const drafts = new Map();

function useDraft(key, initial) {
    const [value, setValue] = useState(() => (drafts.has(key) ? drafts.get(key) : initial));
    const update = useCallback(
        (next, keep = next !== initial) => {
            setValue(next);
            if (keep) drafts.set(key, next);
            else drafts.delete(key);
        },
        [key, initial]
    );
    return [value, update];
}

function splitEmail(draft = '') {
    const match = draft.match(/^Subject:[ \t]*(.*)(?:\r?\n|$)/i);
    if (!match) return { subject: '', body: draft.trim() };
    return { subject: match[1].trim(), body: draft.slice(match[0].length).trim() };
}

function joinEmail({ subject, body }) {
    return [subject.trim() && `Subject: ${subject.trim()}`, body.trim()].filter(Boolean).join('\n\n');
}

function actionId(item, index) {
    return typeof item === 'object' ? item.id || `act-${index}` : `act-${index}`;
}

function isTyping(target) {
    return target instanceof HTMLElement && (target.isContentEditable || target.matches('textarea, select, input:not([type="checkbox"]):not([type="radio"])'));
}

function focusRow(expected, index) {
    return root => {
        const buttons = root?.querySelectorAll('.ks-notes-list .ks-notes-delete') || [];
        if (buttons.length !== expected) return undefined;
        return buttons[Math.min(index, buttons.length - 1)] || root.querySelector('.ks-notes-undo button') || root.querySelector('.ks-notes-add input');
    };
}

function ComposeFooter({ hint, saving, discarding, onCancel, onSave, onKeepEditing, onDiscard }) {
    if (discarding) {
        return (
            <footer key="confirm" className="is-confirming">
                <span role="alert">Discard your changes?</span>
                <div>
                    <button type="button" className="ks-button" onClick={onKeepEditing} autoFocus>
                        Keep editing
                    </button>
                    <button type="button" className="ks-button ks-red" onClick={onDiscard}>
                        Discard
                    </button>
                </div>
            </footer>
        );
    }
    return (
        <footer key="actions">
            <span className="ks-notes-hint">
                {hint && <span>{hint}</span>}
                <span>
                    <kbd>{SAVE_SHORTCUT}</kbd> to save, <kbd>Esc</kbd> to cancel
                </span>
            </span>
            <div>
                <button type="button" className="ks-button" onClick={onCancel}>
                    Cancel
                </button>
                <button type="button" className="ks-button ks-primary" disabled={saving} onClick={onSave}>
                    {saving ? 'Saving…' : 'Save'}
                </button>
            </div>
        </footer>
    );
}

export function SummaryEditor({ meeting, people = [], onUpdateMeeting, onRegenerateSummary, isGenerating = false }) {
    const meetingId = meeting?.id ?? 'none';
    const listId = useId();
    const sectionRef = useRef(null);
    const regenerateRef = useRef(null);
    const pendingFocus = useRef(null);
    const undoRef = useRef(null);

    const [activeTab, setActiveTab] = useState(() => (!drafts.has(`${meetingId}:summary`) && drafts.has(`${meetingId}:email`) ? 'email' : 'summary'));
    const [summaryDraft, setSummaryDraft] = useDraft(`${meetingId}:summary`, null);
    const [emailDraft, setEmailDraft] = useDraft(`${meetingId}:email`, null);
    const [newDecision, setNewDecision] = useDraft(`${meetingId}:decision`, '');
    const [newActionTask, setNewActionTask] = useDraft(`${meetingId}:task`, '');
    const [newActionOwner, setNewActionOwner] = useDraft(`${meetingId}:owner`, 'You');
    const [newActionDeadline, setNewActionDeadline] = useDraft(`${meetingId}:due`, 'Next week');

    const [discarding, setDiscarding] = useState('');
    const [confirmingRegenerate, setConfirmingRegenerate] = useState(false);
    const [undoStack, setUndoStack] = useState([]);
    const [announcement, setAnnouncement] = useState('');
    const [copied, setCopied] = useState('');
    const [saving, setSaving] = useState(false);
    const [saveError, setSaveError] = useState('');

    useEffect(() => {
        if (!pendingFocus.current) return;
        const target = pendingFocus.current(sectionRef.current);
        if (target === undefined) return;
        pendingFocus.current = null;
        target?.focus();
    });

    useEffect(() => {
        if (!undoStack.length) return undefined;
        const onKeyDown = event => {
            if (event.key?.toLowerCase() !== 'z' || !(event.metaKey || event.ctrlKey) || event.shiftKey || event.altKey || event.defaultPrevented) return;
            if (isTyping(event.target) || (event.target !== document.body && !sectionRef.current?.contains(event.target))) return;
            event.preventDefault();
            void undoRef.current?.();
        };
        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
    }, [undoStack.length]);

    const save = async updates => {
        if (saving || !onUpdateMeeting) return false;
        setSaving(true);
        setSaveError('');
        try {
            const result = await onUpdateMeeting(updates);
            if (result?.ok === false) throw new Error(result.message || 'Could not save your changes.');
            return true;
        } catch (cause) {
            setSaveError(cause.message || 'Could not save your changes.');
            return false;
        } finally { setSaving(false); }
    };

    const announce = text => {
        setAnnouncement('');
        window.setTimeout(() => setAnnouncement(text), 60);
    };

    const decisions = meeting?.keyDecisions || [];
    const actionItems = meeting?.actionItems || [];
    const originalSummary = meeting?.summaryMarkdown || '';
    const email = splitEmail(meeting?.emailDraft);
    const summaryChanged = summaryDraft !== null && summaryDraft !== originalSummary;
    const emailChanged = emailDraft !== null && joinEmail(emailDraft) !== joinEmail(email);

    const undoDelete = async () => {
        const last = undoStack.at(-1);
        if (!last || saving) return;
        const list = [...(meeting?.[last.field] || [])];
        const index = Math.min(last.index, list.length);
        list.splice(index, 0, last.item);
        if (await save({ [last.field]: list })) {
            setUndoStack(stack => stack.slice(0, -1));
            setActiveTab(LIST_TABS[last.field]);
            pendingFocus.current = focusRow(list.length, index);
            announce(last.field === 'keyDecisions' ? 'Decision restored' : 'Action item restored');
        }
    };
    undoRef.current = undoDelete;

    if (!meeting) {
        return (
            <section className="ks-notes ks-notes-blank">
                <h3>No notes yet</h3>
                <p>Record a meeting, or open one from your library, to see its summary, decisions, and action items here.</p>
            </section>
        );
    }

    const selectTab = value => {
        setDiscarding('');
        setActiveTab(value);
    };

    const closeSummary = () => {
        setDiscarding('');
        setSummaryDraft(null);
        pendingFocus.current = root => root?.querySelector('[data-notes-edit="summary"]') ?? undefined;
    };

    const closeEmail = () => {
        setDiscarding('');
        setEmailDraft(null);
        pendingFocus.current = root => root?.querySelector('[data-notes-edit="email"]') ?? undefined;
    };

    const keepEditing = () => {
        setDiscarding('');
        pendingFocus.current = root => root?.querySelector('.ks-notes-compose textarea') ?? undefined;
    };

    const handleSaveSummary = async () => {
        if (await save({ summaryMarkdown: summaryDraft })) closeSummary();
    };

    const handleSaveEmail = async () => {
        if (await save({ emailDraft: joinEmail(emailDraft) })) closeEmail();
    };

    const editEmail = changes => {
        const next = { ...emailDraft, ...changes };
        setEmailDraft(next, joinEmail(next) !== joinEmail(email));
    };

    const composeKeys = (kind, changed, onSave, onClose) => event => {
        if (event.nativeEvent.isComposing) return;
        if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            void onSave();
        } else if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            if (discarding === kind) keepEditing();
            else if (changed) setDiscarding(kind);
            else onClose();
        }
    };

    const hasNotes = Boolean(originalSummary || decisions.length || actionItems.length || meeting.emailDraft);

    const handleRegenerate = () => {
        if (isGenerating || !hasNotes) {
            void onRegenerateSummary?.();
            return;
        }
        setConfirmingRegenerate(true);
    };

    const cancelRegenerate = () => {
        setConfirmingRegenerate(false);
        pendingFocus.current = () => regenerateRef.current;
    };

    const confirmRegenerate = async () => {
        setConfirmingRegenerate(false);
        pendingFocus.current = () => regenerateRef.current;
        const result = await onRegenerateSummary?.();
        if (result?.ok) {
            setDiscarding('');
            setSummaryDraft(null);
            setEmailDraft(null);
            setUndoStack([]);
        }
    };

    const handleAddDecision = async event => {
        event.preventDefault();
        if (!newDecision.trim()) return;
        const updated = [...decisions, newDecision.trim()];
        if (await save({ keyDecisions: updated })) setNewDecision('');
    };

    const handleRemoveDecision = async index => {
        const removed = decisions[index];
        if (await save({ keyDecisions: decisions.filter((_, i) => i !== index) })) {
            setUndoStack(stack => [...stack, { field: 'keyDecisions', item: removed, index, label: 'Decision deleted' }]);
            pendingFocus.current = focusRow(decisions.length - 1, index);
            announce('Decision deleted');
        }
    };

    const handleToggleAction = id => {
        const updated = actionItems.map((item, idx) => {
            if (actionId(item, idx) !== id) return item;
            if (typeof item === 'object') return { ...item, completed: !item.completed };
            return { task: item, owner: 'You', completed: true };
        });
        void save({ actionItems: updated });
    };

    const handleAddAction = async event => {
        event.preventDefault();
        if (!newActionTask.trim()) return;
        const newItem = {
            id: `act-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
            task: newActionTask.trim(),
            owner: newActionOwner.trim() || 'You',
            deadline: newActionDeadline.trim() || 'TBD',
            completed: false,
        };
        if (await save({ actionItems: [...actionItems, newItem] })) setNewActionTask('');
    };

    const handleRemoveAction = async id => {
        const index = actionItems.findIndex((item, idx) => actionId(item, idx) === id);
        if (index === -1) return;
        if (await save({ actionItems: actionItems.filter((_, i) => i !== index) })) {
            setUndoStack(stack => [...stack, { field: 'actionItems', item: actionItems[index], index, label: 'Action item deleted' }]);
            pendingFocus.current = focusRow(actionItems.length - 1, index);
            announce('Action item deleted');
        }
    };

    const copyText = async (text, which, message) => {
        try {
            await copyToClipboard(text);
            setCopied(which);
            announce(message);
            setTimeout(() => setCopied(current => (current === which ? '' : current)), 2000);
        } catch {
            setSaveError('Couldn’t copy. Select the text to copy it instead.');
        }
    };

    const handleCopyEmail = () => {
        if (!meeting.emailDraft) return;
        void copyText(meeting.emailDraft, 'email', 'Email copied');
    };

    const handleCopyAllNotes = () => {
        const decisionsMd = decisions.map(d => `- ${d}`).join('\n');
        const actionsMd = actionItems
            .map(a => {
                if (typeof a === 'string') return `- [ ] ${a}`;
                const details = [a.owner && `**${a.owner}**`, a.deadline && `Due: ${a.deadline}`].filter(Boolean);
                return `- [${a.completed ? 'x' : ' '}] ${a.task}${details.length ? ` (${details.join(', ')})` : ''}`;
            })
            .join('\n');

        const sections = [
            `# ${meeting.title || 'Untitled meeting'}`,
            meeting.summaryMarkdown && `## Executive Summary\n${meeting.summaryMarkdown}`,
            decisionsMd && `## Key Decisions\n${decisionsMd}`,
            actionsMd && `## Action Items\n${actionsMd}`,
            meeting.emailDraft && `## Follow-up Email\n${meeting.emailDraft}`,
        ].filter(Boolean);
        void copyText(sections.join('\n\n'), 'all', 'Notes copied');
    };

    const moveTab = event => {
        const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
        if (!step) return;
        event.preventDefault();
        const index = (TABS.findIndex(([value]) => value === activeTab) + step + TABS.length) % TABS.length;
        selectTab(TABS[index][0]);
        event.currentTarget.querySelectorAll('[role="tab"]')[index]?.focus();
    };

    const completedActionCount = actionItems.filter(a => typeof a === 'object' && a.completed).length;
    const mailto = `mailto:?subject=${encodeURIComponent(email.subject)}&body=${encodeURIComponent(email.body)}`;
    const owners = [...new Set(['You', ...people, ...actionItems.map(item => (typeof item === 'object' ? item.owner : ''))])].filter(
        name => name && name !== 'Unassigned'
    );
    const lastUndo = undoStack.at(-1);
    const tabMeta = {
        summary: summaryChanged ? 'Unsaved edits' : originalSummary ? `${readingMinutes(originalSummary)} min read` : 'Not written',
        decisions: decisions.length ? `${decisions.length} recorded` : 'None yet',
        actions: actionItems.length ? `${completedActionCount} of ${actionItems.length} done` : 'None yet',
        email: emailChanged ? 'Unsaved edits' : meeting.emailDraft ? 'Ready to send' : 'Not written',
    };
    const unsaved = { summary: summaryChanged, email: emailChanged };

    const undoLine = lastUndo && LIST_TABS[lastUndo.field] === activeTab && (
        <div className="ks-notes-undo">
            <span>{lastUndo.label}</span>
            <button type="button" onClick={() => void undoDelete()} disabled={saving}>
                Undo
            </button>
            <kbd>{UNDO_SHORTCUT}</kbd>
        </div>
    );

    return (
        <section ref={sectionRef} aria-label="Meeting notes" className="ks-notes">
            <header className="ks-notes-head">
                <div>
                    <h3>Meeting notes</h3>
                    <p>
                        <Sparkles aria-hidden="true" />
                        Generated from the transcript. Check the details before you share them.
                    </p>
                </div>

                <div className="ks-notes-actions">
                    {onRegenerateSummary && (
                        <button
                            ref={regenerateRef}
                            type="button"
                            className="ks-notes-action"
                            onClick={handleRegenerate}
                            disabled={saving}
                            aria-label={isGenerating ? 'Stop summary generation' : 'Regenerate summary'}
                        >
                            {isGenerating ? <Square aria-hidden="true" /> : <RotateCw aria-hidden="true" />}
                            {isGenerating ? 'Stop' : 'Regenerate'}
                        </button>
                    )}
                    <button type="button" className={cn('ks-notes-action', copied === 'all' && 'is-copied')} onClick={handleCopyAllNotes}>
                        {copied === 'all' ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
                        {copied === 'all' ? 'Copied' : 'Copy all'}
                    </button>
                </div>
            </header>

            {confirmingRegenerate && (
                <div
                    className="ks-notes-confirm"
                    role="alertdialog"
                    aria-labelledby="notes-regenerate-title"
                    aria-describedby="notes-regenerate-text"
                    onKeyDown={event => {
                        if (event.key !== 'Escape') return;
                        event.stopPropagation();
                        cancelRegenerate();
                    }}
                >
                    <div>
                        <strong id="notes-regenerate-title">Regenerate these notes?</strong>
                        <p id="notes-regenerate-text">
                            This replaces the summary, decisions, action items and follow-up email, including any edits you made.
                        </p>
                    </div>
                    <div>
                        <button type="button" className="ks-button" onClick={cancelRegenerate} autoFocus>
                            Cancel
                        </button>
                        <button type="button" className="ks-button ks-red" onClick={() => void confirmRegenerate()}>
                            Regenerate
                        </button>
                    </div>
                </div>
            )}

            <div className="ks-notes-body">
                <div className="ks-notes-tabs" role="tablist" aria-label="Meeting notes sections" aria-orientation="vertical" onKeyDown={moveTab}>
                    {TABS.map(([value, label], index) => (
                        <button
                            key={value}
                            type="button"
                            id={`notes-tab-${value}`}
                            role="tab"
                            aria-selected={activeTab === value}
                            aria-controls="notes-panel"
                            tabIndex={activeTab === value ? 0 : -1}
                            onClick={() => selectTab(value)}
                        >
                            <span className="ks-notes-tab-index" aria-hidden="true">
                                {String(index + 1).padStart(2, '0')}
                            </span>
                            <span className="ks-notes-tab-label">{label}</span>
                            <small className={cn('ks-notes-tab-meta', unsaved[value] && 'is-unsaved')}>{tabMeta[value]}</small>
                        </button>
                    ))}
                </div>

                <div id="notes-panel" role="tabpanel" aria-labelledby={`notes-tab-${activeTab}`} className="ks-notes-panel">
                    {saveError && (
                        <p className="ks-notes-error" role="alert">
                            {saveError}
                        </p>
                    )}
                    {activeTab === 'summary' &&
                        (summaryDraft !== null ? (
                            <div className="ks-notes-compose" onKeyDown={composeKeys('summary', summaryChanged, handleSaveSummary, closeSummary)}>
                                <textarea
                                    value={summaryDraft}
                                    disabled={saving}
                                    onChange={event => setSummaryDraft(event.target.value, event.target.value !== originalSummary)}
                                    rows={14}
                                    aria-label="Summary markdown"
                                    placeholder="Write the summary in Markdown"
                                    autoFocus
                                />
                                <ComposeFooter
                                    hint="Markdown supported"
                                    saving={saving}
                                    discarding={discarding === 'summary'}
                                    onCancel={closeSummary}
                                    onSave={handleSaveSummary}
                                    onKeepEditing={keepEditing}
                                    onDiscard={closeSummary}
                                />
                            </div>
                        ) : (
                            <>
                                <div className="ks-notes-bar">
                                    <button
                                        type="button"
                                        className="ks-notes-action"
                                        data-notes-edit="summary"
                                        disabled={saving}
                                        onClick={() => setSummaryDraft(originalSummary, false)}
                                    >
                                        <Pencil aria-hidden="true" />
                                        Edit
                                    </button>
                                </div>
                                {originalSummary ? (
                                    <MarkdownText className="ks-notes-prose" markdown={originalSummary} />
                                ) : (
                                    <p className="ks-notes-empty">No summary yet. End a recording to generate one.</p>
                                )}
                            </>
                        ))}

                    {activeTab === 'decisions' && (
                        <>
                            {decisions.length === 0 ? (
                                <p className="ks-notes-empty">No decisions recorded yet. Add the first one below.</p>
                            ) : (
                                <ol className="ks-notes-list">
                                    {decisions.map((decision, idx) => (
                                        <li key={idx} className="ks-notes-row">
                                            <span className="ks-notes-index">{String(idx + 1).padStart(2, '0')}</span>
                                            <p>{decision}</p>
                                            <button
                                                type="button"
                                                className="ks-notes-delete"
                                                onClick={() => void handleRemoveDecision(idx)}
                                                disabled={saving}
                                                aria-label={`Delete decision: ${decision}`}
                                            >
                                                <Trash2 aria-hidden="true" />
                                            </button>
                                        </li>
                                    ))}
                                </ol>
                            )}
                            {undoLine}
                            <form onSubmit={handleAddDecision} className="ks-notes-add">
                                <Plus aria-hidden="true" />
                                <input
                                    value={newDecision}
                                    disabled={saving}
                                    onChange={event => setNewDecision(event.target.value)}
                                    placeholder="Add a decision…"
                                    aria-label="New decision"
                                />
                                <button type="submit" className="ks-button ks-primary" disabled={!newDecision.trim() || saving}>
                                    Add
                                </button>
                            </form>
                        </>
                    )}

                    {activeTab === 'actions' && (
                        <>
                            {actionItems.length === 0 ? (
                                <p className="ks-notes-empty">No action items yet. Add the first one below.</p>
                            ) : (
                                <ul
                                    className="ks-notes-list ks-notes-tasks"
                                    style={{ '--ks-progress': `${(completedActionCount / actionItems.length) * 100}%` }}
                                >
                                    {actionItems.map((item, idx) => {
                                        const id = actionId(item, idx);
                                        const task = typeof item === 'object' ? item.task : item;
                                        const owner = typeof item === 'object' ? item.owner || 'You' : 'You';
                                        const deadline = typeof item === 'object' ? item.deadline || 'TBD' : 'TBD';
                                        const completed = typeof item === 'object' ? Boolean(item.completed) : false;

                                        return (
                                            <li key={id} className={cn('ks-notes-row ks-notes-task', completed && 'is-done')}>
                                                <input
                                                    type="checkbox"
                                                    id={`action-${id}`}
                                                    checked={completed}
                                                    disabled={saving}
                                                    onChange={() => handleToggleAction(id)}
                                                />
                                                <div>
                                                    <label htmlFor={`action-${id}`}>{task}</label>
                                                    <div className="ks-notes-meta">
                                                        <span>
                                                            <i className="ks-notes-avatar" style={{ color: speakerColor(owner) }} aria-hidden="true">
                                                                {initialsFor(owner)}
                                                            </i>
                                                            {owner}
                                                        </span>
                                                        <span>
                                                            <Calendar aria-hidden="true" />
                                                            {deadline === 'TBD' ? 'No due date' : `Due ${deadline}`}
                                                        </span>
                                                    </div>
                                                </div>
                                                <button
                                                    type="button"
                                                    className="ks-notes-delete"
                                                    onClick={() => void handleRemoveAction(id)}
                                                    disabled={saving}
                                                    aria-label={`Delete task: ${task}`}
                                                >
                                                    <Trash2 aria-hidden="true" />
                                                </button>
                                            </li>
                                        );
                                    })}
                                </ul>
                            )}
                            {undoLine}
                            <form onSubmit={handleAddAction} className="ks-notes-add">
                                <Plus aria-hidden="true" />
                                <input
                                    value={newActionTask}
                                    disabled={saving}
                                    onChange={event => setNewActionTask(event.target.value)}
                                    placeholder="Add an action item…"
                                    aria-label="New task"
                                />
                                <span className="ks-notes-fields">
                                    <label className="ks-notes-chip">
                                        <User aria-hidden="true" />
                                        <input
                                            value={newActionOwner}
                                            disabled={saving}
                                            onChange={event => setNewActionOwner(event.target.value)}
                                            onFocus={event => event.target.select()}
                                            list={`${listId}-owners`}
                                            autoComplete="off"
                                            placeholder="Owner"
                                            aria-label="Task owner"
                                        />
                                    </label>
                                    <label className="ks-notes-chip">
                                        <Calendar aria-hidden="true" />
                                        <input
                                            value={newActionDeadline}
                                            disabled={saving}
                                            onChange={event => setNewActionDeadline(event.target.value)}
                                            onFocus={event => event.target.select()}
                                            list={`${listId}-due`}
                                            autoComplete="off"
                                            placeholder="Due"
                                            aria-label="Task due date"
                                        />
                                    </label>
                                    <button type="submit" className="ks-button ks-primary" disabled={!newActionTask.trim() || saving}>
                                        Add
                                    </button>
                                </span>
                                <datalist id={`${listId}-owners`}>
                                    {owners.map(name => (
                                        <option key={name} value={name} />
                                    ))}
                                </datalist>
                                <datalist id={`${listId}-due`}>
                                    {DUE_SUGGESTIONS.map(value => (
                                        <option key={value} value={value} />
                                    ))}
                                </datalist>
                            </form>
                        </>
                    )}

                    {activeTab === 'email' &&
                        (emailDraft ? (
                            <div className="ks-notes-compose" onKeyDown={composeKeys('email', emailChanged, handleSaveEmail, closeEmail)}>
                                <label className="ks-notes-email-field">
                                    <span>Subject</span>
                                    <input
                                        value={emailDraft.subject}
                                        disabled={saving}
                                        onChange={event => editEmail({ subject: event.target.value })}
                                        placeholder="Add a subject"
                                        aria-label="Email subject"
                                        autoFocus={!emailDraft.body}
                                    />
                                </label>
                                <textarea
                                    value={emailDraft.body}
                                    disabled={saving}
                                    onChange={event => editEmail({ body: event.target.value })}
                                    rows={12}
                                    aria-label="Email body"
                                    placeholder="Write the follow-up email"
                                    autoFocus={Boolean(emailDraft.body)}
                                />
                                <ComposeFooter
                                    saving={saving}
                                    discarding={discarding === 'email'}
                                    onCancel={closeEmail}
                                    onSave={handleSaveEmail}
                                    onKeepEditing={keepEditing}
                                    onDiscard={closeEmail}
                                />
                            </div>
                        ) : meeting.emailDraft ? (
                            <article className="ks-notes-email" aria-label="Follow-up email">
                                <header className="ks-notes-email-field">
                                    <span>Subject</span>
                                    <strong>{email.subject || 'No subject'}</strong>
                                </header>
                                <div className="ks-notes-email-body">{email.body}</div>
                                <footer>
                                    <button
                                        type="button"
                                        className="ks-notes-action"
                                        data-notes-edit="email"
                                        disabled={saving}
                                        onClick={() => setEmailDraft(email, false)}
                                    >
                                        <Pencil aria-hidden="true" />
                                        Edit
                                    </button>
                                    <div>
                                        <a className="ks-button" href={mailto} target="_blank" rel="noreferrer">
                                            <Mail aria-hidden="true" />
                                            Open in email app
                                        </a>
                                        <button type="button" className={cn('ks-button ks-primary', copied === 'email' && 'is-copied')} onClick={handleCopyEmail}>
                                            {copied === 'email' ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
                                            {copied === 'email' ? 'Copied' : 'Copy email'}
                                        </button>
                                    </div>
                                </footer>
                            </article>
                        ) : (
                            <div className="ks-notes-placeholder">
                                <Mail aria-hidden="true" />
                                <p>No follow-up email yet. End a recording to generate one, or write your own.</p>
                                <button type="button" className="ks-button" data-notes-edit="email" onClick={() => setEmailDraft({ subject: '', body: '' }, false)}>
                                    <Pencil aria-hidden="true" />
                                    Write email
                                </button>
                            </div>
                        ))}
                </div>
            </div>

            <p className="sr-only" role="status" aria-live="polite">
                {announcement}
            </p>
        </section>
    );
}
