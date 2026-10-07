import React, { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    ArrowLeft,
    Check,
    Download,
    Mic,
    MicOff,
    Monitor,
    Pause,
    Pencil,
    Play,
    Sparkles,
    Square,
    Volume2,
    VolumeX,
} from 'lucide-react';
import { formatMs, initialsFor, speakerSuggestions } from '@/lib/speakers';
import { TranscriptView } from '@/components/TranscriptView';
import { MeetingChatPanel } from '@/components/MeetingChatPanel';
import { ResizableChatPanel } from '@/components/ResizableChatPanel';
import { MeetingCommitments } from '@/components/MeetingCommitments';
import { MeetingActions } from '@/components/MeetingActions';
import { SummarySharing } from '@/components/SummarySharing';

const RecordingPlayer = lazy(() => import('@/components/RecordingPlayer').then(module => ({ default: module.RecordingPlayer })));
const SummaryEditor = lazy(() => import('@/components/SummaryEditor').then(module => ({ default: module.SummaryEditor })));
import { LiveNotes } from '@/components/LiveNotes';
import { MarkdownText } from '@/components/MarkdownText';
import { dateLabel, durationLabel, leadParagraph, readingMinutes, speakerColor, taskValue, turnIndex, turnsForIds, withoutNextSteps } from './designHelpers';

export function Avatar({ name }) {
    return (
        <span className="ks-avatar" style={{ '--speaker': speakerColor(name) }}>
            {initialsFor(name)}
        </span>
    );
}

const EMPTY_TURNS = [];

function TimeLink({ turns, label, onJump }) {
    if (!turns.length) return null;
    const time = formatMs(turns[0].startMs);
    return (
        <button type="button" className="ks-brief-time" aria-label={`Open the transcript at ${time} for ${label}`} onClick={() => onJump(turns)}>
            {time}
        </button>
    );
}

