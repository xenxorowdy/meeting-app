import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Check, Film, Search, TriangleAlert, Volume2, VolumeX, User, Play, Pause, Pencil, X } from 'lucide-react';
import { cn } from '@/utils/cn';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { formatMs, getSpeakerStyle, initialsFor } from '@/lib/speakers';

// `timeupdate` fires around 4-60 times a second depending on the platform, but the
// highlight only has to keep up with speech, so recomputing more often than this
// just re-renders the list for nothing.
const FOLLOW_INTERVAL_MS = 250;
const PLAYBACK_RATES = [0.5, 0.75, 1, 1.25, 1.5, 2];

function EmptyState({ title, children }) {
    return (
        <section className="flex h-full min-h-[300px] flex-col justify-center rounded-xl border p-8">
            <h3 className="text-title3 font-semibold">{title}</h3>
            <p className="mt-2 max-w-sm text-callout text-muted-foreground">{children}</p>
        </section>
    );
}

function SpeakerActivityTimeline({ turns, durationMs, offsetMs, currentMs, onSeek, onRenameSpeaker, nameSuggestions = [], isConnected }) {
    const [editing, setEditing] = useState(null);
    const [draftName, setDraftName] = useState('');
    const [renameError, setRenameError] = useState(null);
    const [isSaving, setIsSaving] = useState(false);

    const rows = useMemo(() => {
        const bySpeaker = new Map();
        for (const turn of turns) {
            const speaker = turn.speaker || 'Unknown';
            if (!bySpeaker.has(speaker)) bySpeaker.set(speaker, []);
            bySpeaker.get(speaker).push(turn);
        }
        return Array.from(bySpeaker, ([speaker, speakerTurns]) => ({ speaker, turns: speakerTurns }));
    }, [turns]);

    const timelineDuration = useMemo(() => {
        if (durationMs > 0) return durationMs;
        return Math.max(0, ...turns.map(turn => (turn.endMs || turn.startMs || 0) - offsetMs));
    }, [durationMs, offsetMs, turns]);

    const saveName = async speaker => {
        const nextName = draftName.trim();
        if (!nextName || nextName === speaker) {
            setEditing(null);
            setRenameError(null);
            return;
        }
        setIsSaving(true);
        setRenameError(null);
        const result = await onRenameSpeaker?.(speaker, nextName);
        setIsSaving(false);
        if (result?.ok) {
            setEditing(null);
            setDraftName('');
        } else {
            setRenameError(result?.message || 'Could not rename this speaker.');
        }
    };

    if (!timelineDuration || rows.length === 0) return null;

    const playheadLeft = `${Math.max(0, Math.min(100, (currentMs / timelineDuration) * 100))}%`;

    return (
        <div className="space-y-2 p-4 hairline-top" aria-label="Speaker activity timeline">
            <div className="flex items-baseline justify-between gap-4">
                <h4 className="text-footnote font-semibold">Speaker activity</h4>
                <span className="text-footnote text-muted-foreground">Click speech to seek · click a name to edit</span>
            </div>
            <div className="max-h-36 space-y-1 overflow-y-auto pr-1">
                {rows.map(row => {
                    const style = getSpeakerStyle(row.speaker);
                    const canRename = Boolean(onRenameSpeaker && isConnected && !style.isYou);
                    return (
                        <div key={row.speaker} className="grid grid-cols-[112px_minmax(0,1fr)] items-center gap-2">
                            {editing === row.speaker ? (
                                <form
                                    className="flex min-w-0 items-center gap-1"
                                    onSubmit={event => {
                                        event.preventDefault();
                                        saveName(row.speaker);
                                    }}
                                >
                                    <Input
                                        autoFocus
                                        value={draftName}
                                        onChange={event => setDraftName(event.target.value)}
                                        onKeyDown={event => {
                                            if (event.key === 'Escape') {
                                                setEditing(null);
                                                setRenameError(null);
                                            }
                                        }}
                                        maxLength={80}
                                        list={nameSuggestions.length > 0 ? 'speaker-name-suggestions' : undefined}
                                        aria-label={`Rename ${row.speaker}`}
                                        className="h-8 min-w-0 px-2 text-footnote"
                                    />
                                    <Button type="submit" variant="ghost" size="iconSm" disabled={isSaving} aria-label="Save speaker name">
                                        <Check aria-hidden="true" />
                                    </Button>
                                    <Button
                                        type="button"
                                        variant="ghost"
                                        size="iconSm"
                                        onClick={() => setEditing(null)}
                                        aria-label="Cancel speaker rename"
                                    >
                                        <X aria-hidden="true" />
                                    </Button>
                                </form>
                            ) : (
                                <button
                                    type="button"
                                    disabled={!canRename}
                                    onClick={() => {
                                        setEditing(row.speaker);
                                        setDraftName(row.speaker);
                                        setRenameError(null);
                                    }}
                                    className="group flex min-w-0 items-center gap-1 text-left disabled:cursor-default"
                                    title={canRename ? `Rename ${row.speaker}` : row.speaker}
                                >
                                    <span className={cn('size-2 shrink-0 rounded-full', style.bar)} aria-hidden="true" />
                                    <span className="truncate text-footnote font-medium">{row.speaker}</span>
                                    {canRename && (
                                        <Pencil
                                            className="size-4 shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100"
                                            aria-hidden="true"
                                        />
                                    )}
                                </button>
                            )}
                            <div className="relative h-4 overflow-hidden rounded bg-muted" aria-label={`${row.speaker} speaking activity`}>
                                {row.turns.map(turn => {
                                    const start = Math.max(0, (turn.startMs || 0) - offsetMs);
                                    const end = Math.max(start + 200, (turn.endMs || turn.startMs || 0) - offsetMs);
                                    const left = Math.max(0, Math.min(100, (start / timelineDuration) * 100));
                                    const width = Math.max(0.35, Math.min(100 - left, ((end - start) / timelineDuration) * 100));
                                    const isActive = currentMs >= start && currentMs <= end;
                                    return (
                                        <button
                                            key={turn.id}
                                            type="button"
                                            onClick={() => onSeek(turn)}
                                            title={`${row.speaker} · ${formatMs(start)} · ${turn.text}`}
                                            aria-label={`Seek to ${row.speaker} at ${formatMs(start)}`}
                                            className={cn(
                                                'absolute inset-y-0 transition-opacity hover:opacity-100 focus-visible:z-20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                                                style.bar,
                                                isActive ? 'z-10 opacity-100' : 'opacity-65'
                                            )}
                                            style={{ left: `${left}%`, width: `${width}%` }}
                                        />
                                    );
                                })}
                                <span
                                    className="pointer-events-none absolute inset-y-0 z-20 w-px bg-foreground/70"
                                    style={{ left: playheadLeft }}
                                    aria-hidden="true"
                                />
                            </div>
                        </div>
                    );
                })}
            </div>
            {nameSuggestions.length > 0 && (
                <datalist id="speaker-name-suggestions">
                    {nameSuggestions.map(name => (
                        <option key={name} value={name} />
                    ))}
                </datalist>
            )}
            {renameError && <p className="text-footnote text-destructive">{renameError}</p>}
        </div>
    );
}

