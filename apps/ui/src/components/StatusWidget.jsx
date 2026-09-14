import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { AppWindow, ChevronDown, GripVertical, X } from 'lucide-react';
import { cn } from '@/utils/cn';
import { JumpingBalls } from '@/components/JumpingBalls';
import { StreamingText } from '@/components/StreamingText';
import { useLiveStatus } from '@/hooks/useLiveStatus';

const shell = globalThis.alphaWidget || null;

function formatClock(totalSeconds) {
    const seconds = Math.max(0, Math.floor(totalSeconds));
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const pad = value => String(value).padStart(2, '0');
    return hours > 0 ? `${hours}:${pad(minutes % 60)}:${pad(seconds % 60)}` : `${pad(minutes)}:${pad(seconds % 60)}`;
}

function describe(connection, sessionState) {
    if (connection !== 'online') {
        return {
            label: connection === 'connecting' ? 'Connecting' : 'Offline',
            dot: 'bg-muted-foreground/50',
            balls: connection === 'connecting',
            tint: 'text-muted-foreground',
        };
    }
    switch (sessionState) {
        case 'recording':
            return { label: 'Recording', dot: 'bg-destructive', tint: 'text-destructive' };
        case 'paused':
            return { label: 'Paused', dot: 'bg-warning', tint: 'text-warning' };
        case 'processing':
            return { label: 'Transcribing', dot: 'bg-primary', balls: true, tint: 'text-primary' };
        case 'completed':
            return { label: 'Notes ready', dot: 'bg-success', tint: 'text-success' };
        default:
            return { label: 'Ready', dot: 'bg-muted-foreground', tint: 'text-muted-foreground' };
    }
}

/**
 * Two hairline bars that breathe with the microphone and the meeting audio.
 * Levels stream in every 8 ms, so the subscription writes transforms straight
 * to the DOM — this component renders exactly once.
 */
function LevelMeter({ subscribe, className }) {
    const micRef = useRef(null);
    const systemRef = useRef(null);

    useEffect(() => {
        if (!subscribe) return undefined;
        const scale = level => (0.14 + (level / 100) * 0.86).toFixed(3);
        return subscribe(({ mic, system }) => {
            if (micRef.current) micRef.current.style.transform = `scaleY(${scale(mic)})`;
            if (systemRef.current) systemRef.current.style.transform = `scaleY(${scale(system)})`;
        });
    }, [subscribe]);

    return (
        <span className={cn('widget-vu', className)} role="img" aria-label="Live audio levels">
            <i ref={micRef} className="text-destructive" />
            <i ref={systemRef} className="text-primary" />
        </span>
    );
}

function TranscriptFeed({ turns, interimTurns }) {
    const endRef = useRef(null);
    const pending = interimTurns.filter(turn => turn.text);

    useLayoutEffect(() => {
        endRef.current?.scrollIntoView({ block: 'end' });
    }, [turns.length, pending.length, pending.map(turn => turn.text).join('')]);

    if (turns.length === 0 && pending.length === 0) {
        return <p className="px-4 py-8 text-center text-footnote text-muted-foreground">Nothing transcribed yet.</p>;
    }

    return (
        <div className="flex flex-col gap-2.5 px-4 py-3">
            {[...turns, ...pending].map(turn => (
                <div key={turn.id} className={cn('widget-turn flex items-baseline gap-2', turn.interim && 'opacity-75')}>
                    <span
                        className={cn(
                            'w-16 shrink-0 truncate text-footnote font-medium',
                            turn.stream === 'mic' ? 'text-primary' : 'text-muted-foreground'
                        )}
                    >
                        {turn.speaker}
                    </span>
                    <span className="min-w-0 flex-1 text-footnote leading-relaxed text-foreground/90">
                        <StreamingText text={turn.text} stream={Boolean(turn.interim)} />
                        {turn.interim && <JumpingBalls size="sm" className="ml-1.5 align-middle text-primary" />}
                    </span>
                </div>
            ))}
            <div ref={endRef} />
        </div>
    );
}

