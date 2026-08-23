import React, { useState, useRef, useEffect } from 'react';
import { Search, Copy, Check, MessageSquare, X, User, Cpu, TriangleAlert } from 'lucide-react';
import { cn } from '@/utils/cn';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

/**
 * Format timestamp in ms to MM:SS
 */
function formatMs(ms = 0) {
    const totalSeconds = Math.floor(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
}

const SPEAKER_PALETTE = ['bg-speaker-1', 'bg-speaker-2', 'bg-speaker-3', 'bg-speaker-4'];

/**
 * Deterministic speaker badge color mapping
 */
function getSpeakerStyle(speaker = '') {
    if (speaker === 'You' || speaker.toLowerCase().startsWith('you')) {
        return { avatar: 'bg-primary text-primary-foreground', bar: 'bg-primary', isYou: true };
    }

    const hash = speaker.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
    const fill = SPEAKER_PALETTE[hash % SPEAKER_PALETTE.length];
    return { avatar: `${fill} text-background`, bar: fill, isYou: false };
}

function initialsFor(speaker = '') {
    const words = speaker
        .replace(/\(.*?\)/g, '')
        .trim()
        .split(/\s+/)
        .filter(Boolean);
    if (words.length === 0) return 'S';
    if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
    return (words[0][0] + words[1][0]).toUpperCase();
}

export function TranscriptView({
    turns = [],
    filteredTurns = [],
    searchQuery = '',
    onSearchChange,
    selectedSpeakerFilter = 'ALL',
    onSpeakerFilterChange,
    speakers = [],
    speakerStats = [],
    autoScroll = true,
    onToggleAutoScroll,
    isLive = false,
    stt = null,
}) {
    const [copiedId, setCopiedId] = useState(null);
    const [copiedFull, setCopiedFull] = useState(false);
    const scrollContainerRef = useRef(null);

    // Auto-scroll to bottom on new turns if enabled
    useEffect(() => {
        if (autoScroll && scrollContainerRef.current) {
            scrollContainerRef.current.scrollTop = scrollContainerRef.current.scrollHeight;
        }
    }, [turns, autoScroll]);

    const handleCopyTurn = turn => {
        const textToCopy = `[${formatMs(turn.startMs)}] ${turn.speaker}: ${turn.text}`;
        navigator.clipboard.writeText(textToCopy);
        setCopiedId(turn.id);
        setTimeout(() => setCopiedId(null), 2000);
    };

    const handleCopyAll = () => {
        const allText = turns.map(t => `[${formatMs(t.startMs)}] ${t.speaker}:\n${t.text}`).join('\n\n');
        navigator.clipboard.writeText(allText);
        setCopiedFull(true);
        setTimeout(() => setCopiedFull(false), 2000);
    };

    const totalWords = speakerStats.reduce((acc, stat) => acc + stat.words, 0);

    // The transcript is only as live as the engine behind it, so say which one is
    // running rather than leaving an empty panel unexplained.
    const sttNotice = !stt
        ? null
        : stt.engine === 'unavailable'
          ? {
                variant: 'warning',
                icon: TriangleAlert,
                label: 'No transcription engine',
                hint: 'Install whisperkit-cli so the backend can transcribe speech on the Neural Engine.',
            }
          : stt.status === 'ready'
            ? { variant: 'success', icon: Cpu, label: 'On device', hint: `Whisper ${stt.model} on the Neural Engine` }
            : stt.status === 'starting'
              ? { variant: 'muted', icon: Cpu, label: 'Loading model', hint: `Loading Whisper ${stt.model}` }
              : stt.status === 'failed'
                ? {
                      variant: 'destructive',
                      icon: TriangleAlert,
                      label: 'Engine failed',
                      hint: stt.error || 'The transcription engine failed to start.',
                  }
                : { variant: 'muted', icon: Cpu, label: 'Engine idle', hint: `Whisper ${stt.model} is not loaded yet` };

    return (
        <section aria-label="Transcript" className="flex h-full flex-col overflow-hidden rounded-xl border bg-card shadow-card">
            <div className="flex flex-col gap-3 p-3 hairline-bottom sm:p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                        <MessageSquare className="size-4 text-muted-foreground" aria-hidden="true" />
                        <h3 className="text-headline font-semibold">Transcript</h3>
                        <Badge variant="muted" className="tnum">
                            {turns.length} {turns.length === 1 ? 'turn' : 'turns'}
                        </Badge>
                        {isLive && (
                            <span className="flex items-center gap-1.5 text-footnote font-medium text-destructive" aria-live="polite">
                                <span className="size-[6px] animate-breathe rounded-full bg-destructive" aria-hidden="true" />
                                Live
                            </span>
                        )}
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

                    <div className="flex items-center gap-1.5">
                        {isLive && (
                            <Button
                                variant={autoScroll ? 'tinted' : 'ghost'}
                                size="xs"
                                onClick={onToggleAutoScroll}
                                aria-pressed={autoScroll}
                                className="text-muted-foreground data-[on=true]:text-primary"
                                data-on={autoScroll}
                            >
                                Auto-scroll
                            </Button>
                        )}
                        <Button variant="outline" size="xs" onClick={handleCopyAll} disabled={turns.length === 0}>
                            {copiedFull ? <Check className="text-success" aria-hidden="true" /> : <Copy aria-hidden="true" />}
                            {copiedFull ? 'Copied' : 'Copy all'}
                        </Button>
                    </div>
                </div>

                <div className="flex flex-col gap-2">
                    <div className="relative flex-1">
                        <Search
                            className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
                            aria-hidden="true"
                        />
                        <Input
                            type="search"
                            placeholder="Search transcript"
                            aria-label="Search transcript"
                            value={searchQuery}
                            onChange={event => onSearchChange && onSearchChange(event.target.value)}
                            className="h-8 rounded-full pl-8 pr-8 text-callout"
                        />
                        {searchQuery && (
                            <Button
                                variant="ghost"
                                size="iconXs"
                                onClick={() => onSearchChange && onSearchChange('')}
                                aria-label="Clear search"
                                className="absolute right-0.5 top-1/2 -translate-y-1/2 rounded-full text-muted-foreground"
                            >
                                <X aria-hidden="true" />
                            </Button>
                        )}
                    </div>

                    <div className="flex items-center gap-1.5 overflow-x-auto pb-0.5" role="group" aria-label="Filter by speaker">
                        <Button
                            variant={selectedSpeakerFilter === 'ALL' ? 'default' : 'secondary'}
                            size="xs"
                            className="rounded-full"
                            aria-pressed={selectedSpeakerFilter === 'ALL'}
                            onClick={() => onSpeakerFilterChange && onSpeakerFilterChange('ALL')}
                        >
                            Everyone
                        </Button>

                        {speakers.map(speaker => {
                            const isSelected = selectedSpeakerFilter === speaker;
                            return (
                                <Button
                                    key={speaker}
                                    variant={isSelected ? 'default' : 'secondary'}
                                    size="xs"
                                    className="whitespace-nowrap rounded-full"
                                    aria-pressed={isSelected}
                                    onClick={() => onSpeakerFilterChange && onSpeakerFilterChange(speaker)}
                                >
                                    {speaker}
                                </Button>
                            );
                        })}
                    </div>
                </div>
            </div>

            <div ref={scrollContainerRef} className="flex-1 divide-y divide-border overflow-y-auto">
                {filteredTurns.length === 0 ? (
                    <div className="flex h-full flex-col items-center justify-center px-6 py-12 text-center">
                        <div className="mb-3 flex size-10 items-center justify-center rounded-full bg-muted text-muted-foreground">
                            <MessageSquare className="size-5" aria-hidden="true" />
                        </div>
                        <p className="text-headline font-semibold">{searchQuery ? 'No matches' : 'No speech yet'}</p>
                        <p className="mt-1 max-w-xs text-callout text-muted-foreground">
                            {searchQuery
                                ? `Nothing in this transcript matches “${searchQuery}”. Clear the search to see every turn.`
                                : isLive
                                  ? 'Speak, or play the meeting audio, and turns appear here as they are transcribed.'
                                  : 'Start recording to capture a transcript, separated into you and the other participants.'}
                        </p>
                    </div>
                ) : (
                    filteredTurns.map(turn => {
                        const style = getSpeakerStyle(turn.speaker);
                        const isCopied = copiedId === turn.id;

                        return (
                            <article key={turn.id} className="group flex items-start gap-3 px-3 py-3 transition-colors hover:bg-muted/60 sm:px-4">
                                <div
                                    className={cn(
                                        'flex size-7 shrink-0 items-center justify-center rounded-full text-footnote font-semibold',
                                        style.avatar
                                    )}
                                    aria-hidden="true"
                                >
                                    {style.isYou ? <User className="size-3.5" /> : initialsFor(turn.speaker)}
                                </div>

                                <div className="min-w-0 flex-1">
                                    <div className="flex items-baseline gap-2">
                                        <h4 className="truncate text-headline font-semibold">{turn.speaker}</h4>
                                        <span className="tnum shrink-0 text-footnote text-muted-foreground">{formatMs(turn.startMs)}</span>
                                        <span className="shrink-0 text-footnote text-muted-foreground">
                                            {turn.stream === 'mic' ? 'Microphone' : 'Meeting audio'}
                                        </span>

                                        <Tooltip>
                                            <TooltipTrigger asChild>
                                                <Button
                                                    variant="ghost"
                                                    size="iconXs"
                                                    onClick={() => handleCopyTurn(turn)}
                                                    aria-label={`Copy what ${turn.speaker} said`}
                                                    className="ml-auto shrink-0 text-muted-foreground opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100"
                                                >
                                                    {isCopied ? <Check className="text-success" aria-hidden="true" /> : <Copy aria-hidden="true" />}
                                                </Button>
                                            </TooltipTrigger>
                                            <TooltipContent>Copy turn</TooltipContent>
                                        </Tooltip>
                                    </div>

                                    <p className="mt-1 select-text text-body text-foreground">{turn.text}</p>
                                </div>
                            </article>
                        );
                    })
                )}
            </div>

            {speakerStats.length > 0 && (
                <div className="p-3 hairline-top sm:px-4">
                    <div className="mb-2 flex items-center justify-between text-footnote text-muted-foreground">
                        <span>Talk time</span>
                        <span className="tnum">{totalWords} words</span>
                    </div>

                    <div className="flex h-1.5 w-full overflow-hidden rounded-full bg-muted" role="presentation">
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
                            <li key={stat.speaker} className="flex items-center gap-1.5 text-footnote">
                                <span className={cn('size-2 rounded-full', getSpeakerStyle(stat.speaker).bar)} aria-hidden="true" />
                                <span className="font-medium">{stat.speaker}</span>
                                <span className="tnum text-muted-foreground">
                                    {stat.percentage}% · {stat.turns} {stat.turns === 1 ? 'turn' : 'turns'}
                                </span>
                            </li>
                        ))}
                    </ul>
                </div>
            )}
        </section>
    );
}
