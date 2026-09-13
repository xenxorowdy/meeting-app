import React, { useEffect, useRef, useState } from 'react';
import {
    ArrowLeft,
    Check,
    Copy,
    Download,
    HelpCircle,
    Mic,
    MicOff,
    Monitor,
    Pause,
    Pencil,
    Play,
    Quote,
    Search,
    Square,
    Volume2,
    VolumeX,
    X,
} from 'lucide-react';
import { formatMs, initialsFor } from '@/lib/speakers';
import { MeetingChatPanel } from '@/components/MeetingChatPanel';
import { ResizableChatPanel } from '@/components/ResizableChatPanel';
import { RecordingPlayer } from '@/components/RecordingPlayer';
import { SummaryEditor } from '@/components/SummaryEditor';
import { LiveNotes } from '@/components/LiveNotes';
import { MarkdownText } from '@/components/MarkdownText';
import { dateLabel, durationLabel, leadParagraph, speakerColor, taskValue, turnsForIds } from './designHelpers';

export function Avatar({ name }) {
    return (
        <span className="ks-avatar" style={{ '--speaker': speakerColor(name) }}>
            {initialsFor(name)}
        </span>
    );
}

function Transcript({ turns, interimTurns = [], isRecording, citationFocus, onRenameSpeaker, isConnected }) {
    const [query, setQuery] = useState('');
    const [showSearch, setShowSearch] = useState(false);
    const [copied, setCopied] = useState(null);
    const [renaming, setRenaming] = useState(null);
    const [name, setName] = useState('');
    const [error, setError] = useState('');
    const [follow, setFollow] = useState(true);
    const end = useRef(null);
    const list = useRef(null);
    useEffect(() => {
        if (isRecording && follow) end.current?.scrollIntoView({ block: 'nearest' });
    }, [turns, interimTurns, isRecording, follow]);
    useEffect(() => {
        const ids = citationFocus?.turnIds || [];
        const target = [...(list.current?.querySelectorAll('[data-turn-id]') || [])].find(node => ids.includes(node.dataset.turnId));
        target?.scrollIntoView({ block: 'center' });
    }, [citationFocus]);
    const filtered = turns.filter(turn => !query.trim() || `${turn.speaker} ${turn.text}`.toLowerCase().includes(query.trim().toLowerCase()));
    const pending = query.trim() ? [] : interimTurns.filter(turn => turn.text);
    return (
        <div
            className="ks-transcript"
            ref={list}
            onScroll={event => {
                const el = event.currentTarget;
                setFollow(el.scrollHeight - el.scrollTop - el.clientHeight < 80);
            }}
        >
            <div className="ks-transcript-tools">
                {showSearch && (
                    <input
                        autoFocus
                        aria-label="Search transcript"
                        placeholder="Search transcript…"
                        value={query}
                        onChange={event => setQuery(event.target.value)}
                    />
                )}
                <button
                    className="ks-icon-button"
                    aria-label={showSearch ? 'Close transcript search' : 'Search transcript'}
                    onClick={() => {
                        setShowSearch(!showSearch);
                        setQuery('');
                    }}
                >
                    {showSearch ? <X /> : <Search />}
                </button>
            </div>
            {error && (
                <p className="ks-error" role="alert">
                    {error}
                </p>
            )}
            {filtered.map((turn, index) => (
                <article
                    key={turn.id || index}
                    data-turn-id={turn.id}
                    className={`ks-turn ${citationFocus?.turnIds?.includes(turn.id) ? 'ks-cited' : ''}`}
                >
                    <Avatar name={turn.speaker} />
                    <div>
                        <div className="ks-turn-heading">
                            {renaming === turn.speaker ? (
                                <form
                                    className="ks-rename"
                                    onSubmit={async event => {
                                        event.preventDefault();
                                        const result = await onRenameSpeaker(turn.speaker, name);
                                        if (result?.ok) setRenaming(null);
                                        else setError(result?.message || 'Could not rename speaker.');
                                    }}
                                >
                                    <input aria-label="Speaker name" autoFocus value={name} onChange={event => setName(event.target.value)} />
                                    <button aria-label="Save speaker name">
                                        <Check />
                                    </button>
                                    <button type="button" aria-label="Cancel speaker rename" onClick={() => setRenaming(null)}>
                                        <X />
                                    </button>
                                </form>
                            ) : (
                                <button
                                    className="ks-speaker-name"
                                    disabled={!isConnected}
                                    title="Rename speaker"
                                    onClick={() => {
                                        setRenaming(turn.speaker);
                                        setName(turn.speaker);
                                    }}
                                >
                                    {turn.speaker}
                                </button>
                            )}
                            <time>{formatMs(turn.startMs)}</time>
                            <button
                                className="ks-copy-turn"
                                aria-label={`Copy what ${turn.speaker} said`}
                                onClick={async () => {
                                    try {
                                        await navigator.clipboard.writeText(turn.text);
                                        setCopied(turn.id);
                                    } catch {
                                        setError('Could not copy this passage.');
                                    }
                                }}
                            >
                                {copied === turn.id ? <Check /> : <Copy />}
                            </button>
                        </div>
                        <p>{turn.text}</p>
                    </div>
                </article>
            ))}
            {pending.map(turn => (
                <article key={turn.id} className="ks-turn ks-turn-interim" aria-live="polite">
                    <Avatar name={turn.speaker} />
                    <div>
                        <div className="ks-turn-heading">
                            <span className="ks-speaker-name">{turn.speaker}</span>
                            <span className="ks-interim-tag">speaking…</span>
                        </div>
                        <p>{turn.text}</p>
                    </div>
                </article>
            ))}
            {!filtered.length && !pending.length && (
                <div className="ks-empty">
                    <h3>{query ? 'No matching passages' : isRecording ? 'Listening to your meeting…' : 'No transcript yet'}</h3>
                    <p>{query ? 'Try another search.' : 'Speech will appear here with speaker names and timestamps.'}</p>
                </div>
            )}
            {isRecording && !pending.length && (
                <div className="ks-listening">
                    <span className="ks-avatar" style={{ '--speaker': '#0047ab' }}>
                        ●
                    </span>
                    <span>
                        <i />
                        <i />
                        <i />
                    </span>
                </div>
            )}
            <div ref={end} />
        </div>
    );
}

