import React, { useState, useEffect, useCallback } from 'react';
import { Mic, Sparkles, CalendarDays, Settings, Download, Wifi, WifiOff, RotateCw, TriangleAlert } from 'lucide-react';
import { cn } from '@/utils/cn';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useSystemAppearance } from '@/hooks/useSystemAppearance';
import { useMeetingSession, SESSION_STATES } from '@/hooks/useMeetingSession';
import { useTranscriptStream } from '@/hooks/useTranscriptStream';
import { useMeetingHistory } from '@/hooks/useMeetingHistory';
import { LiveMeetingHUD } from '@/components/LiveMeetingHUD';
import { TranscriptView } from '@/components/TranscriptView';
import { SummaryEditor } from '@/components/SummaryEditor';
import { HistoryExplorer } from '@/components/HistoryExplorer';
import { ExportModal } from '@/components/ExportModal';
import { SettingsModal } from '@/components/SettingsModal';

// In the desktop shell the window keeps macOS traffic lights over the toolbar,
// so the leading content has to start clear of them.
const IS_DESKTOP_SHELL = typeof navigator !== 'undefined' && /Electron/i.test(navigator.userAgent);

const VIEWS = [
    { value: 'live', label: 'Live', icon: Mic, shortcut: '⌘1' },
    { value: 'notes', label: 'Notes', icon: Sparkles, shortcut: '⌘2' },
    { value: 'history', label: 'History', icon: CalendarDays, shortcut: '⌘3' },
];

