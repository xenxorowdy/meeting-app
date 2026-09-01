import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { AppWindow, ChevronDown, GripVertical, X } from 'lucide-react';
import { cn } from '@/utils/cn';
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
        return { label: connection === 'connecting' ? 'Connecting' : 'Offline', dot: 'bg-muted-foreground/50', pulse: false };
    }
    switch (sessionState) {
        case 'recording':
            return { label: 'Recording', dot: 'bg-destructive', pulse: true };
        case 'paused':
            return { label: 'Paused', dot: 'bg-warning', pulse: false };
        case 'processing':
            return { label: 'Transcribing', dot: 'bg-primary', pulse: true };
        case 'completed':
            return { label: 'Notes ready', dot: 'bg-success', pulse: false };
        default:
            return { label: 'Ready', dot: 'bg-muted-foreground', pulse: false };
    }
}

function TranscriptFeed({ turns }) {
    const endRef = useRef(null);

    useLayoutEffect(() => {
        endRef.current?.scrollIntoView({ block: 'end' });
    }, [turns.length]);

    if (turns.length === 0) {
        return <p className="px-3 py-6 text-center text-footnote text-muted-foreground">Nothing transcribed yet.</p>;
    }

    return (
        <div className="flex flex-col gap-2 px-3 py-2">
            {turns.map(turn => (
                <div key={turn.id} className="flex gap-2">
                    <span
                        className={cn(
                            'w-14 shrink-0 truncate text-footnote font-medium',
                            turn.stream === 'mic' ? 'text-primary' : 'text-muted-foreground'
                        )}
                    >
                        {turn.speaker}
                    </span>
                    <span className="min-w-0 flex-1 text-footnote text-foreground">{turn.text}</span>
                </div>
            ))}
            <div ref={endRef} />
        </div>
    );
}

export function StatusWidget() {
    const { connection, sessionState, meeting, turns, durationSeconds, isLive } = useLiveStatus();
    const [expanded, setExpanded] = useState(false);
    const status = describe(connection, sessionState);

    useEffect(() => {
        shell?.setExpanded(expanded);
    }, [expanded]);

    return (
        <div
            className={cn(
                'flex h-full w-full flex-col overflow-hidden rounded-[14px] border border-border/80 shadow-lg',
                'material-sheet text-foreground'
            )}
        >
            <div className="flex h-11 shrink-0 items-center gap-1 pr-1">
                <span className="drag-region flex h-full cursor-grab items-center pl-1 pr-0.5 text-muted-foreground active:cursor-grabbing">
                    <GripVertical className="size-4" aria-hidden="true" />
                </span>

                <button
                    type="button"
                    onClick={() => setExpanded(prev => !prev)}
                    aria-expanded={expanded}
                    aria-label={expanded ? 'Hide the live transcript' : 'Show the live transcript'}
                    className="no-drag flex min-w-0 flex-1 items-center gap-2 self-stretch rounded-lg px-1 text-left transition-colors duration-200 ease-out hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                    <span className="relative flex size-2 shrink-0">
                        {status.pulse && <span className={cn('absolute inline-flex size-2 animate-ping rounded-full opacity-60', status.dot)} />}
                        <span className={cn('relative inline-flex size-2 rounded-full', status.dot)} />
                    </span>
                    <span className="min-w-0 flex-1 truncate text-footnote font-medium">{status.label}</span>
                    {isLive && <span className="tnum shrink-0 text-footnote text-muted-foreground">{formatClock(durationSeconds)}</span>}
                </button>

                {expanded && (
                    <>
                        <button
                            type="button"
                            onClick={() => shell?.openMain()}
                            aria-label="Open the Alpha window"
                            className="no-drag flex size-7 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors duration-200 ease-out hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                            <AppWindow className="size-4" aria-hidden="true" />
                        </button>
                        <button
                            type="button"
                            onClick={() => setExpanded(false)}
                            aria-label="Collapse the widget"
                            className="no-drag flex size-7 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors duration-200 ease-out hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                            <ChevronDown className="size-4" aria-hidden="true" />
                        </button>
                        <button
                            type="button"
                            onClick={() => shell?.hide()}
                            aria-label="Hide the widget until the app restarts"
                            className="no-drag flex size-7 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors duration-200 ease-out hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                            <X className="size-4" aria-hidden="true" />
                        </button>
                    </>
                )}
            </div>

            {expanded && (
                <div className="flex min-h-0 flex-1 flex-col hairline-top">
                    {meeting?.title && <p className="truncate px-3 pt-2 text-footnote font-medium text-muted-foreground">{meeting.title}</p>}
                    <div className="min-h-0 flex-1 overflow-y-auto">
                        {connection !== 'online' ? (
                            <p className="px-3 py-6 text-center text-footnote text-muted-foreground">
                                Waiting for the Alpha backend. The transcript appears here once it answers.
                            </p>
                        ) : (
                            <TranscriptFeed turns={turns} />
                        )}
                    </div>
                </div>
            )}
        </div>
    );
}