function useOutsideClose(active, onClose) {
    const ref = useRef(null);
    useEffect(() => {
        if (!active) return undefined;
        const handlePointer = event => {
            if (ref.current && !ref.current.contains(event.target)) onClose();
        };
        const handleKey = event => {
            if (event.key === 'Escape') onClose();
        };
        document.addEventListener('mousedown', handlePointer);
        document.addEventListener('keydown', handleKey);
        return () => {
            document.removeEventListener('mousedown', handlePointer);
            document.removeEventListener('keydown', handleKey);
        };
    }, [active, onClose]);
    return ref;
}

function SourceCitation({ label, turns, onJump }) {
    const [open, setOpen] = useState(false);
    const ref = useOutsideClose(open, () => setOpen(false));
    if (!turns.length) return null;
    return (
        <span className="ks-cite" ref={ref}>
            <button
                type="button"
                className="ks-cite-trigger"
                aria-label={`Show ${turns.length} transcript ${turns.length === 1 ? 'passage' : 'passages'} for this point`}
                aria-expanded={open}
                onClick={() => setOpen(!open)}
            >
                <Quote />
            </button>
            {open && (
                <div className="ks-cite-pop" role="dialog">
                    <span className="ks-cite-pop-tag">Transcript summary</span>
                    <p className="ks-cite-pop-context">{label}</p>
                    {turns.map(turn => (
                        <button
                            key={turn.id}
                            type="button"
                            className="ks-cite-quote"
                            onClick={() => {
                                setOpen(false);
                                onJump(turn);
                            }}
                        >
                            <span className="ks-cite-quote-meta">
                                <b>{turn.speaker}</b>
                                <time>{formatMs(turn.startMs)}</time>
                            </span>
                            <q>{turn.text}</q>
                        </button>
                    ))}
                </div>
            )}
        </span>
    );
}

function Sections({ sections, transcript, onJump }) {
    if (!sections?.length) return null;
    return (
        <div className="ks-sections">
            {sections.map((section, sectionIndex) => (
                <section key={sectionIndex} className="ks-section">
                    <h4>{section.heading}</h4>
                    <ul>
                        {(section.bullets || []).map((bullet, bulletIndex) => (
                            <li key={bulletIndex} className="ks-bullet">
                                <div className="ks-bullet-row">
                                    <span>{bullet.text}</span>
                                    <SourceCitation label={bullet.text} turns={turnsForIds(transcript, bullet.sourceTurnIds)} onJump={onJump} />
                                </div>
                                {bullet.subBullets?.length > 0 && (
                                    <ul className="ks-sub-bullets">
                                        {bullet.subBullets.map((sub, subIndex) => (
                                            <li key={subIndex}>{sub}</li>
                                        ))}
                                    </ul>
                                )}
                            </li>
                        ))}
                    </ul>
                </section>
            ))}
        </div>
    );
}

