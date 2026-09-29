import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { AppWindow, ChevronDown, ChevronUp, GripVertical, Mic, MicOff, Pause, Play, Square, Volume2, VolumeX, X } from 'lucide-react';
import { JumpingBalls } from '@/components/JumpingBalls';
import { StreamingText } from '@/components/StreamingText';
import { LevelHistory } from '@/components/widget/LevelHistory';
import { useLiveStatus } from '@/hooks/useLiveStatus';
import { useTheme } from '@/lib/theme';

const shell = globalThis.kesamiWidget || null;

function formatClock(totalSeconds) {
    const seconds = Math.max(0, Math.floor(totalSeconds));
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const pad = value => String(value).padStart(2, '0');
    return hours > 0 ? `${hours}:${pad(minutes % 60)}:${pad(seconds % 60)}` : `${pad(minutes)}:${pad(seconds % 60)}`;
}

const STATUS = {
    recording: { label: 'Recording', modifier: 'is-recording' },
    paused: { label: 'Paused', modifier: 'is-paused' },
    processing: { label: 'Transcribing', modifier: 'is-processing', balls: true },
    completed: { label: 'Notes ready', modifier: 'is-completed' },
    idle: { label: 'Ready', modifier: 'is-idle' },
};

function describe(connection, sessionState) {
    if (connection !== 'online') {
        return {
            label: connection === 'connecting' ? 'Connecting' : 'Offline',
            modifier: 'is-offline',
            balls: connection === 'connecting',
        };
    }
    return STATUS[sessionState] || STATUS.idle;
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

function TranscriptFeed({ turns, interimTurns }) {
    const endRef = useRef(null);
    const pending = interimTurns.filter(turn => turn.text);

    useLayoutEffect(() => {
        endRef.current?.scrollIntoView({ block: 'end' });
    }, [turns.length, pending.length, pending.map(turn => turn.text).join('')]);

    if (turns.length === 0 && pending.length === 0) {
        return <p className="ks-widget-empty">Nothing transcribed yet.</p>;
    }

    return (
        <>
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
                    <p className="ks-widget-text">
                        <StreamingText text={turn.text} stream={Boolean(turn.interim)} />
                        {turn.interim && <JumpingBalls size="sm" className="ml-1.5 align-middle" />}
                    </p>
                </div>
            ))}
            <div ref={endRef} />
        </>
    );
}

export function StatusWidget() {
    const { connection, sessionState, meeting, turns, interimTurns, durationSeconds, subscribeAudioLevels } = useLiveStatus();
    const shellState = useShellState();
    const [theme] = useTheme();
    const [expanded, setExpanded] = useState(false);

    const state = shellState?.sessionState || sessionState;
    const status = describe(connection, state);
    const title = shellState?.title || meeting?.title || '';
    const isLive = state === 'recording' || state === 'paused';
    const canControl = Boolean(shellState?.canControl) && isLive;
    const micMuted = Boolean(shellState?.micMuted);
    const systemAudioMuted = Boolean(shellState?.systemAudioMuted);
    const isPaused = state === 'paused';
    const listening = connection === 'online' && state === 'recording';

    useEffect(() => {
        shell?.setExpanded(expanded);
    }, [expanded]);

    const command = useCallback(action => {
        shell?.sendCommand(action);
    }, []);

    if (!expanded) {
        return (
            <div className="ks-app ks-widget is-collapsed" data-theme={theme}>
                <div className={`ks-pill ${status.modifier}`}>
                    <button
                        type="button"
                        className="ks-pill-face"
                        onClick={() => setExpanded(true)}
                        aria-expanded="false"
                        aria-label={title ? `${status.label} — ${title}. Show the live transcript` : `${status.label}. Show the live transcript`}
                    >
                        {isLive ? (
                            <span className="ks-pill-wave">
                                <LevelHistory subscribe={subscribeAudioLevels} active={listening} />
                            </span>
                        ) : (
                            <span className="ks-pill-label">
                                {status.balls ? <JumpingBalls size="sm" /> : <i />}
                                {status.label}
                            </span>
                        )}
                        {isLive && <span className="ks-pill-clock">{formatClock(durationSeconds)}</span>}
                    </button>

                    {canControl ? (
                        <button type="button" className="ks-pill-action is-stop" onClick={() => command('stop')} aria-label="Stop the meeting">
                            <span className="ks-pill-square" aria-hidden="true" />
                        </button>
                    ) : (
                        <button type="button" className="ks-pill-action" onClick={() => setExpanded(true)} aria-label="Show the live transcript">
                            <ChevronUp aria-hidden="true" />
                        </button>
                    )}
                </div>
            </div>
        );
    }

    return (
        <div className="ks-app ks-widget" data-theme={theme}>
            <div className="ks-widget-head">
                <span className="ks-widget-grip" aria-hidden="true">
                    <GripVertical />
                </span>

                <button
                    type="button"
                    className="ks-widget-toggle"
                    onClick={() => setExpanded(false)}
                    aria-expanded="true"
                    aria-label="Hide the live transcript"
                >
                    <span className={`ks-widget-status ${status.modifier}`}>
                        {status.balls ? <JumpingBalls size="sm" /> : <i />}
                        {status.label}
                    </span>
                    {title && <span className="ks-widget-title">{title}</span>}
                    {isLive && <span className="ks-widget-clock">{formatClock(durationSeconds)}</span>}
                    <ChevronDown className="ks-widget-chevron is-open" aria-hidden="true" />
                </button>

                <button type="button" className="ks-icon-button" onClick={() => shell?.hide()} aria-label="Hide the widget until the app restarts">
                    <X />
                </button>
            </div>

            <div className="ks-widget-wave">
                <LevelHistory subscribe={subscribeAudioLevels} active={listening} />
            </div>

            <div className="ks-widget-body">
                {connection !== 'online' ? (
                    <p className="ks-widget-empty">Waiting for the Kesami backend. The transcript appears here once it answers.</p>
                ) : (
                    <TranscriptFeed turns={turns} interimTurns={interimTurns} />
                )}
            </div>

            <div className="ks-widget-foot">
                <div className="ks-widget-controls">
                    <button
                        type="button"
                        className="ks-icon-button"
                        onClick={() => command('toggle-mic')}
                        disabled={!canControl}
                        aria-pressed={micMuted}
                        aria-label={micMuted ? 'Unmute your microphone' : 'Mute your microphone'}
                    >
                        {micMuted ? <MicOff /> : <Mic />}
                    </button>
                    <button
                        type="button"
                        className="ks-icon-button"
                        onClick={() => command('toggle-system')}
                        disabled={!canControl}
                        aria-pressed={systemAudioMuted}
                        aria-label={systemAudioMuted ? 'Unmute meeting audio' : 'Mute meeting audio'}
                    >
                        {systemAudioMuted ? <VolumeX /> : <Volume2 />}
                    </button>
                    <button
                        type="button"
                        className={isPaused ? 'ks-icon-button is-paused' : 'ks-icon-button'}
                        onClick={() => command('toggle-pause')}
                        disabled={!canControl}
                        aria-label={isPaused ? 'Resume the meeting' : 'Pause the meeting'}
                    >
                        {isPaused ? <Play /> : <Pause />}
                    </button>
                    <button
                        type="button"
                        className="ks-icon-button ks-red"
                        onClick={() => command('stop')}
                        disabled={!canControl}
                        aria-label="Stop the meeting"
                    >
                        <Square />
                    </button>
                </div>

                <button type="button" className="ks-text-button" onClick={() => shell?.openMain()}>
                    <AppWindow />
                    Open
                </button>
            </div>
        </div>
    );
}
