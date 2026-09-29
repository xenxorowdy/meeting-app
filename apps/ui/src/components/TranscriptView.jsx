import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ArrowDownToLine, Check, Copy, MessageSquareText, Search, Sparkles, TriangleAlert, User, X, Cpu } from 'lucide-react';
import { cn } from '@/utils/cn';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { SegmentedControl, SegmentedItem } from '@/components/ui/segmented-control';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { JumpingBalls } from '@/components/JumpingBalls';
import { StreamingText } from '@/components/StreamingText';
import { formatMs, getSpeakerStyle, initialsFor, languageName } from '@/lib/speakers';

function countWords(text) {
    return text.trim() ? text.trim().split(/\s+/).length : 0;
}

function turnDurationSeconds(turn) {
    const end = turn.endMs || turn.startMs;
    return Math.max(1, Math.round((end - turn.startMs) / 1000));
}

/**
 * The workspace transcript. One component serves the live meeting and the
 * finished record: search and speaker filters, per-turn copy and ask-AI,
 * timestamps that seek the recording, and talk time once there is something to
 * measure. Filtering happens here, so callers hand it turns and handlers only.
 */
export function TranscriptView({
    turns = [],
    interimTurns = [],
    isLive = false,
    isPaused = false,
    isConnected = true,
    citationFocus = null,
    seekable = false,
    onSeek,
    onAsk,
    onRenameSpeaker,
    stt = null,
}) {
    const [query, setQuery] = useState('');
    const [filtersOpen, setFiltersOpen] = useState(false);
    const liveSession = isLive || isPaused;
    const [speakerFilter, setSpeakerFilter] = useState('ALL');
    const [follow, setFollow] = useState(true);
    const [showJump, setShowJump] = useState(false);
    const [copiedId, setCopiedId] = useState(null);
    const [copiedAll, setCopiedAll] = useState(false);
    const [renaming, setRenaming] = useState(null);
    const [draftName, setDraftName] = useState('');
    const [renameError, setRenameError] = useState('');
    const scrollRef = useRef(null);
    const endRef = useRef(null);

    const needle = query.trim().toLowerCase();
    const speakers = useMemo(() => [...new Set(turns.map(turn => turn.speaker))], [turns]);
    const filtered = useMemo(() => {
        let list = turns;
        if (needle) list = list.filter(turn => `${turn.speaker} ${turn.text}`.toLowerCase().includes(needle));
        if (speakerFilter !== 'ALL') list = list.filter(turn => turn.speaker === speakerFilter);
        return list;
    }, [turns, needle, speakerFilter]);
    const pending = useMemo(() => interimTurns.filter(turn => turn.text), [interimTurns]);

    const speakerStats = useMemo(() => {
        const perSpeaker = new Map();
        let total = 0;
        for (const turn of turns) {
            // Talk time is measured from speech duration, with word count as
            // the shape of the legend; a turn without timing still counts as
            // one second so it is never invisible.
            const seconds = turnDurationSeconds(turn);
            const entry = perSpeaker.get(turn.speaker) || { speaker: turn.speaker, seconds: 0, words: 0, turns: 0 };
            entry.seconds += seconds;
            entry.words += countWords(turn.text);
            entry.turns += 1;
            perSpeaker.set(turn.speaker, entry);
            total += seconds;
        }
        return [...perSpeaker.values()]
            .map(entry => ({
                ...entry,
                percentage: total > 0 ? Math.round((entry.seconds / total) * 100) : 0,
            }))
            .sort((a, b) => b.seconds - a.seconds);
    }, [turns]);

    // Citation jumps from chat or the summary land on the cited turn.
    useEffect(() => {
        if (!citationFocus?.turnIds?.length) return;
        const target = Array.from(scrollRef.current?.querySelectorAll('[data-turn-id]') || []).find(element =>
            citationFocus.turnIds.includes(element.dataset.turnId)
        );
        target?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }, [citationFocus, filtered]);

    // Follow the live feed until the reader scrolls away to look something up.
    useLayoutEffect(() => {
        if (follow && scrollRef.current) {
            scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
            setShowJump(false);
        }
    }, [filtered.length, pending.map(turn => turn.text).join(''), follow]);

    const handleScroll = useCallback(event => {
        const element = event.currentTarget;
        const distance = element.scrollHeight - element.scrollTop - element.clientHeight;
        const atBottom = distance < 64;
        setFollow(atBottom);
        setShowJump(distance >= 160);
    }, []);

    const handleSeek = useCallback(
        turn => {
            if (seekable) onSeek?.(turn);
        },
        [seekable, onSeek]
    );

    const handleCopyTurn = useCallback(async turn => {
        const text = `[${formatMs(turn.startMs)}] ${turn.speaker}: ${turn.text}`;
        try {
            await navigator.clipboard.writeText(text);
            setCopiedId(turn.id);
            setTimeout(() => setCopiedId(current => (current === turn.id ? null : current)), 2000);
        } catch {
            // Copying is best effort; the text stays selectable regardless.
        }
    }, []);

    const handleCopyAll = useCallback(async () => {
        const text = filtered.map(turn => `[${formatMs(turn.startMs)}] ${turn.speaker}:\n${turn.text}`).join('\n\n');
        try {
            await navigator.clipboard.writeText(text);
            setCopiedAll(true);
            setTimeout(() => setCopiedAll(false), 2000);
        } catch {}
    }, [filtered]);

    const startRename = useCallback(speaker => {
        if (!isConnected || !onRenameSpeaker) return;
        setRenaming(speaker);
        setDraftName(speaker);
        setRenameError('');
    }, [isConnected, onRenameSpeaker]);

    const submitRename = useCallback(
        async next => {
            const result = await onRenameSpeaker?.(renaming, next);
            if (result?.ok) setRenaming(null);
            else setRenameError(result?.message || 'Could not rename this speaker.');
        },
        [renaming, onRenameSpeaker]
    );

    // The transcript is only as live as the engine behind it, so say which one
    // is running rather than leaving an empty panel unexplained.
    const detected = stt?.languageMode === 'auto' ? languageName(stt.detectedLanguage) : languageName(stt?.language);
    const sttNotice = !stt
        ? null
        : stt.engine === 'unavailable'
          ? {
                variant: 'warning',
                icon: TriangleAlert,
                label: 'No transcription engine',
                hint: 'Add your transcription API key in Settings to start live transcription.',
            }
          : stt.status === 'ready'
            ? {
                  variant: 'success',
                  icon: Cpu,
                  label: detected ? `Cloud transcription · ${detected}` : 'Cloud transcription',
                  hint: stt.provider === 'sarvam' ? 'The completed recording is transcribed after the meeting.' : 'Speech is streamed to Sarvam while the meeting is running.',
              }
            : stt.status === 'starting'
              ? { variant: 'muted', icon: Cpu, label: 'Connecting', hint: 'Connecting to your transcription service.' }
              : stt.status === 'failed'
                ? {
                      variant: 'destructive',
                      icon: TriangleAlert,
                      label: 'Engine failed',
                      hint: stt.error || 'The transcription engine failed to start.',
                  }
                : { variant: 'muted', icon: Cpu, label: 'Ready when you are', hint: 'Start a meeting to begin transcription.' };

    const totalWords = speakerStats.reduce((acc, stat) => acc + stat.words, 0);

    return (
        <section aria-label="Transcript" className="ks-transcript relative flex h-full min-w-0 flex-1 flex-col overflow-hidden">
            <div className="ks-transcript-toolbar flex flex-wrap items-center justify-between gap-2 px-4 pb-3 pt-4">
                <div className="flex items-center gap-2">
                    <MessageSquareText className="size-4 text-muted-foreground" aria-hidden="true" />
                    <div className="ks-transcript-heading">
                        <h3 className="text-headline font-semibold">{liveSession ? 'Live transcript' : 'Transcript'}</h3>
                        {liveSession && <p>{isPaused ? 'Recording paused' : 'Capturing your conversation'}</p>}
                    </div>
                    {!liveSession && <Badge variant="muted" className="tnum">
                        {turns.length} {turns.length === 1 ? 'turn' : 'turns'}
                    </Badge>}
                    {sttNotice && (
                        <Tooltip>
                            <TooltipTrigger asChild>
                                <Badge variant={sttNotice.variant}>
                                    <sttNotice.icon aria-hidden="true" />
                                    {sttNotice.label}
                                </Badge>
                            </TooltipTrigger>
                            <TooltipContent>{sttNotice.hint}</TooltipContent>
                        </Tooltip>
                    )}
                </div>

                <div className="flex items-center gap-1">
                    {liveSession && <Button variant="ghost" size="iconXs" aria-label="Search and filter transcript" aria-expanded={filtersOpen} onClick={() => setFiltersOpen(value => !value)}><Search /></Button>}
                    {isLive && (
                        <Button
                            variant={follow ? 'tinted' : 'ghost'}
                            size="xs"
                            onClick={() => setFollow(value => !value)}
                            aria-pressed={follow}
                        >
                            {follow ? 'Following' : 'Paused'}
                        </Button>
                    )}
                    <Button variant="outline" size="xs" onClick={handleCopyAll} disabled={turns.length === 0}>
                        {copiedAll ? <Check className="text-success" aria-hidden="true" /> : <Copy aria-hidden="true" />}
                        {copiedAll ? 'Copied' : 'Copy all'}
                    </Button>
                </div>
            </div>

            {(!liveSession || filtersOpen) && <div className="ks-transcript-discovery flex items-center gap-2 px-4 pb-3">
                <div className="relative min-w-0 flex-1 sm:max-w-xs">
                    <Search className="pointer-events-none absolute left-2 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
                    <Input
                        type="search"
                        placeholder="Search transcript"
                        aria-label="Search transcript"
                        value={query}
                        onChange={event => setQuery(event.target.value)}
                        className="h-9 pl-8 pr-8 text-callout"
                    />
                    {query && (
                        <Button
                            variant="ghost"
                            size="iconXs"
                            onClick={() => setQuery('')}
                            aria-label="Clear search"
                            className="absolute right-1 top-1/2 -translate-y-1/2 rounded-full text-muted-foreground"
                        >
                            <X aria-hidden="true" />
                        </Button>
                    )}
                </div>

                <SegmentedControl
                    className="w-auto"
                    value={speakerFilter}
                    onValueChange={setSpeakerFilter}
                    aria-label="Filter by speaker"
                >
                    <SegmentedItem value="ALL" className="w-auto flex-none px-2">
                        Everyone
                    </SegmentedItem>
                    {speakers.map(speaker => (
                        <SegmentedItem key={speaker} value={speaker} className="w-auto flex-none whitespace-nowrap px-2">
                            {speaker}
                        </SegmentedItem>
                    ))}
                </SegmentedControl>
            </div>}

            <div ref={scrollRef} onScroll={handleScroll} className="ks-transcript-list min-h-0 flex-1 overflow-y-auto">
                {filtered.length === 0 && pending.length === 0 ? (
                    <div className="flex h-full flex-col justify-center px-8 py-16">
                        <p className="text-headline font-semibold">{needle ? 'No matches' : isLive ? 'Listening to your meeting…' : 'No transcript yet'}</p>
                        <p className="mt-1 max-w-xs text-callout text-muted-foreground">
                            {needle
                                ? `Nothing matches “${query}”. Clear the search to see every turn.`
                                : isLive
                                  ? 'Speak, or play the meeting audio, and turns appear here as they are transcribed.'
                                  : 'Start recording to capture a transcript, separated into you and the other participants.'}
                        </p>
                    </div>
                ) : (
                    <ul className="divide-y divide-border">
                        {filtered.map(turn => {
                            const style = getSpeakerStyle(turn.speaker);
                            const isCopied = copiedId === turn.id;
                            return (
                                <li
                                    key={turn.id}
                                    data-turn-id={turn.id}
                                    className={cn(
                                        'ks-transcript-turn turn-in group flex items-start gap-4 px-4 py-4 transition-colors hover:bg-muted/60',
                                        citationFocus?.turnIds?.includes(turn.id) && 'bg-primary/10 ring-1 ring-inset ring-primary/30'
                                    )}
                                >
                                    <div
                                        className={cn(
                                            'flex size-8 shrink-0 items-center justify-center rounded-full text-footnote font-semibold',
                                            style.avatar
                                        )}
                                        aria-hidden="true"
                                    >
                                        {style.isYou ? <User className="size-4" /> : initialsFor(turn.speaker)}
                                    </div>

                                    <div className="min-w-0 flex-1">
                                        <div className="flex items-baseline gap-2">
                                            {renaming === turn.speaker ? (
                                                <form
                                                    className="flex items-center gap-1"
                                                    onSubmit={event => {
                                                        event.preventDefault();
                                                        submitRename(draftName);
                                                    }}
                                                >
                                                    <Input
                                                        aria-label="Speaker name"
                                                        autoFocus
                                                        value={draftName}
                                                        onChange={event => setDraftName(event.target.value)}
                                                        className="h-7 w-40 text-callout"
                                                    />
                                                    <Button type="submit" variant="ghost" size="iconXs" aria-label="Save speaker name">
                                                        <Check />
                                                    </Button>
                                                    <Button
                                                        type="button"
                                                        variant="ghost"
                                                        size="iconXs"
                                                        aria-label="Cancel speaker rename"
                                                        onClick={() => setRenaming(null)}
                                                    >
                                                        <X />
                                                    </Button>
                                                </form>
                                            ) : (
                                                <button
                                                    type="button"
                                                    onClick={() => startRename(turn.speaker)}
                                                    disabled={!isConnected || !onRenameSpeaker}
                                                    title={onRenameSpeaker ? 'Rename speaker' : undefined}
                                                    className="truncate text-left text-headline font-semibold transition-colors hover:text-primary disabled:hover:text-inherit"
                                                >
                                                    {turn.speaker}
                                                </button>
                                            )}
                                            {seekable ? (
                                                <button
                                                    type="button"
                                                    onClick={() => handleSeek(turn)}
                                                    title="Play from here"
                                                    className="tnum shrink-0 text-footnote text-muted-foreground transition-colors hover:text-primary"
                                                >
                                                    {formatMs(turn.startMs)}
                                                </button>
                                            ) : (
                                                <span className="tnum shrink-0 text-footnote text-muted-foreground">{formatMs(turn.startMs)}</span>
                                            )}
                                            <span className="ks-transcript-source shrink-0 text-footnote text-muted-foreground">
                                                {turn.stream === 'mic' ? 'Microphone' : 'Meeting audio'}
                                            </span>

                                            <div className="ml-auto flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity duration-150 focus-within:opacity-100 group-hover:opacity-100">
                                                {onAsk && (
                                                    <Tooltip>
                                                        <TooltipTrigger asChild>
                                                            <Button
                                                                variant="ghost"
                                                                size="iconXs"
                                                                onClick={() => onAsk(turn)}
                                                                aria-label={`Ask AI about what ${turn.speaker} said`}
                                                                className="text-muted-foreground hover:text-primary"
                                                            >
                                                                <Sparkles aria-hidden="true" />
                                                            </Button>
                                                        </TooltipTrigger>
                                                        <TooltipContent>Ask AI about this</TooltipContent>
                                                    </Tooltip>
                                                )}
                                                <Tooltip>
                                                    <TooltipTrigger asChild>
                                                        <Button
                                                            variant="ghost"
                                                            size="iconXs"
                                                            onClick={() => handleCopyTurn(turn)}
                                                            aria-label={`Copy what ${turn.speaker} said`}
                                                            className="text-muted-foreground"
                                                        >
                                                            {isCopied ? <Check className="text-success" aria-hidden="true" /> : <Copy aria-hidden="true" />}
                                                        </Button>
                                                    </TooltipTrigger>
                                                    <TooltipContent>Copy turn</TooltipContent>
                                                </Tooltip>
                                            </div>
                                        </div>

                                        <p className="mt-1 select-text text-body text-foreground">{turn.text}</p>
                                    </div>
                                </li>
                            );
                        })}

                        {pending.map(turn => (
                            <li key={turn.id} className="ks-transcript-pending turn-in flex items-start gap-4 px-4 py-4" aria-live="polite">
                                <div
                                    className={cn(
                                        'flex size-8 shrink-0 items-center justify-center rounded-full text-footnote font-semibold',
                                        getSpeakerStyle(turn.speaker).avatar
                                    )}
                                    aria-hidden="true"
                                >
                                    {turn.stream === 'mic' ? <User className="size-4" /> : initialsFor(turn.speaker)}
                                </div>
                                <div className="min-w-0 flex-1">
                                    <div className="flex items-baseline gap-2">
                                        <h4 className="truncate text-headline font-semibold">{turn.speaker}</h4>
                                        <Badge variant="tinted" className="ks-speaking-badge">
                                            <JumpingBalls size="sm" />
                                            speaking
                                        </Badge>
                                    </div>
                                    <p className="mt-1 text-body text-foreground">
                                        <StreamingText text={turn.text} stream />
                                    </p>
                                </div>
                            </li>
                        ))}
                    </ul>
                )}

                {isLive && !pending.length && filtered.length > 0 && (
                    <div className="flex items-center gap-2 px-4 pb-3 pt-1 text-footnote text-muted-foreground" role="status">
                        <JumpingBalls size="sm" className="text-primary" />
                        Listening
                    </div>
                )}
                {renameError && (
                    <p className="px-4 pb-3 text-footnote text-destructive" role="alert">
                        {renameError}
                    </p>
                )}
                <div ref={endRef} />
            </div>

            {showJump && (
                <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                        setFollow(true);
                        endRef.current?.scrollIntoView({ block: 'end', behavior: 'smooth' });
                    }}
                    className="absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full shadow-md"
                >
                    <ArrowDownToLine aria-hidden="true" />
                    Latest turns
                </Button>
            )}

            {speakerStats.length > 0 && (
                <details className="ks-talk-time px-4 pb-4 pt-3 hairline-top">
                    <summary>Speaker activity <span>{speakers.length} participants · {totalWords} words</span></summary>
                    <div className="mb-2 flex items-center justify-between text-footnote text-muted-foreground">
                        <span>Talk time</span>
                        <span className="tnum">{totalWords} words</span>
                    </div>

                    <div className="flex h-1 w-full overflow-hidden rounded-full bg-muted" role="presentation">
                        {speakerStats.map(stat => (
                            <div
                                key={stat.speaker}
                                className={cn('h-full', getSpeakerStyle(stat.speaker).bar)}
                                style={{ width: `${stat.percentage}%` }}
                            />
                        ))}
                    </div>

                    <ul className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1">
                        {speakerStats.map(stat => (
                            <li key={stat.speaker} className="flex items-center gap-1 text-footnote">
                                <span className={cn('size-2 rounded-full', getSpeakerStyle(stat.speaker).bar)} aria-hidden="true" />
                                <span className="font-medium">{stat.speaker}</span>
                                <span className="tnum text-muted-foreground">
                                    {stat.percentage}% · {stat.turns} {stat.turns === 1 ? 'turn' : 'turns'}
                                </span>
                            </li>
                        ))}
                    </ul>
                </details>
            )}
        </section>
    );
}