/**
 * Replay a recorded meeting with its transcript beside it: click any line to jump
 * there, and the line under the playhead stays highlighted as it plays.
 *
 * Transcript offsets come from the backend's audio clock, which starts when the
 * meeting starts, while the recording starts a moment later — so every seek is
 * shifted by the difference. The two clocks can also drift apart on a long meeting
 * if a stream stalls; if that ever shows up in practice the fix is a wall-clock
 * stamp per turn rather than a bigger constant here.
 */
export function RecordingPlayer({ meeting, isConnected = true, nameSuggestions = [], onRenameSpeaker }) {
    const videoRef = useRef(null);
    const activeRef = useRef(null);
    const listRef = useRef(null);
    const lastFollowRef = useRef(0);

    const [currentMs, setCurrentMs] = useState(0);
    const [searchQuery, setSearchQuery] = useState('');
    const [follow, setFollow] = useState(true);
    const [loadError, setLoadError] = useState(null);
    const [muted, setMuted] = useState(false);
    const [isPlaying, setIsPlaying] = useState(false);
    const [playbackRate, setPlaybackRate] = useState(1);

    const recording = meeting?.recording || null;
    const offsetMs = useMemo(() => {
        if (!recording || !meeting?.startedAt || !recording.startedAtMs) return 0;
        return Math.max(0, recording.startedAtMs - meeting.startedAt);
    }, [recording, meeting?.startedAt]);

    const src = useMemo(() => {
        if (!recording?.videoPath || !globalThis.alphaRecorder) return null;
        return globalThis.alphaRecorder.mediaUrl(recording.videoPath);
    }, [recording?.videoPath]);

    // The recorder measured this; `video.duration` cannot supply it. Fall back to
    // the meeting length for a record written before the duration was stored.
    const durationMs = recording?.durationMs || (meeting?.durationSeconds || 0) * 1000;

    const togglePlay = useCallback(() => {
        const video = videoRef.current;
        if (!video) return;
        if (video.paused) video.play().catch(() => {});
        else video.pause();
    }, []);

    const turns = meeting?.transcript || [];
    const filteredTurns = useMemo(() => {
        const query = searchQuery.trim().toLowerCase();
        if (!query) return turns;
        return turns.filter(turn => turn.text?.toLowerCase().includes(query) || turn.speaker?.toLowerCase().includes(query));
    }, [turns, searchQuery]);

    // The turn under the playhead. Turns are already in spoken order, so the last
    // one that has started is the active one.
    const activeTurnId = useMemo(() => {
        const positionMs = currentMs + offsetMs;
        let active = null;
        for (const turn of turns) {
            if (turn.startMs <= positionMs) active = turn.id;
            else break;
        }
        return active;
    }, [turns, currentMs, offsetMs]);

    const handleTimeUpdate = useCallback(event => {
        const now = event.target.currentTime * 1000;
        if (Math.abs(now - lastFollowRef.current) < FOLLOW_INTERVAL_MS) return;
        lastFollowRef.current = now;
        setCurrentMs(now);
    }, []);

    const seekTo = useCallback(
        turn => {
            const video = videoRef.current;
            if (!video) return;
            // Clamp: a turn from before the recording started maps to its very
            // beginning rather than to a negative time the element would reject.
            video.currentTime = Math.max(0, (turn.startMs - offsetMs) / 1000);
            setCurrentMs(video.currentTime * 1000);
            video.play().catch(() => {});
        },
        [offsetMs]
    );

    // Keep the highlighted line in view, unless the user has scrolled away to read
    // something else.
    useEffect(() => {
        if (!follow || !activeRef.current) return;
        activeRef.current.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }, [activeTurnId, follow]);

    useEffect(() => {
        setLoadError(null);
        setCurrentMs(0);
        setIsPlaying(false);
        lastFollowRef.current = 0;
    }, [src]);

    useEffect(() => {
        const video = videoRef.current;
        if (!video) return;
        video.defaultPlaybackRate = playbackRate;
        video.playbackRate = playbackRate;
    }, [playbackRate, src]);

    if (!meeting) {
        return <EmptyState title="No meeting selected">Pick a meeting from History to replay its recording alongside the transcript.</EmptyState>;
    }

    if (!recording?.videoPath) {
        return (
            <EmptyState title="This meeting wasn’t recorded">
                Turn on “Record the screen” in Settings before you start a meeting, and it will appear here afterwards.
            </EmptyState>
        );
    }

    if (!globalThis.alphaRecorder) {
        return (
            <EmptyState title="Recordings need the desktop app">
                This meeting has a recording, but a browser tab can’t read it. Open Alpha’s desktop window to watch it.
            </EmptyState>
        );
    }

    return (
        <div className="grid flex-1 grid-cols-1 gap-4 overflow-hidden sm:gap-4 lg:grid-cols-12">
            <section aria-label="Recording" className="flex h-full min-h-0 flex-col overflow-hidden rounded-xl border lg:col-span-7">
                <div className="flex flex-wrap items-center justify-between gap-2 p-4 hairline-bottom sm:p-4">
                    <div className="flex min-w-0 items-center gap-2">
                        <Film className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                        <h3 className="truncate text-headline font-semibold">{meeting.title}</h3>
                    </div>
                    <div className="flex items-center gap-1">
                        {recording.hasSystemAudio === false && (
                            <Badge variant="warning">
                                <TriangleAlert aria-hidden="true" />
                                Your mic only
                            </Badge>
                        )}
                        <Button variant="ghost" size="iconSm" onClick={() => setMuted(m => !m)} aria-label={muted ? 'Unmute' : 'Mute'}>
                            {muted ? <VolumeX aria-hidden="true" /> : <Volume2 aria-hidden="true" />}
                        </Button>
                    </div>
                </div>

                <div className="min-h-0 flex-1 bg-black">
                    {loadError ? (
                        <div className="flex h-full items-center p-8 text-callout text-muted-foreground">
                            <span className="max-w-sm">The recording file is missing or unreadable. It may have been deleted from disk.</span>
                        </div>
                    ) : (
                        <video
                            ref={videoRef}
                            src={src}
                            muted={muted}
                            preload="metadata"
                            onTimeUpdate={handleTimeUpdate}
                            onSeeked={event => setCurrentMs(event.target.currentTime * 1000)}
                            onPlay={() => setIsPlaying(true)}
                            onPause={() => setIsPlaying(false)}
                            onEnded={() => setIsPlaying(false)}
                            onClick={togglePlay}
                            onError={() => setLoadError('unreadable')}
                            className="h-full w-full cursor-pointer bg-black"
                        />
                    )}
                </div>

                {/* Our own transport rather than `controls`. MediaRecorder writes a
                    live-stream webm with no Duration element, so `video.duration`
                    is Infinity and the native scrubber renders with no end and
                    cannot be dragged. The real length was measured while recording
                    and stored on the meeting, so the bar below is driven from that.
                    Seeking itself works — only the reported duration is missing. */}
                {!loadError && (
                    <div className="flex items-center gap-4 p-4 hairline-top">
                        <Button variant="ghost" size="iconSm" onClick={togglePlay} aria-label={isPlaying ? 'Pause' : 'Play'}>
                            {isPlaying ? <Pause aria-hidden="true" /> : <Play aria-hidden="true" />}
                        </Button>
                        <span className="tnum shrink-0 text-footnote text-muted-foreground">{formatMs(currentMs)}</span>
                        <input
                            type="range"
                            min={0}
                            max={durationMs || 0}
                            step={100}
                            value={Math.min(currentMs, durationMs || 0)}
                            disabled={!durationMs}
                            onChange={event => {
                                const video = videoRef.current;
                                if (!video) return;
                                const next = Number(event.target.value);
                                video.currentTime = next / 1000;
                                setCurrentMs(next);
                            }}
                            aria-label="Seek"
                            className="h-1 min-w-0 flex-1 cursor-pointer appearance-none rounded-full bg-muted accent-primary"
                        />
                        <span className="tnum shrink-0 text-footnote text-muted-foreground">{durationMs ? formatMs(durationMs) : '--:--'}</span>
                        <Select value={String(playbackRate)} onValueChange={value => setPlaybackRate(Number(value))}>
                            <SelectTrigger className="h-8 w-[76px] shrink-0 px-2 text-footnote" aria-label="Playback speed">
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent align="end">
                                {PLAYBACK_RATES.map(rate => (
                                    <SelectItem key={rate} value={String(rate)}>
                                        {rate}×
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    </div>
                )}
                {!loadError && (
                    <SpeakerActivityTimeline
                        turns={turns}
                        durationMs={durationMs}
                        offsetMs={offsetMs}
                        currentMs={currentMs}
                        onSeek={seekTo}
                        onRenameSpeaker={onRenameSpeaker}
                        nameSuggestions={nameSuggestions}
                        isConnected={isConnected}
                    />
                )}
            </section>

            <section aria-label="Recording transcript" className="flex h-full min-h-0 flex-col overflow-hidden rounded-xl border lg:col-span-5">
                <div className="flex flex-col gap-4 p-4 hairline-bottom sm:p-4">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex items-center gap-2">
                            <h3 className="text-headline font-semibold">Transcript</h3>
                            <Badge variant="muted" className="tnum">
                                {turns.length} {turns.length === 1 ? 'turn' : 'turns'}
                            </Badge>
                        </div>
                        <Button variant={follow ? 'secondary' : 'ghost'} size="xs" onClick={() => setFollow(f => !f)}>
                            {follow ? 'Following' : 'Follow'}
                        </Button>
                    </div>
                    <div className="relative">
                        <Search
                            className="pointer-events-none absolute left-2 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
                            aria-hidden="true"
                        />
                        <Input
                            value={searchQuery}
                            onChange={event => setSearchQuery(event.target.value)}
                            placeholder="Search this transcript"
                            className="pl-8"
                            aria-label="Search the transcript"
                        />
                    </div>
                </div>

                <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto p-2">
                    {filteredTurns.length === 0 ? (
                        <p className="p-4 text-callout text-muted-foreground">
                            {turns.length === 0 ? 'This meeting has no transcript.' : 'No lines match that search.'}
                        </p>
                    ) : (
                        filteredTurns.map(turn => {
                            const style = getSpeakerStyle(turn.speaker);
                            const isActive = turn.id === activeTurnId;
                            return (
                                <button
                                    key={turn.id}
                                    ref={isActive ? activeRef : null}
                                    type="button"
                                    onClick={() => seekTo(turn)}
                                    aria-current={isActive ? 'true' : undefined}
                                    className={cn(
                                        'flex w-full gap-2 rounded-lg p-2 text-left transition-colors',
                                        isActive ? 'bg-primary/[0.12]' : 'hover:bg-muted'
                                    )}
                                >
                                    <span
                                        className={cn(
                                            'mt-1 flex size-6 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold',
                                            style.avatar
                                        )}
                                        aria-hidden="true"
                                    >
                                        {style.isYou ? <User className="size-4" /> : initialsFor(turn.speaker)}
                                    </span>
                                    <span className="min-w-0 flex-1">
                                        <span className="flex items-baseline gap-2">
                                            <span className="truncate text-footnote font-medium">{turn.speaker}</span>
                                            <span className="tnum shrink-0 text-footnote text-muted-foreground">
                                                {formatMs(Math.max(0, turn.startMs - offsetMs))}
                                            </span>
                                        </span>
                                        <span className="block text-callout">{turn.text}</span>
                                    </span>
                                </button>
                            );
                        })
                    )}
                </div>
            </section>
        </div>
    );
}
