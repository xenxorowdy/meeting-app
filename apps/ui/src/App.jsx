import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { Home, Mic, FileText, CalendarDays, Play, Podcast, Settings, Download, Wifi, WifiOff, RotateCw, TriangleAlert, Sun, Moon } from 'lucide-react';
import { cn } from '@/utils/cn';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useTheme } from '@/lib/theme';
import { useMeetingSession, SESSION_STATES } from '@/hooks/useMeetingSession';
import { useTranscriptStream } from '@/hooks/useTranscriptStream';
import { useMeetingHistory } from '@/hooks/useMeetingHistory';
import { useCalendar } from '@/hooks/useCalendar';
import { currentOrNextEvent, eventForNow, attendeeNames } from '@/lib/calendarEvents';
import { useMeetingReminder } from '@/hooks/useMeetingReminder';
import { LiveMeetingHUD } from '@/components/LiveMeetingHUD';
import { TranscriptView } from '@/components/TranscriptView';
import { SummaryEditor } from '@/components/SummaryEditor';
import { HistoryExplorer } from '@/components/HistoryExplorer';
import { ExportModal } from '@/components/ExportModal';
import { SettingsModal } from '@/components/SettingsModal';
import { RecordingPlayer } from '@/components/RecordingPlayer';
import { SourcePicker } from '@/components/SourcePicker';
import { Sidebar } from '@/components/Sidebar';
import { HomeView } from '@/components/HomeView';
import { PodcastStudio } from '@/components/PodcastStudio';
import { LiveNotes } from '@/components/LiveNotes';
import { isRecordingSupported } from '@/lib/screenRecorder';

// In the desktop shell the window keeps macOS traffic lights over the toolbar,
// so the leading content has to start clear of them.
const IS_DESKTOP_SHELL = typeof navigator !== 'undefined' && /Electron/i.test(navigator.userAgent);

const VIEWS = [
    { value: 'home', label: 'Home', icon: Home, shortcut: '⌘1' },
    { value: 'live', label: 'Live', icon: Mic, shortcut: '⌘2' },
    { value: 'notes', label: 'Notes', icon: FileText, shortcut: '⌘3' },
    { value: 'podcast', label: 'Podcast', icon: Podcast, shortcut: '⌘4' },
    { value: 'replay', label: 'Replay', icon: Play, shortcut: '⌘5' },
    { value: 'history', label: 'History', icon: CalendarDays, shortcut: '⌘6' },
];

