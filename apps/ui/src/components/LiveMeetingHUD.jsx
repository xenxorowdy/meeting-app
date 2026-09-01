import React, { useState } from 'react';
import { Mic, MicOff, Volume2, VolumeX, Play, Pause, Square, SlidersHorizontal, Pencil, Check } from 'lucide-react';
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
            className="flex h-4 items-end gap-[2px]"
        >
            {Array.from({ length: SEGMENT_COUNT }).map((_, index) => {
                const isOn = index < filled;
                const ratio = (index + 1) / SEGMENT_COUNT;
                return (
                    <span
                        key={index}
                        className={cn(
                            'w-[3px] rounded-full transition-[background-color,height] duration-100 ease-out',
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
        <div className="flex items-center gap-2">
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

function eventClock(event) {
    const startMs = Date.parse(event?.start);
    if (!Number.isFinite(startMs)) return 'Next';
    const started = startMs <= Date.now();
    const clock = new Date(startMs).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    return started ? 'Now' : clock;
}

export function LiveMeetingHUD({
    sessionState,
    durationSeconds,
    activeMeeting,
    audioLevels = { mic: 0, system: 0 },
    micMuted = false,
    systemAudioMuted = false,
    systemAudioSeen = false,
    recordingState = null,
    upcomingEvent = null,
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
        <section aria-label="Recording controls" className="rounded-xl border p-4 sm:p-4">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                <div className="flex min-w-0 flex-1 items-center gap-4">
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-callout">
                        {isRecording && (
                            <span className="flex items-center gap-2 font-medium">
                                <span className="size-[6px] animate-breathe rounded-full bg-destructive" aria-hidden="true" />
                                Recording
                            </span>
                        )}
                        {isPaused && <span className="font-medium text-warning">Paused</span>}
                        {isProcessing && <span className="font-medium text-muted-foreground">Summarizing</span>}
                        {isIdle && <span className="text-muted-foreground">Ready</span>}
                        {isIdle && upcomingEvent && (
                            <span className="min-w-0 truncate text-muted-foreground">
                                {eventClock(upcomingEvent)} · {upcomingEvent.title}
                            </span>
                        )}

                        {recordingState?.active && <span className="text-muted-foreground">Screen</span>}
                        {/* The recording carrying only your own voice is worth saying
                            during the meeting, while it can still be fixed. */}
                        {recordingState?.active && recordingState.hasSystemAudio === false && <span className="text-warning">No meeting audio</span>}
                    </div>

                    <div className="flex min-w-0 items-center gap-1">
                        {isEditingTitle ? (
                            <form onSubmit={handleTitleSubmit} className="flex items-center gap-1">
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
                    <div className="flex items-center gap-4 rounded-lg bg-muted px-4 py-2">
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
                                <Button onClick={() => onStartMeeting && onStartMeeting(upcomingEvent?.title, upcomingEvent)} disabled={!canRecord}>
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