function BriefPoints({ sections, decisions, index, onJump }) {
    const rows = [
        ...(sections || []).map(section => ({
            label: section.heading,
            items: (section.bullets || []).map(bullet => ({
                text: bullet.text,
                subBullets: bullet.subBullets || [],
                turns: turnsForIds(index, bullet.sourceTurnIds),
            })),
        })),
        { label: 'Decisions', items: (decisions || []).map(text => ({ text, subBullets: [], turns: [] })) },
    ].filter(row => row.items.length);
    if (!rows.length) return null;
    return (
        <div className="ks-brief-points">
            {rows.map((row, rowIndex) => (
                <section key={rowIndex} className="ks-brief-point">
                    <h4>{row.label}</h4>
                    <ul>
                        {row.items.map((item, itemIndex) => (
                            <li key={itemIndex}>
                                <p>
                                    {item.text}
                                    <TimeLink turns={item.turns} label={item.text} onJump={onJump} />
                                </p>
                                {item.subBullets.length > 0 && (
                                    <ul className="ks-brief-sub">
                                        {item.subBullets.map((sub, subIndex) => (
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

function NextSteps({ meeting, onUpdate }) {
    const [draft, setDraft] = useState('');
    const [saving, setSaving] = useState(false);
    const items = meeting?.actionItems || [];
    const tasks = items.map(taskValue);
    const doneCount = tasks.filter(task => task.completed).length;
    const notes = meeting?.notes || [];
    const save = async actionItems => {
        if (saving) return false;
        setSaving(true);
        try { return (await onUpdate({ actionItems }))?.ok !== false; }
        finally { setSaving(false); }
    };
    return (
        <section className="ks-brief-steps" aria-labelledby="next-steps-title">
            <header>
                <h3 id="next-steps-title">Next steps</h3>
                {tasks.length > 0 && (
                    <span>
                        {doneCount} of {tasks.length} done
                    </span>
                )}
            </header>
            {tasks.length > 0 && (
                <ul>
                    {tasks.map((task, taskIndex) => (
                        <li key={task.id || taskIndex}>
                            <label className={`ks-brief-task${task.completed ? ' is-done' : ''}`}>
                                <input
                                    type="checkbox"
                                    checked={Boolean(task.completed)}
                                    disabled={saving}
                                    onChange={() => save(items.map((item, i) => (i === taskIndex ? { ...task, completed: !task.completed } : item)))}
                                />
                                <span>{task.task}</span>
                                {task.deadline && task.deadline !== 'TBD' && <time>{task.deadline}</time>}
                                {task.owner && task.owner !== 'Unassigned' && (
                                    <small title={task.owner}>{task.owner === 'You' ? 'You' : initialsFor(task.owner)}</small>
                                )}
                            </label>
                        </li>
                    ))}
                </ul>
            )}
            <form
                className="ks-brief-add"
                onSubmit={async event => {
                    event.preventDefault();
                    if (!draft.trim() || saving) return;
                    if (await save([...items, { id: crypto.randomUUID(), task: draft.trim(), owner: 'You', completed: false }])) setDraft('');
                }}
            >
                <input
                    aria-label="Add a next step"
                    placeholder={tasks.length ? 'Add another next step…' : 'No next steps yet. Add one…'}
                    value={draft}
                    disabled={saving}
                    onChange={event => setDraft(event.target.value)}
                />
            </form>
            {notes.length > 0 && (
                <div className="ks-brief-notes">
                    <h4>Notes</h4>
                    <ul>
                        {notes.map(note => (
                            <li key={note.id}>
                                <time>{formatMs(note.atMs)}</time>
                                <p>{note.text}</p>
                            </li>
                        ))}
                    </ul>
                </div>
            )}
        </section>
    );
}

const REVIEW_TABS = [
    ['summary', 'Summary'],
    ['transcript', 'Transcript'],
    ['commitments', 'Commitments'],
    ['actions', 'Actions'],
    ['replay', 'Recording'],
];

const LIVE_TABS = [
    ['transcript', 'Transcript'],
    ['notes', 'Notes'],
];

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

function ElapsedClock({ startedAt, fallbackSeconds }) {
    const [now, setNow] = useState(() => Date.now());

    useEffect(() => {
        if (!startedAt) return undefined;
        const tick = () => setNow(Date.now());
        tick();
        const timer = setInterval(tick, 1000);
        return () => clearInterval(timer);
    }, [startedAt]);

    const seconds = startedAt ? Math.max(0, Math.floor((now - startedAt) / 1000)) : fallbackSeconds;
    return <time aria-label="Elapsed recording time">{formatMs(seconds * 1000)}</time>;
}

export function MeetingDetail({
    onUpgrade,
    meeting,
    folderName,
    turns = [],
    interimTurns = [],
    initialTab,
    session,
    isConnected,
    citationFocus,
    onBack,
    onExport,
    onUpdate,
    onUpdateCommitments,
    onUpdatePostMeetingAction,
    onActionSettings,
    onRegenerateSummary,
    onSelectMeeting,
    onRenameSpeaker,
    onChangeTurnSpeaker,
    onAddNote,
    onDeleteNote,
}) {
    const [tab, setTab] = useState(initialTab || 'transcript');
    const [chatOpen, setChatOpen] = useState(true);
    const [chatDraft, setChatDraft] = useState(null);
    const [replayCitation, setReplayCitation] = useState(null);
    const [editing, setEditing] = useState(false);
    const [title, setTitle] = useState('');
    const [savingTitle, setSavingTitle] = useState(false);
    const [advanced, setAdvanced] = useState(false);
    useEffect(() => {
        setTab(initialTab || 'transcript');
    }, [initialTab, meeting?.id]);
    useEffect(() => {
        if (citationFocus?.meetingId === meeting?.id) setTab('transcript');
    }, [citationFocus, meeting?.id]);
    const recording = session.isRecording || session.isPaused;
    // The microphone is effectively muted from either side: the app's own
    // toggle, or the meeting client (reported by the browser extension).
    const micMuted = session.micMuted || session.clientMicMuted;
    const tabs = recording ? LIVE_TABS : REVIEW_TABS;
    const activeTab = tabs.some(([value]) => value === tab) ? tab : tabs[0][0];
    const participants = [...new Set(turns.map(turn => turn.speaker))];
    const suggestSpeakers = useCallback(
        target => speakerSuggestions({ turns, metadata: meeting?.metadata, roster: recording ? session.liveRoster : [], ...target }),
        [turns, meeting?.metadata, recording, session.liveRoster]
    );
    const elapsed = recording ? session.durationSeconds : meeting?.durationSeconds || 0;
    const screenCapture = Boolean(session.recordingState?.active) && session.recordingState.mode !== 'audio';
    const jumpToTurns = sources => onSelectMeeting?.(meeting, { meetingId: meeting.id, turnIds: sources.map(turn => turn.id), startMs: sources[0].startMs });
    const meetingId = meeting?.id;
    // A recording turns every timestamp into a seek control. The citation goes
    // straight to the player instead of through App, so the transcript tab the
    // user is reading is not rebuilt for a jump inside the same meeting.
    const seekToTurn = useCallback(
        turn => {
            setReplayCitation({ meetingId, turnIds: [turn.id], startMs: turn.startMs });
            setTab('replay');
        },
        [meetingId]
    );
    // Quoting a turn opens the meeting chat with the passage pre-filled, so the
    // question is already half-asked.
    const askAboutTurn = useCallback(turn => {
        const quote = turn.text.length > 400 ? `${turn.text.slice(0, 400)}…` : turn.text;
        setChatDraft({
            key: `${turn.id}-${Date.now()}`,
            text: `At ${formatMs(turn.startMs)}, ${turn.speaker} said: “${quote}”\n\n`,
        });
        setChatOpen(true);
    }, []);
    const sourceIndex = useMemo(() => turnIndex(meeting?.transcript), [meeting?.transcript]);
    const hasSections = meeting?.summarySections?.length > 0;
    const summaryText = hasSections
        ? leadParagraph(meeting.summaryMarkdown)
        : meeting?.actionItems?.length
          ? withoutNextSteps(meeting?.summaryMarkdown)
          : meeting?.summaryMarkdown;

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
        <div className={`ks-meeting${recording ? ' ks-meeting-live' : ' ks-meeting-review'}`}>
            <div className="ks-meeting-main">
                <header className="ks-meeting-header">
                    <div className="ks-meeting-title">
                        <button className="ks-meeting-back" aria-label="Back to home" onClick={onBack}>
                            <ArrowLeft />
                        </button>
                        {!recording && <p className="ks-meeting-eyebrow">{folderName || 'Meetings'} / Meeting detail</p>}
                        {editing ? (
                            <form
                                onSubmit={async event => {
                                    event.preventDefault();
                                    if (!title.trim() || savingTitle) return;
                                    setSavingTitle(true);
                                    try {
                                        if ((await onUpdate({ title: title.trim() }))?.ok !== false) setEditing(false);
                                    } finally { setSavingTitle(false); }
                                }}
                            >
                                <input
                                    aria-label="Meeting title"
                                    autoFocus
                                    disabled={savingTitle}
                                    maxLength={200}
                                    value={title}
                                    onChange={event => setTitle(event.target.value)}
                                    onKeyDown={event => {
                                        if (event.key === 'Escape') {
                                            event.preventDefault();
                                            setEditing(false);
                                        }
                                    }}
                                />
                                <button className="ks-icon-button" disabled={savingTitle || !title.trim()} aria-label="Save title">
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
                            {!recording && <time>{durationLabel(elapsed)}</time>}
                            {recording ? (
                                <span>
                                    {participants
                                        .slice(0, 3)
                                        .map(name => name.split(' ')[0])
                                        .join(', ')}
                                    {participants.length > 3 ? ` +${participants.length - 3}` : ''}
                                </span>
                            ) : (
                                participants.length > 0 && (
                                    <span title={participants.join(', ')}>
                                        {participants.length} {participants.length === 1 ? 'speaker' : 'speakers'}
                                    </span>
                                )
                            )}
                            {session.isProcessing && <span className="ks-accent">{session.stopFailed ? 'Save pending' : 'Generating summary…'}</span>}
                        </div>
                    </div>
                    <div className="ks-meeting-actions">
                        {!recording && (
                            <button className="ks-button ks-meeting-export" onClick={onExport} disabled={!meeting}>
                                <Download />
                                Export brief
                            </button>
                        )}
                        <button
                            className={`ks-button ${chatOpen ? 'ks-primary' : ''}`}
                            onClick={() => setChatOpen(!chatOpen)}
                            aria-expanded={chatOpen}
                            disabled={!meeting?.id || !isConnected}
                        >
                            <Sparkles />
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
                            aria-selected={activeTab === value}
                            aria-controls="meeting-panel"
                            onClick={() => setTab(value)}
                        >
                            {label}
                        </button>
                    ))}
                </div>
                <div id="meeting-panel" role="tabpanel" aria-labelledby={`tab-${activeTab}`} className="ks-meeting-panel">
                    {activeTab === 'transcript' && (
                        <TranscriptView
                            turns={turns}
                            interimTurns={interimTurns}
                            isLive={session.isRecording}
                            isPaused={session.isPaused}
                            citationFocus={citationFocus}
                            isConnected={isConnected}
                            onRenameSpeaker={onRenameSpeaker}
                            onChangeTurnSpeaker={onChangeTurnSpeaker}
                            suggestSpeakers={suggestSpeakers}
                            onAsk={askAboutTurn}
                            onSeek={seekToTurn}
                            seekable={Boolean(meeting?.recording?.videoPath) && !recording}
                        />
                    )}
                    {activeTab === 'summary' && (
                        <div className="ks-detail-scroll">
                            {advanced ? (
                                <div className="ks-summary-advanced">
                                    <button className="ks-notes-back" onClick={() => setAdvanced(false)}>
                                        <ArrowLeft aria-hidden="true" />
                                        Back to brief
                                    </button>
                                    <Suspense fallback={<p className="ks-chat-note">Opening the editor…</p>}>
                                        <SummaryEditor
                                            key={meeting?.id}
                                            meeting={meeting}
                                            people={participants}
                                            onUpdateMeeting={onUpdate}
                                            onRegenerateSummary={() => onRegenerateSummary?.(meeting?.id)}
                                            isGenerating={session.isProcessing || session.isGeneratingSummary}
                                        />
                                    </Suspense>
                                </div>
                            ) : (
                                <article className="ks-brief">
                                    <div className="ks-brief-kicker">
                                        <span>Meeting brief</span>
                                        {meeting?.summaryMarkdown && <span>{readingMinutes(meeting.summaryMarkdown)} min read</span>}
                                    </div>
                                    <div className="ks-brief-lead">
                                        <MarkdownText
                                            markdown={
                                                summaryText ||
                                                (session.isProcessing
                                                    ? 'Preparing your meeting summary…'
                                                    : session.autoSummarize === false
                                                      ? 'Auto-summarize is off. Turn on “Summarize when a recording ends” in Settings to generate a recap.'
                                                      : 'No summary is available for this meeting yet.')
                                            }
                                        />
                                    </div>
                                    <BriefPoints
                                        sections={hasSections ? meeting.summarySections : []}
                                        decisions={meeting?.keyDecisions}
                                        index={sourceIndex}
                                        onJump={jumpToTurns}
                                    />
                                    <NextSteps meeting={meeting} onUpdate={onUpdate} />
                                    <footer className="ks-brief-footer">
                                        <p>{meeting?.summaryMarkdown ? 'AI-generated from this meeting. Review important details.' : ''}</p>
                                        {meeting?.summaryMarkdown && <SummarySharing key={meeting.id} meeting={meeting} isConnected={isConnected} disabled={session.isProcessing || session.isGeneratingSummary} onUpdate={onUpdatePostMeetingAction} onSettings={onActionSettings} />}
                                        <button className="ks-summary-edit" onClick={() => setAdvanced(true)}>
                                            <Pencil /> Edit summary & follow-up email
                                        </button>
                                    </footer>
                                </article>
                            )}
                        </div>
                    )}
                    {activeTab === 'actions' && (
                        <MeetingActions key={meeting?.id} meeting={meeting} isConnected={isConnected}
                            disabled={session.isProcessing || session.isGeneratingSummary}
                            onUpdate={onUpdatePostMeetingAction} onSettings={onActionSettings}
                            onSource={item => {
                                setTab('transcript');
                                onSelectMeeting?.(meeting, { meetingId: meeting.id, turnIds: item.sourceTurnIds, startMs: item.startMs, preferTranscript: true });
                            }} />
                    )}
                    {activeTab === 'commitments' && (
                        <MeetingCommitments
                            key={meeting?.id}
                            meeting={meeting}
                            isConnected={isConnected}
                            disabled={session.isProcessing || session.isGeneratingSummary}
                            onUpdate={onUpdateCommitments}
                            onSource={candidate => {
                                setTab('transcript');
                                onSelectMeeting?.(meeting, { meetingId: meeting.id, turnIds: candidate.sourceTurnIds, startMs: candidate.startMs, preferTranscript: true });
                            }}
                        />
                    )}
                    {activeTab === 'replay' && (
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
                    {activeTab === 'notes' && (
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
                {recording && (
                    <section className="ks-recording-hud" aria-label="Recording controls">
                        <span className={`ks-rec ${session.isPaused ? 'is-paused' : ''}`}>
                            <i />
                            {session.isPaused ? 'Paused' : 'Recording'}
                        </span>
                        <ElapsedClock startedAt={meeting?.startedAt} fallbackSeconds={elapsed} />
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
                                aria-label={micMuted ? 'Unmute microphone' : 'Mute microphone'}
                                aria-pressed={micMuted}
                                title={
                                    session.clientMicMuted && !session.micMuted
                                        ? 'Muted in the meeting client — your voice is not being recorded. Unmute there to record it.'
                                        : undefined
                                }
                                onClick={session.onToggleMic}
                            >
                                {micMuted ? <MicOff /> : <Mic />}
                            </button>
                            <button
                                className="ks-icon-button"
                                title={session.systemAudioError || (!session.systemAudioSeen ? 'No meeting audio detected yet' : 'Meeting audio')}
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
            </div>
            <ResizableChatPanel open={chatOpen} onClose={() => setChatOpen(false)}>
                    {panelControls => meeting && <MeetingChatPanel
                        {...panelControls}
                        scope={{ type: 'meetings', meetingIds: [meeting.id] }}
                        scopeLabel={meeting.title}
                        isLive={!meeting.endedAt}
                        isConnected={isConnected}
                        onSelectMeeting={onSelectMeeting}
                        draft={chatDraft}
                        onClose={() => setChatOpen(false)}
                        onUpgrade={onUpgrade}
                    />}
            </ResizableChatPanel>
        </div>
    );
}