export default function App() {
    const [theme, setTheme] = useTheme();

    const [activeTab, setActiveTab] = useState('home');
    const [isExportOpen, setIsExportOpen] = useState(false);
    const [isSettingsOpen, setIsSettingsOpen] = useState(false);
    const [pendingStart, setPendingStart] = useState(null);

    const {
        backendUrl,
        connection,
        isConnected,
        sessionState,
        activeMeeting,
        durationSeconds,
        audioLevels,
        systemAudioSeen,
        micMuted,
        systemAudioMuted,
        recordingState,
        error,
        micError,
        settings,
        license,
        engine,
        startMeeting,
        pauseMeeting,
        resumeMeeting,
        stopMeeting,
        loadMeeting,
        updateActiveMeeting,
        renameSpeaker,
        toggleMicMute,
        toggleSystemAudioMute,
        updateSettings,
        activateLicense,
        refresh,
        setOnLiveTurn,
        setOnMeetingCompleted,
        setOnCalendarConnection,
        addNote,
        deleteNote,
        clearError,
    } = useMeetingSession();

    const isRecording = sessionState === SESSION_STATES.RECORDING;
    const isPaused = sessionState === SESSION_STATES.PAUSED;
    const isProcessing = sessionState === SESSION_STATES.PROCESSING;
    const isIdle = !isRecording && !isPaused && !isProcessing;

    const {
        turns,
        filteredTurns,
        searchQuery,
        setSearchQuery,
        selectedSpeakerFilter,
        setSelectedSpeakerFilter,
        speakers,
        speakerStats,
        autoScroll,
        setAutoScroll,
        addTurn,
        clearTurns,
    } = useTranscriptStream({ turns: activeMeeting?.transcript });

    const history = useMeetingHistory({ enabled: isConnected });
    const calendar = useCalendar({ isConnected });
    const upcoming = currentOrNextEvent(calendar.events);

    const calendarEventsRef = useRef(calendar.events);
    calendarEventsRef.current = calendar.events;

    const invitedNames = useMemo(() => attendeeNames(activeMeeting?.metadata?.calendarEvent), [activeMeeting?.metadata?.calendarEvent]);

    // Live turns arrive over the backend socket.
    useEffect(() => {
        setOnLiveTurn(addTurn);
    }, [setOnLiveTurn, addTurn]);

    useEffect(() => {
        setOnCalendarConnection(calendar.handleConnectionEvent);
    }, [setOnCalendarConnection, calendar.handleConnectionEvent]);

    // A finished meeting is stored by the backend; reload the list and show its notes.
    useEffect(() => {
        setOnMeetingCompleted(() => {
            history.reload();
            setActiveTab('notes');
        });
    }, [setOnMeetingCompleted, history]);

    const startWithSource = useCallback(
        async (title, sourceId, event) => {
            clearTurns();
            setActiveTab('live');
            await startMeeting(title, { sourceId, event });
        },
        [clearTurns, startMeeting]
    );

    const handleStartRecording = useCallback(
        async (title, event) => {
            const linkedEvent = event || eventForNow(calendarEventsRef.current);
            const resolvedTitle = title || linkedEvent?.title || '';

            // Which screen to capture is a per-meeting choice, so ask at the point
            // of starting rather than burying it in settings.
            const needsBatchRecording = settings.transcriptionProvider === 'sarvam';
            if ((settings.recordScreen || needsBatchRecording) && settings.recordingSource === 'ask' && isRecordingSupported()) {
                setPendingStart({ title: resolvedTitle, event: linkedEvent });
                return;
            }
            const sourceId = (settings.recordScreen || needsBatchRecording) && settings.recordingSource !== 'ask' ? settings.recordingSource : null;
            await startWithSource(resolvedTitle, sourceId, linkedEvent);
        },
        [settings.recordScreen, settings.recordingSource, settings.transcriptionProvider, startWithSource]
    );

    useEffect(() => {
        globalThis.alphaShell?.setWidgetVisible(settings.floatingWidget !== false);
    }, [settings.floatingWidget]);

    useMeetingReminder({
        events: calendar.events,
        enabled: settings.meetingReminders !== false,
        canRecord: isConnected && isIdle,
        onStart: event => {
            setActiveTab('live');
            handleStartRecording(event.title, event);
        },
    });

    const handleStopRecording = useCallback(() => {
        stopMeeting(turns);
    }, [stopMeeting, turns]);

    const handleSelectHistoryMeeting = useCallback(
        async meeting => {
            const loaded = await loadMeeting(meeting.id);
            // A recorded meeting is most useful as a replay; an unrecorded one has
            // nothing to show there.
            setActiveTab(loaded?.recording?.videoPath ? 'replay' : 'notes');
        },
        [loadMeeting]
    );

    const handleRenameSpeaker = useCallback(
        async (currentName, nextName) => {
            const result = await renameSpeaker(currentName, nextName);
            if (result.ok) history.reload();
            return result;
        },
        [renameSpeaker, history]
    );

    // Standard desktop shortcuts: view switching, export, preferences, record toggle
    useEffect(() => {
        const handleKeyDown = event => {
            if (!event.metaKey && !event.ctrlKey) return;

            const viewIndex = Number(event.key);
            if (viewIndex >= 1 && viewIndex <= VIEWS.length) {
                event.preventDefault();
                setActiveTab(VIEWS[viewIndex - 1].value);
                return;
            }

            if (event.key === ',') {
                event.preventDefault();
                setIsSettingsOpen(true);
                return;
            }

            if (event.key.toLowerCase() === 'e') {
                event.preventDefault();
                setIsExportOpen(true);
                return;
            }

            if (event.key.toLowerCase() === 'r') {
                event.preventDefault();
                if (isRecording || isPaused) {
                    handleStopRecording();
                } else if (!isProcessing && isConnected) {
                    handleStartRecording();
                }
            }
        };

        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [handleStartRecording, handleStopRecording, isConnected, isPaused, isProcessing, isRecording]);

    const licenseTier = license?.tier ? license.tier.charAt(0).toUpperCase() + license.tier.slice(1) : null;
    const connectionLabel = connection === 'online' ? 'Connected' : connection === 'connecting' ? 'Connecting' : 'Offline';
    const banner = !isConnected
        ? { tone: 'destructive', text: `Can’t reach the backend at ${backendUrl}. Start it with npm run start:backend.` }
        : micError
          ? { tone: 'warning', text: `Microphone unavailable: ${micError}` }
          : error
            ? { tone: 'warning', text: error }
            : recordingState?.error
              ? { tone: 'warning', text: `Screen recording: ${recordingState.error}` }
              : null;

    return (
        <div className="flex h-full w-full overflow-hidden bg-background text-foreground">
            <Sidebar
                views={VIEWS}
                activeTab={activeTab}
                onSelect={setActiveTab}
                licenseTier={licenseTier}
                isRecording={isRecording}
                isPaused={isPaused}
                needsTitlebarInset={IS_DESKTOP_SHELL}
            />

            <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
                <header className="drag-region flex h-13 shrink-0 items-center justify-end gap-1 px-4">
                    <div className="no-drag flex items-center justify-end gap-1">
                        <Tooltip>
                            <TooltipTrigger asChild>
                                <button
                                    type="button"
                                    onClick={refresh}
                                    aria-live="polite"
                                    className="hidden items-center gap-1 rounded-full bg-muted px-2 py-1 text-footnote font-medium text-muted-foreground transition-colors hover:text-foreground md:flex"
                                >
                                    {isConnected ? (
                                        <Wifi className="size-4 text-success" aria-hidden="true" />
                                    ) : (
                                        <WifiOff className={cn('size-4', connection === 'offline' && 'text-destructive')} aria-hidden="true" />
                                    )}
                                    <span>{connectionLabel}</span>
                                </button>
                            </TooltipTrigger>
                            <TooltipContent>
                                {backendUrl}
                                {engine?.version ? ` · core ${engine.version}` : ''}
                            </TooltipContent>
                        </Tooltip>

                        <Tooltip>
                            <TooltipTrigger asChild>
                                <Button variant="outline" size="sm" onClick={() => setIsExportOpen(true)} disabled={!activeMeeting}>
                                    <Download aria-hidden="true" />
                                    <span className="hidden sm:inline">Export</span>
                                </Button>
                            </TooltipTrigger>
                            <TooltipContent>
                                Export notes <span className="text-muted-foreground">⌘E</span>
                            </TooltipContent>
                        </Tooltip>

                        <Tooltip>
                            <TooltipTrigger asChild>
                                <Button
                                    variant="ghost"
                                    size="iconSm"
                                    onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
                                    aria-label={theme === 'dark' ? 'Switch to light appearance' : 'Switch to dark appearance'}
                                >
                                    {theme === 'dark' ? <Sun aria-hidden="true" /> : <Moon aria-hidden="true" />}
                                </Button>
                            </TooltipTrigger>
                            <TooltipContent>{theme === 'dark' ? 'Light appearance' : 'Dark appearance'}</TooltipContent>
                        </Tooltip>

                        <Tooltip>
                            <TooltipTrigger asChild>
                                <Button variant="ghost" size="iconSm" onClick={() => setIsSettingsOpen(true)} aria-label="Settings">
                                    <Settings aria-hidden="true" />
                                </Button>
                            </TooltipTrigger>
                            <TooltipContent>
                                Settings <span className="text-muted-foreground">⌘,</span>
                            </TooltipContent>
                        </Tooltip>
                    </div>
                </header>

                {banner && (
                    <div
                        role="status"
                        className={cn(
                            'flex shrink-0 items-center gap-2 px-4 py-2 text-callout hairline-bottom',
                            banner.tone === 'destructive' ? 'bg-destructive/[0.12] text-destructive' : 'bg-warning/[0.12] text-warning'
                        )}
                    >
                        <TriangleAlert className="size-4 shrink-0" aria-hidden="true" />
                        <span className="min-w-0 flex-1">{banner.text}</span>
                        {isConnected ? (
                            <Button variant="ghost" size="xs" onClick={clearError} className="text-current">
                                Dismiss
                            </Button>
                        ) : (
                            <Button variant="ghost" size="xs" onClick={refresh} className="text-current">
                                <RotateCw aria-hidden="true" />
                                Retry
                            </Button>
                        )}
                    </div>
                )}

                <main className="mx-auto flex w-full max-w-[1440px] flex-1 flex-col gap-4 overflow-hidden p-4 sm:p-10">
                    {activeTab === 'home' && (
                        <HomeView
                            events={calendar.events}
                            providers={calendar.providers}
                            isConnected={isConnected}
                            canRecord={isConnected && isIdle}
                            remindersEnabled={settings.meetingReminders !== false}
                            onStartMeeting={handleStartRecording}
                            onOpenSettings={() => setIsSettingsOpen(true)}
                        />
                    )}

                    {activeTab === 'live' && (
                        <div className="flex flex-1 flex-col gap-4 overflow-hidden">
                            <LiveMeetingHUD
                                sessionState={sessionState}
                                durationSeconds={durationSeconds}
                                activeMeeting={activeMeeting}
                                audioLevels={audioLevels}
                                micMuted={micMuted}
                                systemAudioMuted={systemAudioMuted}
                                systemAudioSeen={systemAudioSeen}
                                recordingState={recordingState}
                                upcomingEvent={upcoming}
                                canRecord={isConnected}
                                onStartMeeting={handleStartRecording}
                                onPauseMeeting={pauseMeeting}
                                onResumeMeeting={resumeMeeting}
                                onStopMeeting={handleStopRecording}
                                onToggleMic={toggleMicMute}
                                onToggleSystemAudio={toggleSystemAudioMute}
                                onUpdateTitle={title => updateActiveMeeting({ title })}
                                onOpenSettings={() => setIsSettingsOpen(true)}
                            />

                            <div className="grid flex-1 grid-cols-1 gap-4 overflow-hidden lg:grid-cols-12">
                                <div className="h-full overflow-hidden lg:col-span-7">
                                    <TranscriptView
                                        turns={turns}
                                        filteredTurns={filteredTurns}
                                        searchQuery={searchQuery}
                                        onSearchChange={setSearchQuery}
                                        selectedSpeakerFilter={selectedSpeakerFilter}
                                        onSpeakerFilterChange={setSelectedSpeakerFilter}
                                        speakers={speakers}
                                        speakerStats={speakerStats}
                                        autoScroll={autoScroll}
                                        onToggleAutoScroll={() => setAutoScroll(prev => !prev)}
                                        isLive={isRecording}
                                        stt={engine?.stt}
                                    />
                                </div>

                                <div className="flex h-full flex-col overflow-hidden lg:col-span-5">
                                    <LiveNotes
                                        notes={activeMeeting?.notes || []}
                                        canWrite={Boolean(activeMeeting) && (isRecording || isPaused)}
                                        hint={activeMeeting ? 'This meeting has ended. Its notes are read-only.' : undefined}
                                        onAddNote={addNote}
                                        onDeleteNote={isRecording || isPaused ? deleteNote : undefined}
                                    />
                                </div>
                            </div>
                        </div>
                    )}

                    {activeTab === 'notes' && (
                        <div className="grid flex-1 grid-cols-1 gap-4 overflow-hidden lg:grid-cols-12">
                            <div className="h-full overflow-hidden lg:col-span-7">
                                <SummaryEditor meeting={activeMeeting} onUpdateMeeting={updateActiveMeeting} isGenerating={isProcessing} />
                            </div>

                            <div className="h-full overflow-hidden lg:col-span-5">
                                <TranscriptView
                                    turns={turns}
                                    filteredTurns={filteredTurns}
                                    searchQuery={searchQuery}
                                    onSearchChange={setSearchQuery}
                                    selectedSpeakerFilter={selectedSpeakerFilter}
                                    onSpeakerFilterChange={setSelectedSpeakerFilter}
                                    speakers={speakers}
                                    speakerStats={speakerStats}
                                    autoScroll={false}
                                    isLive={false}
                                    stt={engine?.stt}
                                />
                            </div>
                        </div>
                    )}

                    {activeTab === 'replay' && (
                        <RecordingPlayer
                            meeting={activeMeeting}
                            isConnected={isConnected}
                            nameSuggestions={invitedNames}
                            onRenameSpeaker={handleRenameSpeaker}
                        />
                    )}

                    {activeTab === 'podcast' && (
                        <PodcastStudio meetings={history.meetings} activeMeeting={activeMeeting} />
                    )}

                    {activeTab === 'history' && (
                        <div className="flex-1 overflow-hidden">
                            <HistoryExplorer
                                meetings={history.meetings}
                                isLoading={history.isLoading}
                                error={history.error}
                                searchQuery={history.searchQuery}
                                onSearchChange={history.setSearchQuery}
                                onReload={history.reload}
                                isConnected={isConnected}
                                selectedMeetingId={activeMeeting?.id}
                                onSelectMeeting={handleSelectHistoryMeeting}
                                onDeleteMeeting={history.deleteMeeting}
                                onExportMeeting={async meeting => {
                                    await loadMeeting(meeting.id);
                                    setIsExportOpen(true);
                                }}
                            />
                        </div>
                    )}
                </main>
            </div>

            <SourcePicker
                isOpen={pendingStart !== null}
                batchUpload={settings.transcriptionProvider === 'sarvam'}
                onClose={() => setPendingStart(null)}
                onConfirm={sourceId => {
                    const requested = pendingStart;
                    setPendingStart(null);
                    startWithSource(requested?.title || '', sourceId, requested?.event || null);
                }}
            />
            <ExportModal isOpen={isExportOpen} onClose={() => setIsExportOpen(false)} meeting={activeMeeting} />
            <SettingsModal
                isOpen={isSettingsOpen}
                onClose={() => setIsSettingsOpen(false)}
                settings={settings}
                license={license}
                engine={engine}
                backendUrl={backendUrl}
                isConnected={isConnected}
                calendar={calendar}
                onUpdateSettings={updateSettings}
                onActivateLicense={activateLicense}
            />
        </div>
    );
}
