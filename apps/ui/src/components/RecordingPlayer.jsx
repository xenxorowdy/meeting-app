import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    Check,
    Film,
    Mic2,
    Search,
    TriangleAlert,
    Volume2,
    VolumeX,
    User,
    Play,
    Pause,
    Pencil,
    X,
    Bookmark,
    Share2,
    SkipBack,
    SkipForward,
    Minus,
    Plus,
} from 'lucide-react';
import { cn } from '@/utils/cn';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { formatMs, getSpeakerStyle, initialsFor } from '@/lib/speakers';
import { speakerColor } from '@/components/design/designHelpers';

// `timeupdate` fires around 4-60 times a second depending on the platform, but the
// highlight only has to keep up with speech, so recomputing more often than this
// just re-renders the list for nothing.
const FOLLOW_INTERVAL_MS = 250;
const PLAYBACK_RATES = [0.5, 1, 2, 4];

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
export function RecordingPlayer({ compact = false, meeting, citationFocus = null, isConnected = true, nameSuggestions = [], onRenameSpeaker }) {
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
    const [zoom, setZoom] = useState(100);
    const [bookmarks, setBookmarks] = useState([]);
    const [copied, setCopied] = useState(false);
    const [shareError, setShareError] = useState('');
    const seekPosition = value => {
        if (!videoRef.current) return;
        const position = Math.max(0, Math.min(durationMs, value));
        videoRef.current.currentTime = position / 1000;
        setCurrentMs(position);
    };

    const recording = meeting?.recording || null;
    const offsetMs = useMemo(() => {
        if (!recording || !meeting?.startedAt || !recording.startedAtMs) return 0;
        return Math.max(0, recording.startedAtMs - meeting.startedAt);
    }, [recording, meeting?.startedAt]);

    const src = useMemo(() => {
        if (!recording?.videoPath || !globalThis.kesamiRecorder) return null;
        return globalThis.kesamiRecorder.mediaUrl(recording.videoPath);
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

    useEffect(() => {
        const video = videoRef.current;
        if (!video || citationFocus?.meetingId !== meeting?.id || !Number.isFinite(citationFocus?.startMs)) return;
        const seek = () => {
            video.currentTime = Math.max(0, (citationFocus.startMs - offsetMs) / 1000);
            setCurrentMs(video.currentTime * 1000);
            setFollow(true);
        };
        if (video.readyState >= 1) seek();
        else video.addEventListener('loadedmetadata', seek, { once: true });
        return () => video.removeEventListener('loadedmetadata', seek);
    }, [citationFocus, meeting?.id, offsetMs, src]);

    // Keep the highlighted line in view, unless the user has scrolled away to read
    // something else.
    useEffect(() => {
        const list = listRef.current;
        const active = activeRef.current;
        if (!follow || !list || !active) return;
        // Follow inside the transcript only; scrolling every ancestor can hide the player.
        const bounds = list.getBoundingClientRect();
        const line = active.getBoundingClientRect();
        if (line.top < bounds.top) list.scrollTop += line.top - bounds.top;
        else if (line.bottom > bounds.bottom) list.scrollTop += line.bottom - bounds.bottom;
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
                Choose a screen in the recording source picker when you start your next meeting. Its replay will appear here once recording finishes.
            </EmptyState>
        );
    }

    if (!globalThis.kesamiRecorder) {
        return (
            <EmptyState title="Recordings need the desktop app">
                This meeting has a recording, but a browser tab can’t read it. Open Kesami’s desktop window to watch it.
            </EmptyState>
        );
    }

    const activeTurn = turns.find(turn => turn.id === activeTurnId);
    const mediaProps = {
        ref: videoRef,
        src,
        muted,
        preload: 'metadata',
        onTimeUpdate: handleTimeUpdate,
        onSeeked: event => setCurrentMs(event.target.currentTime * 1000),
        onPlay: () => setIsPlaying(true),
        onPause: () => setIsPlaying(false),
        onEnded: () => setIsPlaying(false),
        onError: () => setLoadError('unreadable'),
    };

    return (
        <div className={`ks-replay${compact ? ' ks-replay-compact' : ''}`}>
            {!compact && <header className="ks-replay-toolbar">
                <span>{recording.mode === 'audio' ? 'Audio recording' : 'Screen recording'}</span>
                <div className="ks-replay-toolbar-actions">
                    {recording.mode !== 'audio' && <div className="ks-zoom">
                        <button aria-label="Zoom out" disabled={zoom <= 50} onClick={() => setZoom(value => Math.max(50, value - 10))}>
                            <Minus />
                        </button>
                        <span>{zoom}%</span>
                        <button aria-label="Zoom in" disabled={zoom >= 200} onClick={() => setZoom(value => Math.min(200, value + 10))}>
                            <Plus />
                        </button>
                    </div>}
                    <button
                        className="ks-button ks-mark"
                        onClick={() => setBookmarks(items => [...new Set([...items, Math.round(currentMs)])].sort((a, b) => a - b))}
                    >
                        <Bookmark />
                        Mark
                    </button>
                    <button
                        className="ks-button"
                        onClick={async () => {
                            try {
                                await navigator.clipboard.writeText(`${meeting.title} · ${formatMs(currentMs)}`);
                                setCopied(true);
                            } catch {
                                setShareError('Could not copy the timestamp.');
                            }
                        }}
                    >
                        <Share2 />
                        {copied ? 'Copied' : 'Copy timestamp'}
                    </button>
                </div>
            </header>}
            {shareError && (
                <p className="ks-error" role="alert">
                    {shareError}
                </p>
            )}
            <div className="ks-replay-body">
                <section aria-label="Recording" className="ks-replay-stage">
                    <div className="ks-video-frame">
                        <div className="ks-video-viewport">
                            {loadError ? (
                                <div className="ks-empty">
                                    <h3>Recording unavailable</h3>
                                    <p>The recording file is missing or unreadable.</p>
                                </div>
                            ) : recording.mode === 'audio' ? (
                                <div className="ks-audio-art">
                                    <Mic2 />
                                    <h3>Sound-only recording</h3>
                                    <p>Recorded without screen sharing</p>
                                    <audio {...mediaProps} />
                                </div>
                            ) : (
                                <video {...mediaProps} onClick={togglePlay} style={{ transform: `scale(${zoom / 100})` }} />
                            )}
                            {activeTurn && (
                                <div className="ks-replay-caption">
                                    <span className="ks-avatar" style={{ '--speaker': speakerColor(activeTurn.speaker) }}>
                                        {initialsFor(activeTurn.speaker)}
                                    </span>
                                    <span>{activeTurn.text}</span>
                                </div>
                            )}
                        </div>
                    </div>
                    <div className="ks-replay-transport">
                        <div className="ks-replay-scrubber">
                            <input
                                type="range"
                                min={0}
                                max={durationMs || 0}
                                step={100}
                                value={Math.min(currentMs, durationMs || 0)}
                                disabled={!durationMs || Boolean(loadError)}
                                onChange={event => seekPosition(Number(event.target.value))}
                                aria-label="Seek recording"
                            />
                            <div className="ks-speech-markers">
                                {turns.map(turn => (
                                    <i
                                        key={turn.id}
                                        style={{
                                            left: `${Math.min(100, Math.max(0, ((turn.startMs - offsetMs) / (durationMs || 1)) * 100))}%`,
                                            background: speakerColor(turn.speaker),
                                        }}
                                    />
                                ))}
                            </div>
                        </div>
                        {bookmarks.length > 0 && (
                            <div className="ks-bookmarks">
                                {bookmarks.map(mark => (
                                    <button key={mark} onClick={() => seekPosition(mark)} title="Bookmarks are kept for this session">
                                        <Bookmark />
                                        {formatMs(mark)}
                                    </button>
                                ))}
                            </div>
                        )}
                        <div className="ks-transport-row">
                            <button
                                className="ks-transport-skip"
                                aria-label="Back 10 seconds"
                                disabled={Boolean(loadError)}
                                onClick={() => seekPosition(currentMs - 10000)}
                            >
                                <SkipBack />
                            </button>
                            <button
                                className="ks-play"
                                aria-label={isPlaying ? 'Pause playback' : 'Play recording'}
                                disabled={Boolean(loadError)}
                                onClick={togglePlay}
                            >
                                {isPlaying ? <Pause /> : <Play />}
                            </button>
                            <button
                                className="ks-transport-skip"
                                aria-label="Forward 10 seconds"
                                disabled={Boolean(loadError)}
                                onClick={() => seekPosition(currentMs + 10000)}
                            >
                                <SkipForward />
                            </button>
                            <time>
                                {formatMs(currentMs)} <span>/ {formatMs(durationMs)}</span>
                            </time>
                            <button
                                className="ks-icon-button"
                                aria-label={muted ? 'Unmute playback' : 'Mute playback'}
                                onClick={() => setMuted(value => !value)}
                            >
                                {muted ? <VolumeX /> : <Volume2 />}
                            </button>
                            <select className="ks-playback-rate" aria-label="Playback speed" value={playbackRate} onChange={event => setPlaybackRate(Number(event.target.value))}>
                                {PLAYBACK_RATES.map(rate => <option key={rate} value={rate}>{rate}×</option>)}
                            </select>
                        </div>
                    </div>
                    {!compact && <details className="ks-speaker-details">
                        <summary>Speaker activity & names</summary>
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
                    </details>}
                </section>
                {!compact && <section aria-label="Recording transcript" className="ks-replay-transcript">
                    <header>
                        <div>
                            <span>Transcript</span>
                            <button onClick={() => setFollow(value => !value)} aria-pressed={follow}>
                                {follow ? 'Following' : 'Follow'}
                            </button>
                        </div>
                        <input
                            value={searchQuery}
                            onChange={event => setSearchQuery(event.target.value)}
                            placeholder="Search transcript…"
                            aria-label="Search recording transcript"
                        />
                    </header>
                    <div ref={listRef} className="ks-replay-turns">
                        {filteredTurns.length === 0 && (
                            <p className="ks-empty">{turns.length ? 'No matching passages.' : 'No transcript available.'}</p>
                        )}
                        {filteredTurns.map(turn => (
                            <button
                                key={turn.id}
                                ref={turn.id === activeTurnId ? activeRef : null}
                                className={turn.id === activeTurnId ? 'is-active' : ''}
                                onClick={() => seekTo(turn)}
                                aria-current={turn.id === activeTurnId ? 'true' : undefined}
                            >
                                <span className="ks-avatar" style={{ '--speaker': speakerColor(turn.speaker) }}>
                                    {initialsFor(turn.speaker)}
                                </span>
                                <span>
                                    <span className="ks-replay-turn-heading">
                                        <strong>{turn.speaker}</strong>
                                        <time>{formatMs(Math.max(0, turn.startMs - offsetMs))}</time>
                                    </span>
                                    <span className="ks-replay-turn-text">{turn.text}</span>
                                </span>
                            </button>
                        ))}
                    </div>
                </section>}
            </div>
        </div>
    );
}
