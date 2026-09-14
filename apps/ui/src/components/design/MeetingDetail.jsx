import React, { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import {
    ArrowLeft,
    Check,
    Download,
    HelpCircle,
    Mic,
    MicOff,
    Monitor,
    Pause,
    Pencil,
    Play,
    Quote,
    Sparkles,
    Square,
    Volume2,
    VolumeX,
} from 'lucide-react';
import { formatMs, initialsFor } from '@/lib/speakers';
import { TranscriptView } from '@/components/TranscriptView';
import { MeetingChatPanel } from '@/components/MeetingChatPanel';
import { ResizableChatPanel } from '@/components/ResizableChatPanel';

const RecordingPlayer = lazy(() => import('@/components/RecordingPlayer').then(module => ({ default: module.RecordingPlayer })));
const SummaryEditor = lazy(() => import('@/components/SummaryEditor').then(module => ({ default: module.SummaryEditor })));
import { LiveNotes } from '@/components/LiveNotes';
import { MarkdownText } from '@/components/MarkdownText';
import { dateLabel, durationLabel, leadParagraph, speakerColor, taskValue, turnIndex, turnsForIds } from './designHelpers';

export function Avatar({ name }) {
    return (
        <span className="ks-avatar" style={{ '--speaker': speakerColor(name) }}>
            {initialsFor(name)}
        </span>
    );
}

const EMPTY_TURNS = [];

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

function Sections({ sections, index, onJump }) {
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
                                    <SourceCitation label={bullet.text} turns={turnsForIds(index, bullet.sourceTurnIds)} onJump={onJump} />
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

function NextSteps({ items, index, onJump }) {
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
                                <SourceCitation label={item.task} turns={turnsForIds(index, item.sourceTurnIds)} onJump={onJump} />
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
                    <button className="ks-button ks-primary" disabled={!newTask.trim()}>
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

const WAVE_BARS = 36;

const WAVE_FACTORS = Array.from({ length: WAVE_BARS }, (_, index) => {
    const position = index / (WAVE_BARS - 1);
    const envelope = 0.35 + 0.65 * Math.sin(Math.PI * position);
    const jitter = 0.68 + 0.32 * (((index * 37) % 13) / 12);
    return Math.round(envelope * jitter * 1000) / 1000;
});

const WAVE_BAR_ELEMENTS = WAVE_FACTORS.map((factor, index) => <i key={index} style={{ '--factor': factor }} />);

function LevelMeter({ subscribe, paused }) {
    const node = useRef(null);

    useEffect(() => {
        const element = node.current;
        if (!element) return undefined;
        if (paused || !subscribe) {
            element.style.setProperty('--level', '0');
            return undefined;
        }
        return subscribe(({ mic, system }) => {
            element.style.setProperty('--level', String(Math.max(mic, system) / 100));
        });
    }, [subscribe, paused]);

    return (
        <div className="ks-wave" ref={node} role="img" aria-label="Live audio input level">
            {WAVE_BAR_ELEMENTS}
        </div>
    );
}

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
    onRegenerateSummary,
    onSelectMeeting,
    onRenameSpeaker,
    onAddNote,
    onDeleteNote,
}) {
    const [tab, setTab] = useState(initialTab || 'transcript');
    const [chatOpen, setChatOpen] = useState(false);
    const [chatDraft, setChatDraft] = useState(null);
    const [replayCitation, setReplayCitation] = useState(null);
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
    const screenCapture = Boolean(session.recordingState?.active) && session.recordingState.mode !== 'audio';
    const jumpToTurn = turn => onSelectMeeting?.(meeting, { meetingId: meeting.id, turnIds: [turn.id], startMs: turn.startMs });
    // A recording turns every timestamp into a seek control. The citation goes
    // straight to the player instead of through App, so the transcript tab the
    // user is reading is not rebuilt for a jump inside the same meeting.
    const seekToTurn = turn => {
        setReplayCitation({ meetingId: meeting.id, turnIds: [turn.id], startMs: turn.startMs });
        setTab('replay');
    };
    // Quoting a turn opens the meeting chat with the passage pre-filled, so the
    // question is already half-asked.
    const askAboutTurn = turn => {
        const quote = turn.text.length > 400 ? `${turn.text.slice(0, 400)}…` : turn.text;
        setChatDraft({
            key: `${turn.id}-${Date.now()}`,
            text: `At ${formatMs(turn.startMs)}, ${turn.speaker} said: “${quote}”\n\n`,
        });
        setChatOpen(true);
    };
    const sourceIndex = useMemo(() => turnIndex(meeting?.transcript), [meeting?.transcript]);
    const summarySourceIds = useMemo(() => {
        const ids = new Set();
        for (const section of meeting?.summarySections || []) {
            for (const bullet of section.bullets || []) {
                for (const id of bullet.sourceTurnIds || []) {
                    ids.add(id);
                    if (ids.size === 6) return [...ids];
                }
            }
        }
        return [...ids];
    }, [meeting?.summarySections]);

    if (!meeting && !recording)
        return (
            <div className="ks-empty ks-empty-page">
                <Mic />
                <h2>Every meeting, remembered.</h2>
                <p>Record a new meeting or open one from your library.</p>
                <button className="ks-button ks-primary" disabled={!isConnected || session.isProcessing} onClick={() => session.onStart()}>
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
                            {session.isPaused ? 'Paused' : 'Recording'}
                        </span>
                        <time aria-label="Elapsed recording time">{formatMs(elapsed * 1000)}</time>
                        <LevelMeter subscribe={session.subscribeAudioLevels} paused={session.isPaused} />
                        {screenCapture && (
                            <span className="ks-hud-chip">
                                <Monitor />
                                Screen
                            </span>
                        )}
                        <div className="ks-hud-controls">
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
                                title={!session.systemAudioSeen ? 'No meeting audio detected yet' : 'Meeting audio'}
                                aria-label={session.systemAudioMuted ? 'Unmute meeting audio' : 'Mute meeting audio'}
                                aria-pressed={session.systemAudioMuted}
                                onClick={session.onToggleSystem}
                            >
                                {session.systemAudioMuted ? <VolumeX /> : <Volume2 />}
                            </button>
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
                        </div>
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
                            className={`ks-button ${chatOpen ? 'ks-primary' : ''}`}
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
                        <TranscriptView
                            turns={turns}
                            interimTurns={interimTurns}
                            isLive={session.isRecording}
                            citationFocus={citationFocus}
                            isConnected={isConnected}
                            onRenameSpeaker={onRenameSpeaker}
                            onAsk={askAboutTurn}
                            onSeek={seekToTurn}
                            seekable={Boolean(meeting?.recording?.videoPath) && !recording}
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
                                    <Suspense fallback={<p className="ks-chat-note">Opening the editor…</p>}>
                                        <SummaryEditor
                                            key={meeting?.id}
                                            meeting={meeting}
                                            onUpdateMeeting={onUpdate}
                                            onRegenerateSummary={() => onRegenerateSummary?.(meeting?.id)}
                                            isGenerating={session.isProcessing || session.isGeneratingSummary}
                                        />
                                    </Suspense>
                                </div>
                            ) : (
                                <div className="ks-summary">
                                    <div className="ks-summary-card">
                                        <header>
                                            <span>
                                                <i />
                                                TRANSCRIPT SUMMARY
                                            </span>
                                            <button className="ks-icon-button" aria-label="Edit summary" onClick={() => setAdvanced(true)}>
                                                <Pencil />
                                            </button>
                                        </header>
                                        {meeting?.summarySections?.length > 0 ? (
                                            <>
                                                <div className="ks-summary-lead">
                                                    <MarkdownText markdown={leadParagraph(meeting.summaryMarkdown)} />
                                                    <SourceCitation
                                                        label="Representative passages for this summary"
                                                        turns={turnsForIds(sourceIndex, summarySourceIds)}
                                                        onJump={jumpToTurn}
                                                    />
                                                </div>
                                                <Sections sections={meeting.summarySections} index={sourceIndex} onJump={jumpToTurn} />
                                            </>
                                        ) : (
                                            <MarkdownText
                                                markdown={
                                                    meeting?.summaryMarkdown ||
                                                    (session.isProcessing
                                                        ? 'Preparing your meeting summary…'
                                                        : session.autoSummarize === false
                                                          ? 'Auto-summarize is off. Turn on “Summarize when a recording ends” in Settings to generate a recap.'
                                                          : 'No summary is available for this meeting yet.')
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
                                    <NextSteps items={meeting?.actionItems} index={sourceIndex} onJump={jumpToTurn} />
                                    <button className="ks-text-button" onClick={() => setAdvanced(true)}>
                                        Edit notes & follow-up email
                                    </button>
                                </div>
                            )}
                        </div>
                    )}
                    {tab === 'replay' && (
                        <Suspense fallback={<p className="ks-chat-note">Opening the recording…</p>}>
                            <RecordingPlayer
                                key={meeting?.id}
                                meeting={meeting}
                                citationFocus={replayCitation || citationFocus}
                                isConnected={isConnected}
                                onRenameSpeaker={onRenameSpeaker}
                                nameSuggestions={session.nameSuggestions}
                            />
                        </Suspense>
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
                        draft={chatDraft}
                    />}
            </ResizableChatPanel>
        </div>
    );
}
