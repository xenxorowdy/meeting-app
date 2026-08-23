import React, { useState } from 'react';
import { Mic, MicOff, Volume2, VolumeX, Play, Pause, Square, Sparkles, SlidersHorizontal, Pencil, Check } from 'lucide-react';
import { cn } from '@/utils/cn';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { SESSION_STATES } from '@/hooks/useMeetingSession';

/**
 * Format duration in seconds to MM:SS or HH:MM:SS
 */
function formatDuration(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    if (h > 0) {
        return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
    }
    return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

const SEGMENT_COUNT = 14;

function LevelMeter({ level = 0, isMuted = false, label }) {
    const filled = isMuted ? 0 : Math.round((Math.min(100, Math.max(0, level)) / 100) * SEGMENT_COUNT);

    return (
        <div
            role="meter"
            aria-label={`${label} input level`}
            aria-valuenow={isMuted ? 0 : Math.round(level)}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuetext={isMuted ? 'Muted' : `${Math.round(level)} percent`}
            className="flex h-3.5 items-end gap-[2px]"
        >
            {Array.from({ length: SEGMENT_COUNT }).map((_, index) => {
                const isOn = index < filled;
                const ratio = (index + 1) / SEGMENT_COUNT;
                return (
                    <span
                        key={index}
                        className={cn(
                            'w-[3px] rounded-full transition-[background-color,height] duration-100 ease-apple-standard',
                            isOn ? 'h-full' : 'h-[40%]',
                            !isOn && 'bg-foreground/25',
                            isOn && ratio > 0.92 && 'bg-destructive',
                            isOn && ratio > 0.78 && ratio <= 0.92 && 'bg-warning',
                            isOn && ratio <= 0.78 && 'bg-success'
                        )}
                    />
                );
            })}
        </div>
    );
}

function StreamMeter({ label, description, level, isMuted, onToggle, MutedIcon, ActiveIcon, unavailable = false, unavailableHint }) {
    return (
        <div className="flex items-center gap-2.5">
            <Tooltip>
                <TooltipTrigger asChild>
                    <Button
                        variant={isMuted ? 'destructive-tinted' : 'ghost'}
                        size="iconSm"
                        onClick={onToggle}
                        disabled={unavailable}
                        aria-pressed={isMuted}
                        aria-label={isMuted ? `Unmute ${label}` : `Mute ${label}`}
                    >
                        {isMuted || unavailable ? <MutedIcon aria-hidden="true" /> : <ActiveIcon aria-hidden="true" />}
                    </Button>
                </TooltipTrigger>
                <TooltipContent>{unavailable ? unavailableHint : isMuted ? `Unmute ${description}` : `Mute ${description}`}</TooltipContent>
            </Tooltip>

            <div className="flex flex-col gap-1">
                <div className="flex items-center gap-2">
                    <span className="text-footnote font-medium text-foreground">{label}</span>
                    <span className={cn('tnum text-footnote', isMuted && !unavailable ? 'text-destructive' : 'text-muted-foreground')}>
                        {unavailable ? 'No signal' : isMuted ? 'Muted' : `${Math.round(level)}%`}
                    </span>
                </div>
                <LevelMeter level={unavailable ? 0 : level} isMuted={isMuted || unavailable} label={label} />
            </div>
        </div>
    );
}

export function LiveMeetingHUD({
    sessionState,
    durationSeconds,
    activeMeeting,
    audioLevels = { mic: 0, system: 0 },
    micMuted = false,
    systemAudioMuted = false,
    systemAudioSeen = false,
    canRecord = true,
    onStartMeeting,
    onPauseMeeting,
    onResumeMeeting,
    onStopMeeting,
    onToggleMic,
    onToggleSystemAudio,
    onUpdateTitle,
    onOpenSettings,
}) {
    const [isEditingTitle, setIsEditingTitle] = useState(false);
    const [titleInput, setTitleInput] = useState(activeMeeting?.title || '');

    const isRecording = sessionState === SESSION_STATES.RECORDING;
    const isPaused = sessionState === SESSION_STATES.PAUSED;
    const isProcessing = sessionState === SESSION_STATES.PROCESSING;
    const isIdle = sessionState === SESSION_STATES.IDLE || sessionState === SESSION_STATES.COMPLETED;
    const isActive = isRecording || isPaused;

    const handleTitleSubmit = event => {
        event.preventDefault();
        if (titleInput.trim() && onUpdateTitle) {
            onUpdateTitle(titleInput.trim());
        }
        setIsEditingTitle(false);
    };

    const startEditingTitle = () => {
        setTitleInput(activeMeeting?.title || 'Meeting');
        setIsEditingTitle(true);
    };

    const showTimer = isActive || isProcessing || Boolean(activeMeeting?.durationSeconds);
    const elapsed = isActive ? durationSeconds : activeMeeting?.durationSeconds || 0;

    return (
        <section aria-label="Recording controls" className="rounded-xl border bg-card p-3 shadow-card sm:p-4">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                <div className="flex min-w-0 flex-1 items-center gap-3">
                    {isRecording && (
                        <Badge variant="destructive">
                            <span className="size-[6px] animate-breathe rounded-full bg-destructive" aria-hidden="true" />
                            Recording
                        </Badge>
                    )}
                    {isPaused && (
                        <Badge variant="warning">
                            <Pause aria-hidden="true" />
                            Paused
                        </Badge>
                    )}
                    {isProcessing && (
                        <Badge variant="tinted">
                            <Sparkles className="animate-breathe" aria-hidden="true" />
                            Summarizing
                        </Badge>
                    )}
                    {isIdle && <Badge variant="muted">Ready</Badge>}

                    <div className="flex min-w-0 items-center gap-1">
                        {isEditingTitle ? (
                            <form onSubmit={handleTitleSubmit} className="flex items-center gap-1.5">
                                <Input
                                    value={titleInput}
                                    onChange={event => setTitleInput(event.target.value)}
                                    onKeyDown={event => {
                                        if (event.key === 'Escape') setIsEditingTitle(false);
                                    }}
                                    onBlur={handleTitleSubmit}
                                    aria-label="Meeting title"
                                    autoFocus
                                    className="h-8 w-56 text-title3 font-semibold"
                                />
                                <Button type="submit" variant="tinted" size="iconSm" aria-label="Save title">
                                    <Check aria-hidden="true" />
                                </Button>
                            </form>
                        ) : (
                            <>
                                <h2 className="truncate text-title3 font-semibold">
                                    {activeMeeting?.title || (isIdle ? 'Ready to record' : 'Untitled meeting')}
                                </h2>
                                <Tooltip>
                                    <TooltipTrigger asChild>
                                        <Button
                                            variant="ghost"
                                            size="iconXs"
                                            onClick={startEditingTitle}
                                            disabled={!activeMeeting}
                                            aria-label="Rename meeting"
                                            className="text-muted-foreground"
                                        >
                                            <Pencil aria-hidden="true" />
                                        </Button>
                                    </TooltipTrigger>
                                    <TooltipContent>Rename meeting</TooltipContent>
                                </Tooltip>
                            </>
                        )}
                    </div>

                    {showTimer && (
                        <>
                            <Separator orientation="vertical" className="h-8" />
                            <div className="flex flex-col">
                                <span className="text-footnote text-muted-foreground">Elapsed</span>
                                <span className="tnum text-title2 font-semibold leading-tight">{formatDuration(elapsed)}</span>
                            </div>
                        </>
                    )}
                </div>

                {isActive && (
                    <div className="flex items-center gap-4 rounded-lg bg-muted px-3 py-2">
                        <StreamMeter
                            label="You"
                            description="your microphone"
                            level={audioLevels.mic}
                            isMuted={micMuted}
                            onToggle={onToggleMic}
                            MutedIcon={MicOff}
                            ActiveIcon={Mic}
                        />
                        <Separator orientation="vertical" className="h-9" />
                        <StreamMeter
                            label="Others"
                            description="meeting audio from other participants"
                            level={audioLevels.system}
                            isMuted={systemAudioMuted}
                            onToggle={onToggleSystemAudio}
                            MutedIcon={VolumeX}
                            ActiveIcon={Volume2}
                            unavailable={!systemAudioSeen}
                            unavailableHint="No system audio is reaching the backend. It needs the native capture helper for this platform."
                        />
                    </div>
                )}

                <div className="flex items-center justify-end gap-2">
                    {isIdle && (
                        <Tooltip>
                            <TooltipTrigger asChild>
                                <Button onClick={() => onStartMeeting && onStartMeeting()} disabled={!canRecord}>
                                    <Mic aria-hidden="true" />
                                    Start recording
                                </Button>
                            </TooltipTrigger>
                            <TooltipContent>
                                {canRecord ? (
                                    <>
                                        Start recording <span className="text-muted-foreground">⌘R</span>
                                    </>
                                ) : (
                                    'The backend is offline, so a meeting cannot be started.'
                                )}
                            </TooltipContent>
                        </Tooltip>
                    )}

                    {isRecording && (
                        <Button variant="outline" onClick={onPauseMeeting}>
                            <Pause aria-hidden="true" />
                            Pause
                        </Button>
                    )}

                    {isPaused && (
                        <Button variant="outline" onClick={onResumeMeeting}>
                            <Play aria-hidden="true" />
                            Resume
                        </Button>
                    )}

                    {isActive && (
                        <Tooltip>
                            <TooltipTrigger asChild>
                                <Button variant="destructive" onClick={onStopMeeting} disabled={isProcessing}>
                                    <Square className="fill-current" aria-hidden="true" />
                                    End & summarize
                                </Button>
                            </TooltipTrigger>
                            <TooltipContent>
                                End meeting and generate notes <span className="text-muted-foreground">⌘R</span>
                            </TooltipContent>
                        </Tooltip>
                    )}

                    {onOpenSettings && (
                        <Tooltip>
                            <TooltipTrigger asChild>
                                <Button variant="ghost" size="iconSm" onClick={onOpenSettings} aria-label="Capture settings">
                                    <SlidersHorizontal aria-hidden="true" />
                                </Button>
                            </TooltipTrigger>
                            <TooltipContent>Capture settings</TooltipContent>
                        </Tooltip>
                    )}
                </div>
            </div>
        </section>
    );
}
