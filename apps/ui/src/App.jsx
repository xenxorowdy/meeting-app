import React, { lazy, Suspense, useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useTheme } from '@/lib/theme';
import { usePreferences } from '@/hooks/usePreferences';
import { useMeetingSession, SESSION_STATES } from '@/hooks/useMeetingSession';
import { useTranscriptStream } from '@/hooks/useTranscriptStream';
import { useMeetingHistory } from '@/hooks/useMeetingHistory';
import { useCalendar } from '@/hooks/useCalendar';
import { eventForNow, attendeeNames } from '@/lib/calendarEvents';
import { useMeetingReminder } from '@/hooks/useMeetingReminder';
import { useShellCommands } from '@/hooks/useShellCommands';
import { SourcePicker } from '@/components/SourcePicker';
import { useOnceOpen } from '@/hooks/useOnceOpen';

// Each of these is only reachable through a deliberate action, so their code is
// fetched on first use instead of sitting in the startup bundle.
const ExportModal = lazy(() => import('@/components/ExportModal').then(module => ({ default: module.ExportModal })));
const NewMeetingModal = lazy(() => import('@/components/NewMeetingModal').then(module => ({ default: module.NewMeetingModal })));
const SettingsModal = lazy(() => import('@/components/SettingsModal').then(module => ({ default: module.SettingsModal })));
import { isRecordingSupported } from '@/lib/screenRecorder';
import { getBackendConnection } from '@/lib/connection.js';
import { fetchSession, signOut as signOutSession } from '@/lib/auth.js';
import { DesignWorkspace } from '@/components/design/DesignWorkspace';
import { SignInView } from '@/components/design/SignInView';
import { LogoMark } from '@/components/brand/Logo';
import './design.css';

// In the desktop shell the window keeps macOS traffic lights over the toolbar,
// so the leading content has to start clear of them.
const IS_DESKTOP_SHELL = typeof navigator !== 'undefined' && /Electron/i.test(navigator.userAgent);

const VIEWS = ['home', 'ask', 'live', 'notes', 'replay', 'podcast', 'history'];

export default function App() {
    // null while a stored session is still being restored; otherwise "is the
    // user in the workspace".
    const [entered, setEntered] = useState(null);
    const [openSettingsOnEntry, setOpenSettingsOnEntry] = useState(false);
    const [theme, setTheme] = useTheme();
    const [preferences] = usePreferences();

    // A session token survives restarts in the desktop shell (and for this
    // browser session otherwise), so a stored session is restored before the
    // sign-in screen is shown.
    useEffect(() => {
        let cancelled = false;
        if (!getBackendConnection().token) {
            setEntered(false);
            return;
        }
        fetchSession().then(restored => {
            if (!cancelled) setEntered(Boolean(restored));
        });
        return () => { cancelled = true; };
    }, []);

    const handleSignOut = useCallback(() => {
        setEntered(false);
        // Revoking the token server-side is best effort; dropping the local
        // copy is what the UI actually depends on.
        signOutSession();
    }, []);

    if (entered === null) {
        return (
            <div className="ks-app" data-theme={theme}>
                <div className="ks-session-restore" role="status">
                    <LogoMark size={22} live /> Restoring your session…
                </div>
            </div>
        );
    }

    return (
        <div className="ks-app" data-theme={theme}>
            {entered ? (
                <ConnectedApp theme={theme} setTheme={setTheme} preferences={preferences} openSettingsOnEntry={openSettingsOnEntry} onSignOut={handleSignOut} />
            ) : (
                <SignInView
                    onContinue={destination => { setOpenSettingsOnEntry(destination === 'settings'); setEntered(true); }}
                    onAuthenticated={() => setEntered(true)}
                />
            )}
        </div>
    );
}

