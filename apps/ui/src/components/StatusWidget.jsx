import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { AppWindow, ArrowDown, ArrowUp, AudioLines, ChevronDown, ChevronUp, CircleCheck, CloudOff, LoaderCircle, MessageCircle, Mic, MicOff, Pause, Play, Sparkles, Square, Volume2, VolumeX, X } from 'lucide-react';
import { MarkdownText } from '@/components/MarkdownText';
import { TooltipProvider } from '@/components/ui/tooltip';
import { JumpingBalls } from '@/components/JumpingBalls';
import { StreamingText } from '@/components/StreamingText';
import { LevelHistory } from '@/components/widget/LevelHistory';
import { useLiveStatus } from '@/hooks/useLiveStatus';
import { useMeetingChat } from '@/hooks/useMeetingChat';
import { citationTime } from '@/lib/chat';
import { useTheme } from '@/lib/theme';
import { CallDetectedPrompt } from '@/components/CallDetectedPrompt';

const shell = globalThis.kesamiWidget || null;

function formatClock(totalSeconds) {
    const seconds = Math.max(0, Math.floor(totalSeconds));
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const pad = value => String(value).padStart(2, '0');
    return hours > 0 ? `${hours}:${pad(minutes % 60)}:${pad(seconds % 60)}` : `${pad(minutes)}:${pad(seconds % 60)}`;
}

// Each state gets its own glyph, not just its own colour: the waveform used to stand for both
// "recording" and "transcribing", which read as still listening after the meeting had ended.
// `icon: null` is the live level meter.
const STATUS = {
    recording: { label: 'Recording', modifier: 'is-recording', icon: null },
    paused: { label: 'Paused', modifier: 'is-paused', icon: Pause },
    processing: { label: 'Transcribing', modifier: 'is-processing', balls: true, icon: LoaderCircle },
    completed: { label: 'Meeting ended', modifier: 'is-completed', icon: CircleCheck },
    idle: { label: 'Ready', modifier: 'is-idle', icon: AudioLines },
};

function describe(connection, sessionState) {
    if (connection !== 'online') {
        return {
            label: connection === 'connecting' ? 'Connecting' : 'Offline',
            modifier: 'is-offline',
            balls: connection === 'connecting',
            icon: connection === 'connecting' ? LoaderCircle : CloudOff,
        };
    }
    return STATUS[sessionState] || STATUS.idle;
}

// The collapsed pill's answer to "is it hearing us?": four bars following the louder stream. Levels
// arrive once a frame, so the bars are written straight to the DOM (see lib/levels) rather than state.
const METER_WEIGHTS = [0.55, 1, 0.75, 0.45];

function LiveMeter({ subscribe, active }) {
    const ref = useRef(null);

    useEffect(() => {
        const bars = ref.current ? [...ref.current.children] : [];
        const paint = level => bars.forEach((bar, i) => bar.style.setProperty('--ksw-level', (level * METER_WEIGHTS[i]).toFixed(3)));
        if (!active || !subscribe) {
            paint(0);
            return undefined;
        }
        // Same curve as LevelHistory: ignore the noise floor, then lift quiet speech so it visibly moves.
        const unsubscribe = subscribe(({ mic, system }) => paint(Math.min(1, Math.sqrt(Math.max(0, Math.max(mic, system) - 1) / 100) * 1.8)));
        return () => {
            unsubscribe();
            paint(0);
        };
    }, [subscribe, active]);

    return (
        <span ref={ref} className="ksw-meter">
            <i />
            <i />
            <i />
            <i />
        </span>
    );
}