function NextSteps({ items, transcript, onJump }) {
    if (!items?.length) return null;
    return (
        <div className="ks-next-steps">
            <h3>NEXT STEPS</h3>
            <ul>
                {items.map((raw, index) => {
                    const item = taskValue(raw);
                    return (
                        <li key={item.id || index} className="ks-bullet">
                            <div className="ks-bullet-row">
                                <span>
                                    <strong>{item.task}</strong>
                                    {item.owner && item.owner !== 'Unassigned' ? ` (${item.owner})` : ''}
                                </span>
                                <SourceCitation label={item.task} turns={turnsForIds(transcript, item.sourceTurnIds)} onJump={onJump} />
                            </div>
                        </li>
                    );
                })}
            </ul>
        </div>
    );
}

function Tasks({ meeting, onUpdate }) {
    const [newTask, setNewTask] = useState('');
    const items = meeting?.actionItems || [];
    return (
        <div className="ks-detail-scroll">
            <div className="ks-tasks">
                {items.map((raw, index) => {
                    const task = taskValue(raw);
                    return (
                        <div key={task.id || index} className="ks-task">
                            <button
                                className={`ks-task-check ${task.completed ? 'is-checked' : ''}`}
                                aria-label={`${task.completed ? 'Reopen' : 'Complete'} ${task.task}`}
                                aria-pressed={Boolean(task.completed)}
                                onClick={() =>
                                    onUpdate({ actionItems: items.map((item, i) => (i === index ? { ...task, completed: !task.completed } : item)) })
                                }
                            >
                                {task.completed && <Check />}
                            </button>
                            <span className={task.completed ? 'ks-completed' : ''}>{task.task}</span>
                            <small>{task.owner}</small>
                            {task.deadline && <time>{task.deadline}</time>}
                        </div>
                    );
                })}
                {!items.length && (
                    <div className="ks-empty">
                        <h3>No tasks yet</h3>
                        <p>Add a task or generate a summary after the meeting.</p>
                    </div>
                )}
                <form
                    className="ks-task-form"
                    onSubmit={event => {
                        event.preventDefault();
                        if (!newTask.trim()) return;
                        onUpdate({ actionItems: [...items, { id: crypto.randomUUID(), task: newTask.trim(), owner: 'You', completed: false }] });
                        setNewTask('');
                    }}
                >
                    <input aria-label="New task" placeholder="Add a task…" value={newTask} onChange={event => setNewTask(event.target.value)} />
                    <button className="ks-button ks-orange" disabled={!newTask.trim()}>
                        Add
                    </button>
                </form>
                <p className="ks-edit-hint">Task edits are kept for this session. Export to keep a copy.</p>
            </div>
        </div>
    );
}

const MEETING_TABS = [
    ['transcript', 'Transcript'],
    ['tasks', 'Tasks'],
    ['summary', 'Summary'],
    ['replay', 'Screen'],
    ['notes', 'Notes'],
];

const LIVE_TABS = ['transcript', 'notes'];