export default function App() {
    useSystemAppearance();

    const [activeTab, setActiveTab] = useState('live');
    const [isExportOpen, setIsExportOpen] = useState(false);
    const [isSettingsOpen, setIsSettingsOpen] = useState(false);

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
        toggleMicMute,
        toggleSystemAudioMute,
        updateSettings,
        activateLicense,
        refresh,
        setOnLiveTurn,
        setOnMeetingCompleted,
        clearError,
    } = useMeetingSession();

    const isRecording = sessionState === SESSION_STATES.RECORDING;
    const isPaused = sessionState === SESSION_STATES.PAUSED;
    const isProcessing = sessionState === SESSION_STATES.PROCESSING;

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

    // Live turns arrive over the backend socket.
    useEffect(() => {
        setOnLiveTurn(addTurn);
    }, [setOnLiveTurn, addTurn]);

    // A finished meeting is stored by the backend; reload the list and show its notes.
    useEffect(() => {
        setOnMeetingCompleted(() => {
            history.reload();
            setActiveTab('notes');
        });
    }, [setOnMeetingCompleted, history]);

    const handleStartRecording = useCallback(
        async title => {
            clearTurns();
            setActiveTab('live');
            await startMeeting(title);
        },
        [clearTurns, startMeeting]
    );

    const handleStopRecording = useCallback(() => {
        stopMeeting(turns);
    }, [stopMeeting, turns]);

    const handleSelectHistoryMeeting = useCallback(
        async meeting => {
            await loadMeeting(meeting.id);
            setActiveTab('notes');
        },
        [loadMeeting]
    );

    // Standard desktop shortcuts: view switching, export, preferences, record toggle
    useEffect(() => {
        const handleKeyDown = event => {
            if (!event.metaKey && !event.ctrlKey) return;

            if (event.key === '1' || event.key === '2' || event.key === '3') {
                event.preventDefault();
                setActiveTab(VIEWS[Number(event.key) - 1].value);
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
            : null;

    return (
        <div className="flex h-full w-full flex-col overflow-hidden bg-background text-foreground">
            <header
                className={cn(
                    'drag-region flex h-[52px] shrink-0 items-center justify-between gap-4 px-4 material-chrome hairline-bottom',
                    IS_DESKTOP_SHELL && 'pl-[86px]'
                )}
            >
                <div className="flex min-w-0 items-center gap-2.5">
                    <div className="flex size-7 items-center justify-center rounded-lg bg-primary text-primary-foreground shadow-control">
                        <Mic className="size-4" aria-hidden="true" />
                    </div>
                    <h1 className="truncate text-headline font-semibold">Alpha</h1>
                    {licenseTier && (
                        <Badge variant={license?.tier === 'free' ? 'muted' : 'tinted'} className="no-drag">
                            {licenseTier}
                        </Badge>
                    )}
                </div>

                <Tabs value={activeTab} onValueChange={setActiveTab} className="no-drag">
                    <TabsList aria-label="Views">
                        {VIEWS.map(view => {
                            const Icon = view.icon;
                            const showRecordingDot = view.value === 'live' && (isRecording || isPaused);
                            return (
                                <Tooltip key={view.value}>
                                    <TooltipTrigger asChild>
                                        <span className="inline-flex">
                                            <TabsTrigger value={view.value}>
                                                {showRecordingDot ? (
                                                    <span
                                                        role="img"
                                                        aria-label={isRecording ? 'Recording' : 'Paused'}
                                                        className={cn(
                                                            'size-2 rounded-full',
                                                            isRecording ? 'animate-breathe bg-destructive' : 'bg-warning'
                                                        )}
                                                    />
                                                ) : (
                                                    <Icon aria-hidden="true" />
                                                )}
                                                {view.label}
                                            </TabsTrigger>
                                        </span>
                                    </TooltipTrigger>
                                    <TooltipContent>
                                        {view.label} <span className="text-muted-foreground">{view.shortcut}</span>
                                    </TooltipContent>
                                </Tooltip>
                            );
                        })}
                    </TabsList>
                </Tabs>

                <div className="no-drag flex items-center justify-end gap-1.5">
                    <Tooltip>
                        <TooltipTrigger asChild>
                            <button
                                type="button"
                                onClick={refresh}
                                aria-live="polite"
                                className="hidden items-center gap-1.5 rounded-full bg-muted px-2.5 py-1 text-footnote font-medium text-muted-foreground transition-colors hover:text-foreground md:flex"
                            >
                                {isConnected ? (
                                    <Wifi className="size-3 text-success" aria-hidden="true" />
                                ) : (
                                    <WifiOff className={cn('size-3', connection === 'offline' && 'text-destructive')} aria-hidden="true" />
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
                    <TriangleAlert className="size-3.5 shrink-0" aria-hidden="true" />
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

            <main className="mx-auto flex w-full max-w-[1440px] flex-1 flex-col gap-3 overflow-hidden p-3 sm:gap-4 sm:p-4">
                {activeTab === 'live' && (
                    <div className="flex flex-1 flex-col gap-3 overflow-hidden sm:gap-4">
                        <LiveMeetingHUD
                            sessionState={sessionState}
                            durationSeconds={durationSeconds}
                            activeMeeting={activeMeeting}
                            audioLevels={audioLevels}
                            micMuted={micMuted}
                            systemAudioMuted={systemAudioMuted}
                            systemAudioSeen={systemAudioSeen}
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

                        <div className="grid flex-1 grid-cols-1 gap-3 overflow-hidden sm:gap-4 lg:grid-cols-12">
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
                                <SummaryEditor meeting={activeMeeting} onUpdateMeeting={updateActiveMeeting} isGenerating={isProcessing} />
                            </div>
                        </div>
                    </div>
                )}

                {activeTab === 'notes' && (
                    <div className="grid flex-1 grid-cols-1 gap-3 overflow-hidden sm:gap-4 lg:grid-cols-12">
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

            <ExportModal isOpen={isExportOpen} onClose={() => setIsExportOpen(false)} meeting={activeMeeting} />
            <SettingsModal
                isOpen={isSettingsOpen}
                onClose={() => setIsSettingsOpen(false)}
                settings={settings}
                license={license}
                engine={engine}
                backendUrl={backendUrl}
                isConnected={isConnected}
                onUpdateSettings={updateSettings}
                onActivateLicense={activateLicense}
            />
        </div>
    );
}