function initials(name) {
    const parts = String(name || '')
        .trim()
        .split(/\s+/)
        .filter(Boolean);
    if (parts.length === 0) return 'S';
    if (parts.length === 1) {
        const word = parts[0];
        return (/\d/.test(word) ? word.slice(0, 2) : word.slice(0, 1)).toUpperCase();
    }
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function useShellState() {
    const [state, setState] = useState(null);

    useEffect(() => shell?.onState(setState), []);

    return state;
}

function TranscriptFeed({ turns, interimTurns, visible, state, connection }) {
    const scrollRef = useRef(null);
    const followRef = useRef(true);
    const [following, setFollowing] = useState(true);
    const pending = interimTurns.filter(turn => turn.text);
    const hasText = turns.length > 0 || pending.length > 0;
    const emptyCopy = connection !== 'online'
        ? ['Waiting for connection', 'Your transcript will appear when Kesami reconnects.']
        : state === 'paused'
            ? ['Recording is paused', 'Resume recording to capture the conversation.']
            : state === 'recording'
                ? ['Ready when you speak', 'The conversation will appear here as it is transcribed.']
                : state === 'completed'
                    ? ['No transcript available', 'This meeting has no captured conversation to show.']
                    : state === 'processing'
                        ? ['Finishing your transcript', 'The captured conversation is being processed.']
                        : ['No transcript yet', 'Captured conversation will appear here.'];

    const followLatest = () => {
        followRef.current = true;
        setFollowing(true);
        if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    };

    useLayoutEffect(() => {
        if (visible && followRef.current && scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }, [turns, pending.map(turn => turn.text).join(''), visible]);

    return (
        <div className="ksw-transcript-feed">
            <div className="ksw-transcript-scroll" ref={scrollRef} tabIndex={0} aria-label="Meeting transcript" onScroll={event => {
                const node = event.currentTarget;
                const next = node.scrollHeight - node.scrollTop - node.clientHeight < 40;
                followRef.current = next;
                setFollowing(next);
            }}>
            {!hasText && <div className="ksw-empty-state"><AudioLines aria-hidden="true" /><h2>{emptyCopy[0]}</h2><p>{emptyCopy[1]}</p></div>}
            {[...turns, ...pending].map(turn => (
                <div
                    key={turn.id}
                    className={turn.interim ? 'ks-widget-turn is-interim' : 'ks-widget-turn'}
                    data-stream={turn.stream === 'mic' ? 'mic' : 'system'}
                >
                    <span className="ks-widget-avatar" aria-hidden="true">
                        {initials(turn.speaker)}
                    </span>
                    <span className="ks-widget-speaker">{turn.speaker}</span>
                    {Number.isFinite(turn.startMs) && <time className="ksw-turn-time">{citationTime(turn.startMs)}</time>}
                    <p className="ks-widget-text">
                        <StreamingText text={turn.text} stream={Boolean(turn.interim)} />
                        {turn.interim && <JumpingBalls size="sm" className="ml-1.5 align-middle" />}
                    </p>
                </div>
            ))}
            </div>
            {!following && hasText && <button type="button" className="ksw-follow" onClick={followLatest}><ArrowDown aria-hidden="true" /> Jump to latest</button>}
        </div>
    );
}

const ASK_STARTERS = [
    ['Catch me up', 'Summarize the discussion so far'],
    ['Decisions so far', 'What decisions have we made so far?'],
    ['Next steps', 'What next steps have been discussed?'],
];

function WidgetAsk({ chat, connection, isLive, visible }) {
    const logRef = useRef(null);
    const composerRef = useRef(null);
    const disabled = connection !== 'online' || chat.loading || chat.busy || chat.requiresPro;
    const send = () => { if (!disabled) chat.send(); };

    useLayoutEffect(() => {
        const input = composerRef.current;
        if (!input || !visible) return;
        const fit = () => {
            input.style.height = 'auto';
            input.style.height = `${Math.min(88, input.scrollHeight)}px`;
        };
        fit();
        // The native window expands after this view mounts; remeasure at its final width.
        let measuredWidth = -1;
        const observer = new ResizeObserver(([entry]) => {
            if (entry.contentRect.width === measuredWidth) return;
            measuredWidth = entry.contentRect.width;
            fit();
        });
        observer.observe(input);
        return () => observer.disconnect();
    }, [chat.question, visible]);

    useLayoutEffect(() => {
        if (!visible) return;
        if (logRef.current) logRef.current.scrollTop = chat.messages.length || chat.busy ? logRef.current.scrollHeight : 0;
    }, [chat.messages, chat.busy, visible]);

    return (
        <div className="ksw-ask">
            <div className="ksw-ask-log" ref={logRef} tabIndex={0} aria-label="Meeting questions and answers" aria-live="polite">
                {chat.loading && <div className="ksw-thinking" role="status"><JumpingBalls size="sm" /> Loading your conversation…</div>}
                {!chat.messages.length && !chat.busy && !chat.loading && (
                    <div className="ksw-ask-intro">
                        <div className="ksw-ask-intro-heading">
                            <span className="ksw-ask-symbol"><Sparkles aria-hidden="true" /></span>
                            <div className="ksw-ask-intro-copy">
                                <h2>Ask about your meeting</h2>
                                <p>Answers from the conversation so far.</p>
                            </div>
                        </div>
                        <div className="ksw-starters">
                            {ASK_STARTERS.map(([label, question]) => (
                                <button key={label} type="button" disabled={disabled} onClick={() => chat.send(question)}>
                                    {label}<ArrowUp aria-hidden="true" />
                                </button>
                            ))}
                        </div>
                    </div>
                )}
                {chat.messages.map((message, index) => (
                    <div key={`${message.requestId || index}-${message.role}`} className={`ksw-message is-${message.role}`}>
                        {message.role === 'assistant' && <span className="ksw-message-label"><Sparkles aria-hidden="true" /> Kesami</span>}
                        {message.role === 'user' ? <p>{message.content}</p> : (
                            <>
                                <TooltipProvider delayDuration={150}>
                                    <MarkdownText
                                        markdown={message.content || ''}
                                        className="ksw-answer"
                                        citations={message.citations || []}
                                        onOpenCitation={citation => {
                                            const sources = [...(logRef.current?.querySelectorAll('.ksw-sources') || [])].find(item => item.dataset.messageIndex === String(index));
                                            if (!sources) return;
                                            sources.open = true;
                                            const target = [...sources.querySelectorAll('.ksw-source')].find(item => item.dataset.citation === String(citation.number));
                                            (target || sources).scrollIntoView({ block: 'nearest' });
                                        }}
                                    />
                                </TooltipProvider>
                                {message.coverage?.live && <p className="ksw-answer-meta">Based on audio captured {Number.isFinite(message.coverage.capturedThroughMs) ? `through ${citationTime(message.coverage.capturedThroughMs)}` : 'when asked'} · Meeting in progress</p>}
                                {message.citations?.length > 0 && (
                                    <details className="ksw-sources" data-message-index={index}>
                                        <summary>View sources ({message.citations.length})</summary>
                                        {message.citations.map(citation => (
                                            <div key={citation.number} className="ksw-source" data-citation={citation.number}>
                                                <strong>{citation.title || 'Meeting'}{Number.isFinite(citation.startMs) ? ` · ${citationTime(citation.startMs)}` : ''}</strong>
                                                <p>{citation.available === false ? 'This source is no longer available.' : citation.excerpt}</p>
                                            </div>
                                        ))}
                                    </details>
                                )}
                            </>
                        )}
                    </div>
                ))}
                {chat.busy && <div className="ksw-thinking" role="status"><JumpingBalls size="sm" /> Reading the meeting transcript…</div>}
            </div>
            <div className="ksw-ask-bottom">
                {chat.requiresPro && <p className="ksw-ask-notice" role="alert">Meeting AI requires Pro. Open Kesami to manage your plan.</p>}
                {chat.error && !chat.requiresPro && <p className="ksw-ask-notice" role="alert">{chat.error} <button type="button" disabled={disabled} onClick={() => chat.send()}>Retry</button></p>}
                <form className="ksw-composer" onSubmit={event => { event.preventDefault(); send(); }}>
                    <textarea
                        ref={composerRef}
                        value={chat.question}
                        onChange={event => chat.setQuestion(event.target.value)}
                        onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); send(); } }}
                        placeholder={isLive ? 'Ask about the meeting so far…' : 'Ask about this meeting…'}
                        aria-label="Ask a question about this meeting"
                        maxLength={4000}
                        rows={1}
                        disabled={chat.requiresPro}
                    />
                    {chat.busy ? <button type="button" className="ksw-send" onClick={chat.cancel} aria-label="Cancel question"><Square aria-hidden="true" /></button>
                        : <button type="submit" className="ksw-send" disabled={disabled || !chat.question.trim()} aria-label="Send question"><ArrowUp aria-hidden="true" /></button>}
                </form>
                <p className="ksw-ask-hint">{connection !== 'online' ? 'Reconnect to ask a question' : 'Uses this meeting’s transcript · Enter to ask'}</p>
            </div>
        </div>
    );
}