export function MeetingDetail({
    meeting,
    turns = [],
    interimTurns = [],
    initialTab,
    session,
    isConnected,
    citationFocus,
    onBack,
    onExport,
    onUpdate,
    onSelectMeeting,
    onRenameSpeaker,
    onAddNote,
    onDeleteNote,
}) {
    const [tab, setTab] = useState(initialTab || 'transcript');
    const [chatOpen, setChatOpen] = useState(false);
    const [editing, setEditing] = useState(false);
    const [title, setTitle] = useState('');
    const [advanced, setAdvanced] = useState(false);
    useEffect(() => {
        setTab(initialTab || 'transcript');
    }, [initialTab, meeting?.id]);
    useEffect(() => {
        if (citationFocus?.meetingId === meeting?.id) setTab('transcript');
    }, [citationFocus, meeting?.id]);
    const recording = session.isRecording || session.isPaused;
    useEffect(() => {
        if (recording) setTab(current => (LIVE_TABS.includes(current) ? current : 'transcript'));
    }, [recording]);
    const tabs = MEETING_TABS.filter(([value]) => !recording || LIVE_TABS.includes(value));
    const participants = [...new Set(turns.map(turn => turn.speaker))];
    const elapsed = recording ? session.durationSeconds : meeting?.durationSeconds || 0;
    const tasks = meeting?.actionItems || [];
    const level = Math.max(session.audioLevels?.mic || 0, session.audioLevels?.system || 0);
    const jumpToTurn = turn => onSelectMeeting?.(meeting, { meetingId: meeting.id, turnIds: [turn.id], startMs: turn.startMs });

    if (!meeting && !recording)
        return (
            <div className="ks-empty ks-empty-page">
                <Mic />
                <h2>Every meeting, remembered.</h2>
                <p>Record a new meeting or open one from your library.</p>
                <button className="ks-button ks-orange" disabled={!isConnected || session.isProcessing} onClick={() => session.onStart()}>
                    New Meeting
                </button>
            </div>
        );

    return (
        <div className="ks-meeting">
            <div className="ks-meeting-main">
                {recording && (
                    <section className="ks-recording-hud" aria-label="Recording controls">
                        <span className={`ks-rec ${session.isPaused ? 'is-paused' : ''}`}>
                            <i />
                            {session.isPaused ? 'PAUSED' : 'REC'}
                        </span>
                        <time>{formatMs(elapsed * 1000)}</time>
                        <div className="ks-wave" aria-label={`Audio input ${Math.round(level)} percent`}>
                            {Array.from({ length: 28 }, (_, i) => (
                                <i key={i} style={{ height: `${session.isPaused ? 3 : 3 + (level / 100) * (6 + ((i * 7) % 16))}px` }} />
                            ))}
                        </div>
                        <div className="ks-hud-caption">
                            <span>{meeting?.title || 'New meeting'}</span>
                            <div>
                                <span className="ks-hud-line" />
                                <span>
                                    {session.isPaused ? 'paused' : 'recording'}
                                    {session.recordingState?.active && session.recordingState.mode !== 'audio' ? ' · screen' : ''}
                                </span>
                            </div>
                        </div>
                        <button
                            className="ks-icon-button"
                            onClick={session.isPaused ? session.onResume : session.onPause}
                            aria-label={session.isPaused ? 'Resume recording' : 'Pause recording'}
                        >
                            {session.isPaused ? <Play /> : <Pause />}
                        </button>
                        <button className="ks-button ks-red" onClick={session.onStop}>
                            <Square />
                            Stop
                        </button>
                    </section>
                )}
                <header className="ks-meeting-header">
                    <div className="ks-meeting-title">
                        <button className="ks-meeting-back" aria-label="Back to home" onClick={onBack}>
                            <ArrowLeft />
                        </button>
                        {editing ? (
                            <form
                                onSubmit={event => {
                                    event.preventDefault();
                                    if (title.trim()) onUpdate({ title: title.trim() });
                                    setEditing(false);
                                }}
                            >
                                <input aria-label="Meeting title" autoFocus value={title} onChange={event => setTitle(event.target.value)} />
                                <button className="ks-icon-button" aria-label="Save title">
                                    <Check />
                                </button>
                            </form>
                        ) : (
                            <h2>
                                <button
                                    title="Rename meeting"
                                    onClick={() => {
                                        setTitle(meeting?.title || 'Untitled meeting');
                                        setEditing(true);
                                    }}
                                >
                                    {meeting?.title || 'Untitled meeting'}
                                </button>
                            </h2>
                        )}
                        <div className="ks-meeting-meta">
                            <time>{dateLabel(meeting?.startedAt)}</time>
                            <time>{durationLabel(elapsed)}</time>
                            <span>
                                {participants
                                    .slice(0, 3)
                                    .map(name => name.split(' ')[0])
                                    .join(', ')}
                                {participants.length > 3 ? ` +${participants.length - 3}` : ''}
                            </span>
                            {session.isProcessing && <span className="ks-accent">Generating summary…</span>}
                        </div>
                    </div>
                    <div className="ks-meeting-actions">
                        {recording && (
                            <>
                                <button
                                    className="ks-icon-button"
                                    aria-label={session.micMuted ? 'Unmute microphone' : 'Mute microphone'}
                                    aria-pressed={session.micMuted}
                                    onClick={session.onToggleMic}
                                >
                                    {session.micMuted ? <MicOff /> : <Mic />}
                                </button>
                                <button
                                    className="ks-icon-button"
                                    title={!session.systemAudioSeen ? 'No system audio detected' : 'Meeting audio'}
                                    aria-label={session.systemAudioMuted ? 'Unmute meeting audio' : 'Mute meeting audio'}
                                    aria-pressed={session.systemAudioMuted}
                                    onClick={session.onToggleSystem}
                                >
                                    {session.systemAudioMuted ? <VolumeX /> : <Volume2 />}
                                </button>
                            </>
                        )}
                        {!recording && (
                            <>
                                <button className="ks-button" onClick={onExport} disabled={!meeting}>
                                    <Download />
                                    Export
                                </button>
                                <button className="ks-button" onClick={() => setTab('replay')}>
                                    <Monitor />
                                    Screen
                                </button>
                            </>
                        )}
                        <button
                            className={`ks-button ${chatOpen ? 'ks-orange' : ''}`}
                            onClick={() => setChatOpen(!chatOpen)}
                            disabled={!meeting?.id || !isConnected}
                        >
                            <HelpCircle />
                            Ask AI
                        </button>
                    </div>
                </header>
                <div className="ks-meeting-tabs" role="tablist" aria-label="Meeting content">
                    {tabs.map(([value, label]) => (
                        <button
                            key={value}
                            id={`tab-${value}`}
                            role="tab"
                            aria-selected={tab === value}
                            aria-controls="meeting-panel"
                            onClick={() => setTab(value)}
                        >
                            {label}
                            {value === 'tasks' && <small>{tasks.filter(item => !taskValue(item).completed).length}</small>}
                            {value === 'replay' && meeting?.recording?.mode !== 'audio' && <em>HD</em>}
                        </button>
                    ))}
                </div>
                <div id="meeting-panel" role="tabpanel" aria-labelledby={`tab-${tab}`} className="ks-meeting-panel">
                    {tab === 'transcript' && (
                        <Transcript
                            turns={turns}
                            interimTurns={interimTurns}
                            isRecording={session.isRecording}
                            citationFocus={citationFocus}
                            isConnected={isConnected}
                            onRenameSpeaker={onRenameSpeaker}
                        />
                    )}
                    {tab === 'tasks' && <Tasks meeting={meeting} onUpdate={onUpdate} />}
                    {tab === 'summary' && (
                        <div className="ks-detail-scroll">
                            {advanced ? (
                                <div className="ks-summary-advanced">
                                    <button className="ks-text-button" onClick={() => setAdvanced(false)}>
                                        ← Back to summary
                                    </button>
                                    <SummaryEditor
                                        key={meeting?.id}
                                        meeting={meeting}
                                        onUpdateMeeting={onUpdate}
                                        isGenerating={session.isProcessing}
                                    />
                                </div>
                            ) : (
                                <div className="ks-summary">
                                    <div className="ks-summary-card">
                                        <header>
                                            <span>
                                                <i />
                                                AI SUMMARY
                                            </span>
                                            <button className="ks-icon-button" aria-label="Edit summary" onClick={() => setAdvanced(true)}>
                                                <Pencil />
                                            </button>
                                        </header>
                                        {meeting?.summarySections?.length > 0 ? (
                                            <>
                                                <MarkdownText markdown={leadParagraph(meeting.summaryMarkdown)} />
                                                <Sections sections={meeting.summarySections} transcript={meeting.transcript} onJump={jumpToTurn} />
                                            </>
                                        ) : (
                                            <MarkdownText
                                                markdown={
                                                    meeting?.summaryMarkdown ||
                                                    (session.isProcessing
                                                        ? 'Preparing your meeting summary…'
                                                        : 'Your summary will appear after this meeting has been processed.')
                                                }
                                            />
                                        )}
                                    </div>
                                    {meeting?.keyDecisions?.length > 0 && (
                                        <div className="ks-decisions">
                                            <h3>KEY DECISIONS</h3>
                                            {meeting.keyDecisions.map((decision, index) => (
                                                <p key={index}>• {decision}</p>
                                            ))}
                                        </div>
                                    )}
                                    <NextSteps items={meeting?.actionItems} transcript={meeting?.transcript} onJump={jumpToTurn} />
                                    <button className="ks-text-button" onClick={() => setAdvanced(true)}>
                                        Edit notes & follow-up email
                                    </button>
                                </div>
                            )}
                        </div>
                    )}
                    {tab === 'replay' && (
                        <RecordingPlayer
                            key={meeting?.id}
                            meeting={meeting}
                            citationFocus={citationFocus}
                            isConnected={isConnected}
                            onRenameSpeaker={onRenameSpeaker}
                            nameSuggestions={session.nameSuggestions}
                        />
                    )}
                    {tab === 'notes' && (
                        <div className="ks-detail-scroll">
                            <div className="ks-live-notes">
                                <LiveNotes
                                    notes={meeting?.notes || []}
                                    canWrite={recording}
                                    onAddNote={onAddNote}
                                    onDeleteNote={recording ? onDeleteNote : undefined}
                                />
                            </div>
                        </div>
                    )}
                </div>
            </div>
            <ResizableChatPanel open={chatOpen} onClose={() => setChatOpen(false)}>
                    {meeting && <MeetingChatPanel
                        scope={{ type: 'meetings', meetingIds: [meeting.id] }}
                        scopeLabel={meeting.title}
                        isLive={!meeting.endedAt}
                        isConnected={isConnected}
                        onSelectMeeting={onSelectMeeting}
                    />}
            </ResizableChatPanel>
        </div>
    );
}