function ConnectedApp({ onSignOut, theme, setTheme, preferences, openSettingsOnEntry }) {
    const [activeTab, setActiveTab] = useState('home');
    const [citationFocus, setCitationFocus] = useState(null);
    const [isExportOpen, setIsExportOpen] = useState(false);
    const [isSettingsOpen, setIsSettingsOpen] = useState(openSettingsOnEntry);
    const [isNewMeetingOpen, setIsNewMeetingOpen] = useState(false);
    const [pendingStart, setPendingStart] = useState(null);
    const exportMounted = useOnceOpen(isExportOpen);
    const settingsMounted = useOnceOpen(isSettingsOpen);
    const newMeetingMounted = useOnceOpen(isNewMeetingOpen);

    const {
        backendUrl,
        connection,
        isConnected,
        sessionState,
        activeMeeting,
        isGeneratingSummary,
        interimTurns,
        durationSeconds,
        subscribeAudioLevels,
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
        regenerateSummary,
        updateActiveMeeting,
        renameSpeaker,
        toggleMicMute,
        toggleSystemAudioMute,
        updateSettings,
        activateLicense,
        refresh,
        setOnLiveTurn,
        setOnTranscriptReplaced,
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

    const { turns, addTurn, clearTurns, setTurns } = useTranscriptStream({ turns: activeMeeting?.transcript });

    const history = useMeetingHistory({ enabled: isConnected });
    const calendar = useCalendar({ isConnected });

    const calendarEventsRef = useRef(calendar.events);
    calendarEventsRef.current = calendar.events;

    const invitedNames = useMemo(() => attendeeNames(activeMeeting?.metadata?.calendarEvent), [activeMeeting?.metadata?.calendarEvent]);

    // Live turns arrive over the backend socket.
    useEffect(() => {
        setOnLiveTurn(addTurn);
    }, [setOnLiveTurn, addTurn]);

    useEffect(() => {
        setOnTranscriptReplaced(setTurns);
    }, [setOnTranscriptReplaced, setTurns]);

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
        async (title, sourceId, event, mode = 'audio') => {
            clearTurns();
            setActiveTab('live');
            await startMeeting(title, { sourceId, event, mode });
        },
        [clearTurns, startMeeting]
    );

    const handleStartRecording = useCallback(
        async (title, event) => {
            const linkedEvent = event || eventForNow(calendarEventsRef.current);
            const resolvedTitle = title || linkedEvent?.title || '';

            // Recording mode is a per-meeting choice. Keep sound-only visible at
            // the moment recording starts instead of hiding it in preferences.
            if (isRecordingSupported('audio')) {
                setPendingStart({ title: resolvedTitle, event: linkedEvent });
                return;
            }
            await startWithSource(resolvedTitle, null, linkedEvent, 'audio');
        },
        [startWithSource]
    );

    useEffect(() => {
        globalThis.alphaShell?.setWidgetVisible(settings.floatingWidget !== false);
    }, [settings.floatingWidget]);

    useEffect(() => {
        globalThis.alphaShell?.setWidgetLive(isRecording || isPaused || isProcessing);
    }, [isRecording, isPaused, isProcessing]);

    useMeetingReminder({
        events: calendar.events,
        enabled: settings.meetingReminders !== false && !globalThis.alphaShell?.ownsMeetingReminders,
        canRecord: isConnected && isIdle,
        onStart: event => {
            setActiveTab('live');
            handleStartRecording(event.title, event);
        },
    });

    useShellCommands({
        onRecord: event => {
            setActiveTab('live');
            if (isConnected && isIdle) handleStartRecording(event?.title, event);
        },
        onNewNote: () => {
            setActiveTab('live');
            if (isConnected && isIdle) handleStartRecording('', null);
        },
        onNewMeeting: () => setIsNewMeetingOpen(true),
        onSettings: () => setIsSettingsOpen(true),
    });

    const handleStopRecording = useCallback(() => {
        stopMeeting(turns);
    }, [stopMeeting, turns]);

    const handleSelectHistoryMeeting = useCallback(
        async (meeting, citation = null) => {
            if (!meeting?.id) return;
            if (!isIdle && meeting.id === activeMeeting?.id) {
                setCitationFocus(citation);
                setActiveTab('live');
                return;
            }
            const loaded = await loadMeeting(meeting.id);
            setCitationFocus(citation);
            // Open the transcript by default; a timed citation can open replay.
            if (loaded) setActiveTab(citation && loaded.recording?.videoPath ? 'replay' : 'live');
        },
        [loadMeeting, isIdle, activeMeeting?.id]
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
                setActiveTab(VIEWS[viewIndex - 1]);
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

    const banner = !isConnected
        ? { tone: 'destructive', text: connection === 'connecting' ? 'Connecting to your workspace…' : 'Your workspace is offline. Check your connection and service access in Settings.' }
        : micError
          ? { tone: 'warning', text: `Microphone unavailable: ${micError}` }
          : error
            ? { tone: 'warning', text: error }
            : recordingState?.error
              ? { tone: 'warning', text: `Screen recording: ${recordingState.error}` }
              : null;

    return (
        <div className="ks-app" data-theme={theme}>
            <DesignWorkspace
                workspaceName={preferences.workspaceName}
                displayName={preferences.displayName}
                activeTab={activeTab}
                setActiveTab={setActiveTab}
                meeting={activeMeeting}
                turns={turns}
                interimTurns={interimTurns}
                history={history}
                calendar={calendar}
                session={{
                    isRecording,
                    isPaused,
                    isProcessing,
                    autoSummarize: settings.autoSummarize !== false,
                    isGeneratingSummary,
                    durationSeconds,
                    subscribeAudioLevels,
                    micMuted,
                    systemAudioMuted,
                    systemAudioSeen,
                    recordingState,
                    nameSuggestions: invitedNames,
                    onStart: handleStartRecording,
                    onStop: handleStopRecording,
                    onPause: pauseMeeting,
                    onResume: resumeMeeting,
                    onToggleMic: toggleMicMute,
                    onToggleSystem: toggleSystemAudioMute,
                }}
                isConnected={isConnected}
                connection={connection}
                banner={banner}
                onRetry={refresh}
                onDismiss={clearError}
                onSettings={() => setIsSettingsOpen(true)}
                onNewMeeting={() => setIsNewMeetingOpen(true)}
                onExport={() => setIsExportOpen(true)}
                onSelectMeeting={handleSelectHistoryMeeting}
                onRenameSpeaker={handleRenameSpeaker}
                onUpdate={updateActiveMeeting}
                onRegenerateSummary={regenerateSummary}
                onAddNote={addNote}
                onDeleteNote={deleteNote}
                citationFocus={citationFocus}
                license={license}
                onSignOut={onSignOut}
                isDesktop={IS_DESKTOP_SHELL}
                theme={theme}
                onToggleTheme={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
                noiseSuppression={settings.noiseSuppression !== false}
                onUpdateSettings={updateSettings}
            />

            <SourcePicker
                isOpen={pendingStart !== null}
                batchUpload={settings.transcriptionProvider === 'sarvam'}
                onClose={() => setPendingStart(null)}
                onConfirm={(sourceId, mode = 'screen') => {
                    const requested = pendingStart;
                    setPendingStart(null);
                    startWithSource(requested?.title || '', sourceId, requested?.event || null, mode);
                }}
            />
            <Suspense fallback={null}>
                {exportMounted && <ExportModal isOpen={isExportOpen} onClose={() => setIsExportOpen(false)} meeting={activeMeeting} />}
                {newMeetingMounted && (
                    <NewMeetingModal
                        isOpen={isNewMeetingOpen}
                        onClose={() => setIsNewMeetingOpen(false)}
                        providers={calendar.providers}
                        onCreated={calendar.refreshEvents}
                    />
                )}
                {settingsMounted && (
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
                        sessionActive={!isIdle}
                    />
                )}
            </Suspense>
        </div>
    );
}