export function StatusWidget() {
    const { connection, sessionState, meeting, turns, interimTurns, durationSeconds, isLive, subscribeAudioLevels } =
        useLiveStatus();
    const [expanded, setExpanded] = useState(false);
    const status = describe(connection, sessionState);
    const showMeter = connection === 'online' && sessionState === 'recording';

    useEffect(() => {
        shell?.setExpanded(expanded);
    }, [expanded]);

    const control =
        'no-drag flex size-7 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors duration-200 ease-out hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

    return (
        <div
            className={cn(
                'flex h-full w-full flex-col overflow-hidden rounded-2xl border border-border/70 shadow-lg',
                'material-sheet text-foreground transition-[border-color] duration-200'
            )}
        >
            <div className="flex h-12 shrink-0 items-center gap-0.5 pr-1.5">
                <span className="drag-region flex h-full cursor-grab items-center pl-1.5 pr-1 text-muted-foreground/60 active:cursor-grabbing">
                    <GripVertical className="size-3.5" aria-hidden="true" />
                </span>

                <button
                    type="button"
                    onClick={() => setExpanded(prev => !prev)}
                    aria-expanded={expanded}
                    aria-label={expanded ? 'Hide the live transcript' : 'Show the live transcript'}
                    className="no-drag group flex min-w-0 flex-1 items-center gap-2 self-stretch rounded-xl px-1.5 text-left transition-colors duration-200 ease-out hover:bg-accent/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                    {showMeter ? (
                        <LevelMeter subscribe={subscribeAudioLevels} className="shrink-0 text-destructive" />
                    ) : status.balls ? (
                        <JumpingBalls size="sm" className={cn('shrink-0', status.tint)} />
                    ) : (
                        <span className="relative flex size-2 shrink-0">
                            <span className={cn('absolute inset-0 rounded-full', status.dot, isLive && 'animate-breathe')} />
                            <span className={cn('relative inline-flex size-2 rounded-full', status.dot)} />
                        </span>
                    )}
                    <span className="min-w-0 flex-1 truncate text-footnote font-medium">{status.label}</span>
                    {isLive && (
                        <span className="tnum shrink-0 text-footnote font-medium text-muted-foreground">
                            {formatClock(durationSeconds)}
                        </span>
                    )}
                    <ChevronDown
                        className={cn(
                            'size-3.5 shrink-0 text-muted-foreground/70 transition-transform duration-200 ease-out',
                            expanded && 'rotate-180'
                        )}
                        aria-hidden="true"
                    />
                </button>

                {expanded && (
                    <>
                        <button type="button" onClick={() => shell?.openMain()} aria-label="Open the Alpha window" className={control}>
                            <AppWindow className="size-4" aria-hidden="true" />
                        </button>
                        <button
                            type="button"
                            onClick={() => shell?.hide()}
                            aria-label="Hide the widget until the app restarts"
                            className={control}
                        >
                            <X className="size-4" aria-hidden="true" />
                        </button>
                    </>
                )}
            </div>

            {expanded && (
                <div className="flex min-h-0 flex-1 flex-col hairline-top">
                    {meeting?.title && (
                        <p className="truncate px-4 pt-2.5 text-footnote font-medium text-muted-foreground">{meeting.title}</p>
                    )}
                    <div className="scroll-edge min-h-0 flex-1 overflow-y-auto">
                        {connection !== 'online' ? (
                            <p className="px-4 py-8 text-center text-footnote leading-relaxed text-muted-foreground">
                                Waiting for the Alpha backend. The transcript appears here once it answers.
                            </p>
                        ) : (
                            <TranscriptFeed turns={turns} interimTurns={interimTurns} />
                        )}
                    </div>
                </div>
            )}
        </div>
    );
}