export function StatusWidget() {
    const { connection, sessionState, meeting, turns, interimTurns, durationSeconds, subscribeAudioLevels } = useLiveStatus();
    const shellState = useShellState();
    const [theme] = useTheme();
    const [expanded, setExpanded] = useState(false);
    const [view, setView] = useState('transcript');
    const chat = useMeetingChat({ type: 'meetings', meetingIds: meeting?.id ? [meeting.id] : [] }, connection === 'online' && Boolean(meeting?.id));

    const state = shellState?.sessionState || sessionState;
    const status = describe(connection, state);
    const title = shellState?.title || meeting?.title || 'Untitled meeting';
    const isLive = state === 'recording' || state === 'paused';
    const canControl = Boolean(shellState?.canControl) && isLive;
    const micMuted = Boolean(shellState?.micMuted);
    const systemAudioMuted = Boolean(shellState?.systemAudioMuted);
    const isPaused = state === 'paused';
    const listening = connection === 'online' && state === 'recording';

    useEffect(() => {
        shell?.setExpanded(expanded);
    }, [expanded]);

    useEffect(() => { if (shellState?.callPrompt?.id) setExpanded(false); }, [shellState?.callPrompt?.id]);

    useEffect(() => { setView('transcript'); }, [meeting?.id]);

    const command = useCallback(action => {
        shell?.sendCommand(action);
    }, []);

    const open = nextView => { setView(nextView); setExpanded(true); };
    const navigateTabs = event => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const next = event.key === 'Home' ? 'transcript' : event.key === 'End' ? 'ask' : view === 'ask' ? 'transcript' : 'ask';
        setView(next);
        document.getElementById(`ksw-${next}-tab`)?.focus();
    };

    if (shellState?.callPrompt && ['idle', 'completed', 'error'].includes(state)) {
        return <CallDetectedPrompt key={shellState.callPrompt.id} prompt={shellState.callPrompt} theme={theme} shell={shell} />;
    }

    if (!expanded) {
        const StatusIcon = status.icon;
        return (
            <div className="ks-app ks-widget is-collapsed" data-theme={theme}>
                <div className={`ksw-pill ${status.modifier}`}>
                    <button type="button" className="ksw-pill-main" onClick={() => open('transcript')} aria-expanded="false" aria-label={`${status.label} — ${title}. Show the meeting widget`} title={isLive ? undefined : title}>
                        <span className="ksw-pill-status" aria-hidden="true">
                            {StatusIcon ? <StatusIcon className={StatusIcon === LoaderCircle ? 'ksw-spin' : undefined} /> : <LiveMeter subscribe={subscribeAudioLevels} active={listening} />}
                        </span>
                        <span className="ksw-pill-copy"><strong>{status.label}</strong><small>{isLive ? formatClock(durationSeconds) : title}</small></span>
                        <ChevronUp className="ksw-pill-chevron" aria-hidden="true" />
                    </button>
                    <span className="ksw-pill-divider" aria-hidden="true" />
                    <button type="button" className="ksw-pill-ask" onClick={() => open('ask')} aria-label="Ask about this meeting" disabled={!meeting?.id || connection !== 'online'}><Sparkles aria-hidden="true" /> Ask</button>
                    {canControl && <button type="button" className="ksw-pill-stop" onClick={() => command('stop')} aria-label="Stop the meeting" title="Stop meeting"><Square aria-hidden="true" /></button>}
                </div>
            </div>
        );
    }

    return (
        <div className="ks-app ks-widget is-expanded" data-theme={theme}>
            <header className="ksw-header">
                <span className="ksw-mark" aria-hidden="true"><AudioLines /></span>
                <div className="ksw-heading"><span>Kesami</span><strong title={title}>{title}</strong></div>
                <button type="button" className="ksw-header-button" onClick={() => shell?.openMain()} aria-label="Open Kesami" title="Open Kesami"><AppWindow aria-hidden="true" /></button>
                <button type="button" className="ksw-header-button" onClick={() => setExpanded(false)} aria-label="Collapse widget"><ChevronDown aria-hidden="true" /></button>
                <button type="button" className="ksw-header-button" onClick={() => shell?.hide()} aria-label="Hide the widget until the app restarts"><X aria-hidden="true" /></button>
            </header>

            <div className="ksw-activity">
                <div className={`ksw-state ${status.modifier}`}>{status.balls ? <JumpingBalls size="sm" /> : <i />}{status.label}</div>
                <span className="ksw-timer">{formatClock(durationSeconds)}</span>
                <div className="ksw-wave" aria-hidden="true"><LevelHistory subscribe={subscribeAudioLevels} active={listening} /></div>
            </div>

            <nav className="ksw-tabs" role="tablist" aria-label="Widget views" onKeyDown={navigateTabs}>
                <button type="button" role="tab" tabIndex={view === 'transcript' ? 0 : -1} id="ksw-transcript-tab" aria-controls="ksw-transcript-panel" aria-selected={view === 'transcript'} className={view === 'transcript' ? 'is-active' : ''} onClick={() => setView('transcript')}><AudioLines aria-hidden="true" /> Transcript</button>
                <button type="button" role="tab" tabIndex={view === 'ask' ? 0 : -1} id="ksw-ask-tab" aria-controls="ksw-ask-panel" aria-selected={view === 'ask'} className={view === 'ask' ? 'is-active' : ''} onClick={() => setView('ask')}><Sparkles aria-hidden="true" /> Ask Kesami</button>
            </nav>

            {connection !== 'online' && <p className="ksw-connection-notice" role="status">Reconnecting to Kesami…</p>}

            <main className="ksw-content">
                <div className="ksw-transcript" id="ksw-transcript-panel" role="tabpanel" aria-labelledby="ksw-transcript-tab" hidden={view !== 'transcript'}>
                    <TranscriptFeed key={meeting?.id || 'empty'} turns={turns} interimTurns={interimTurns} state={state} connection={connection} visible={view === 'transcript'} />
                </div>
                <div className="ksw-ask-host" id="ksw-ask-panel" role="tabpanel" aria-labelledby="ksw-ask-tab" hidden={view !== 'ask'}>
                    {meeting?.id ? <WidgetAsk key={meeting.id} chat={chat} connection={connection} isLive={isLive} visible={view === 'ask'} /> : <div className="ksw-empty-state"><MessageCircle aria-hidden="true" /><h2>Your meeting comes first</h2><p>Once a meeting connects, you can ask about the conversation here.</p></div>}
                </div>
            </main>

            <footer className="ksw-footer">
                {isLive ? <div className="ksw-controls">
                    <button type="button" onClick={() => command('toggle-mic')} disabled={!canControl} aria-pressed={micMuted} aria-label={micMuted ? 'Unmute your microphone' : 'Mute your microphone'}>{micMuted ? <MicOff /> : <Mic />}<span>{micMuted ? 'Mic off' : 'Mic on'}</span></button>
                    <button type="button" onClick={() => command('toggle-system')} disabled={!canControl} aria-pressed={systemAudioMuted} aria-label={systemAudioMuted ? 'Unmute meeting audio' : 'Mute meeting audio'}>{systemAudioMuted ? <VolumeX /> : <Volume2 />}<span>{systemAudioMuted ? 'Audio off' : 'Audio on'}</span></button>
                    <button type="button" className={isPaused ? 'is-paused' : ''} onClick={() => command('toggle-pause')} disabled={!canControl} aria-label={isPaused ? 'Resume the meeting' : 'Pause the meeting'}>{isPaused ? <Play /> : <Pause />}<span>{isPaused ? 'Resume' : 'Pause'}</span></button>
                    <button type="button" className="is-stop" onClick={() => command('stop')} disabled={!canControl} aria-label="Stop the meeting"><Square /> <span>Stop</span></button>
                </div> : <div className="ksw-finished"><span>{state === 'processing' ? 'Finishing your transcript…' : state === 'completed' ? 'Recording finished' : 'Ready for a meeting'}</span><button type="button" className="ksw-open-main" onClick={() => shell?.openMain()}>Open meeting <AppWindow aria-hidden="true" /></button></div>}
            </footer>
        </div>
    );
}
