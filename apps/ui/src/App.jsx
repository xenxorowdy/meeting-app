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
import { useUnscheduledCallPrompt } from '@/hooks/useUnscheduledCallPrompt';
import { SourcePicker } from '@/components/SourcePicker';
import { useOnceOpen } from '@/hooks/useOnceOpen';

// Each of these is only reachable through a deliberate action, so their code is
// fetched on first use instead of sitting in the startup bundle.
const ExportModal = lazy(() => import('@/components/ExportModal').then(module => ({ default: module.ExportModal })));
const NewMeetingModal = lazy(() => import('@/components/NewMeetingModal').then(module => ({ default: module.NewMeetingModal })));
const SettingsModal = lazy(() => import('@/components/SettingsModal').then(module => ({ default: module.SettingsModal })));
import { isRecordingSupported } from '@/lib/screenRecorder';
import { getBackendConnection } from '@/lib/connection.js';
import { restoreSession, signOut as signOutSession, hasLocalMode, rememberLocalMode } from '@/lib/auth.js';
import { DesignWorkspace } from '@/components/design/DesignWorkspace';
import { SignInView } from '@/components/design/SignInView';
import { LogoMark } from '@/components/brand/Logo';
import './design.css';

// In the desktop shell the window keeps macOS traffic lights over the toolbar,
// so the leading content has to start clear of them.
const IS_DESKTOP_SHELL = typeof navigator !== 'undefined' && /Electron/i.test(navigator.userAgent);

const VIEWS = ['home', 'ask', 'live', 'notes', 'replay', 'history'];
const NOTES_READY_WIDGET_MS = 8000;

export default function App() {
    // null while a stored session is still being restored; otherwise "is the
    // user in the workspace".
    const [entered, setEntered] = useState(null);
    const [account, setAccount] = useState(null);
    const [authNotice, setAuthNotice] = useState('');
    const [openSettingsOnEntry, setOpenSettingsOnEntry] = useState(false);
    const [restoreFailed, setRestoreFailed] = useState(false);
    const [restoreAttempt, setRestoreAttempt] = useState(0);
    const [theme, setTheme] = useTheme();
    const [preferences] = usePreferences();

    // A session token survives restarts in the desktop shell (and for this
    // browser session otherwise), so a stored session is restored before the
    // sign-in screen is shown.
    const restoreActiveRef = useRef(true);
    useEffect(() => {
        let cancelled = false;
        let retry = null;
        if (!getBackendConnection().token) {
            setEntered(hasLocalMode());
            return undefined;
        }
        restoreSession(restoreAttempt ? { attempts: 1 } : undefined).then(({ account: restored, reachable }) => {
            if (cancelled || !restoreActiveRef.current) return;
            if (!reachable) {
                setRestoreFailed(true);
                retry = setTimeout(() => setRestoreAttempt(value => value + 1), 5000);
                return;
            }
            setRestoreFailed(false);
            setAccount(restored);
            setEntered(Boolean(restored) || hasLocalMode());
        });
        return () => {
            cancelled = true;
            clearTimeout(retry);
        };
    }, [restoreAttempt]);

    const handleSignOut = useCallback(async () => {
        try {
            if (getBackendConnection().token) {
                const result = await signOutSession();
                setAuthNotice(result.revoked ? '' : 'Signed out on this device. The server could not confirm session revocation.');
            } else {
                rememberLocalMode(false);
            }
            setAccount(null);
            setEntered(false);
        } catch {
            setAuthNotice('Could not clear the saved session. Please try signing out again.');
        }
    }, []);

    if (entered === null) {
        return (
            <div className="ks-app" data-theme={theme}>
                {restoreFailed ? (
                    <div className="ks-session-restore ks-session-restore-failed" role="alert">
                        <LogoMark size={22} />
                        <p>Kesami can’t reach its engine yet. It restarts on its own, so this usually clears in a few seconds.</p>
                        <div>
                            <button type="button" className="ks-button ks-primary" onClick={() => setRestoreAttempt(value => value + 1)}>
                                Try again
                            </button>
                            <button
                                type="button"
                                className="ks-button"
                                onClick={() => {
                                    restoreActiveRef.current = false;
                                    setRestoreFailed(false);
                                    setEntered(false);
                                }}
                            >
                                Sign in again
                            </button>
                        </div>
                    </div>
                ) : (
                    <div className="ks-session-restore" role="status">
                        <LogoMark size={22} live /> Restoring your session…
                    </div>
                )}
            </div>
        );
    }

    return (
        <div className="ks-app" data-theme={theme}>
            {entered ? (
                <ConnectedApp
                    theme={theme}
                    setTheme={setTheme}
                    preferences={preferences}
                    openSettingsOnEntry={openSettingsOnEntry}
                    onSignOut={handleSignOut}
                    account={account}
                    onAccountChange={setAccount}
                    authNotice={authNotice}
                />
            ) : (
                <SignInView
                    theme={theme}
                    onToggleTheme={setTheme}
                    notice={authNotice}
                    onAuthenticated={value => { setAccount(value); setAuthNotice(''); setOpenSettingsOnEntry(false); setEntered(true); }}
                />
            )}
        </div>
    );
}

function ConnectedApp({ onSignOut, theme, setTheme, preferences, openSettingsOnEntry, account, onAccountChange, authNotice }) {
    const [activeTab, setActiveTab] = useState('home');
    const [citationFocus, setCitationFocus] = useState(null);
    const [isExportOpen, setIsExportOpen] = useState(false);
    const [isSettingsOpen, setIsSettingsOpen] = useState(openSettingsOnEntry);
    const [settingsTab, setSettingsTab] = useState(null);
    const [dismissedRecordingError, setDismissedRecordingError] = useState(null);
    const [isNewMeetingOpen, setIsNewMeetingOpen] = useState(false);
    const [pendingStart, setPendingStart] = useState(null);
    const exportMounted = useOnceOpen(isExportOpen);
    const settingsMounted = useOnceOpen(isSettingsOpen);
    const newMeetingMounted = useOnceOpen(isNewMeetingOpen);

    const {
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
        clientMicMuted,
        systemAudioMuted,
        recordingState,
        stopFailed,
        error,
        micError,
        systemAudioError,
        settings,
        license,
        startMeeting,
        pauseMeeting,
        resumeMeeting,
        stopMeeting,
        loadMeeting,
        regenerateSummary,
        updateActiveMeeting,
        updateCommitments,
        updatePostMeetingAction,
        renameSpeaker,
        changeTurnSpeaker,
        liveRoster,
        meetingClient,
        toggleMicMute,
        toggleSystemAudioMute,
        updateSettings,
        activateLicense,
        refresh,
        setOnLiveTurn,
        setOnTranscriptReplaced,
        setOnMeetingCompleted,
        setOnMeetingEnded,
        setOnUnscheduledCall,
        setOnCalendarConnection,
        setOnConnectorConnection,
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

    const wasLiveRef = useRef(false);

    const invitedNames = useMemo(() => attendeeNames(activeMeeting?.metadata?.calendarEvent), [activeMeeting?.metadata?.calendarEvent]);
    const speakerNames = useMemo(() => {
        const inCall = Array.isArray(activeMeeting?.metadata?.participants) ? activeMeeting.metadata.participants : [];
        return [...new Set([...inCall, ...liveRoster, ...invitedNames].map(name => String(name).trim()).filter(Boolean))];
    }, [activeMeeting?.metadata?.participants, liveRoster, invitedNames]);

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
            return await startMeeting(title, { sourceId, event, mode });
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
        globalThis.kesamiShell?.setWidgetVisible(settings.floatingWidget !== false);
    }, [settings.floatingWidget]);

    useEffect(() => {
        if (isRecording || isPaused || isProcessing) {
            wasLiveRef.current = true;
            globalThis.kesamiShell?.setWidgetLive(true);
            return undefined;
        }

        const justFinished = sessionState === SESSION_STATES.COMPLETED && wasLiveRef.current;
        wasLiveRef.current = false;
        globalThis.kesamiShell?.setWidgetLive(justFinished);
        if (!justFinished) return undefined;

        const timer = setTimeout(() => globalThis.kesamiShell?.setWidgetLive(false), NOTES_READY_WIDGET_MS);
        return () => clearTimeout(timer);
    }, [isRecording, isPaused, isProcessing, sessionState]);

    useEffect(() => {
        globalThis.kesamiShell?.setRecordingIndicator(isRecording);
    }, [isRecording]);

    useMeetingReminder({
        events: calendar.events,
        enabled: settings.meetingReminders !== false && !globalThis.kesamiShell?.ownsMeetingReminders,
        canRecord: isConnected && isIdle,
        onStart: event => {
            setActiveTab('live');
            handleStartRecording(event.title, event);
        },
    });

    useShellCommands({
        onRecord: (event, { auto = false } = {}) => {
            if (!isConnected || !isIdle) return;
            // An automatic start at meeting time has nobody at the keyboard to answer the mode picker, so it
            // records sound only; screen recording stays a choice someone makes by hand.
            if (auto) {
                if (settings.autoRecordMeetings === false) return;
                void startWithSource(event?.title || '', null, event, 'audio');
                return;
            }
            setActiveTab('live');
            handleStartRecording(event?.title, event);
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

    // A notice the user has to see while it is still relevant: it lives only
    // as long as the session state it describes.
    const [endNotice, setEndNotice] = useState(null);
    useEffect(() => {
        setEndNotice(null);
    }, [sessionState]);

    // The meeting client reports the call is over (extension, or the tab
    // dropped out). Auto-stop finishes the recording exactly like the Stop
    // button; with auto-stop off the user still chooses, so say what happened.
    useEffect(() => {
        setOnMeetingEnded((source, reason) => {
            if (settings.autoStopOnMeetingEnd !== false) {
                handleStopRecording();
                return;
            }
            const where = source === 'google-meet' ? 'Google Meet' : source === 'zoom' ? 'Zoom' : null;
            setEndNotice(
                where
                    ? `The meeting ended in ${where} — recording continues until you stop it.`
                    : reason === 'dropout'
                      ? 'The meeting tab stopped responding — recording continues until you stop it.'
                      : 'The meeting ended — recording continues until you stop it.'
            );
        });
    }, [setOnMeetingEnded, handleStopRecording, settings.autoStopOnMeetingEnd]);

    // Call prompts: browser meetings arrive through the backend
    // socket, microphone use through the desktop shell (subscribed in the hook).
    const { callPrompt, notifyUnscheduledCall, startCallPrompt, dismissCallPrompt } = useUnscheduledCallPrompt({
        enabled: settings.promptForUnscheduledCalls !== false,
        canRecord: isConnected && isIdle,
        onStart: () => {
            const event = eventForNow(calendarEventsRef.current);
            return startWithSource(event?.title || '', null, event, 'audio');
        },
    });
    useEffect(() => {
        setOnUnscheduledCall(notifyUnscheduledCall);
    }, [setOnUnscheduledCall, notifyUnscheduledCall]);

    useEffect(() => {
        globalThis.kesamiShell?.setWidgetState({
            sessionState,
            micMuted,
            systemAudioMuted,
            title: activeMeeting?.title || null,
            canControl: isRecording || isPaused,
            callPrompt: settings.promptForUnscheduledCalls !== false && isIdle ? callPrompt : null,
        });
    }, [sessionState, micMuted, systemAudioMuted, activeMeeting?.title, isRecording, isPaused, isIdle, callPrompt, settings.promptForUnscheduledCalls]);

    useEffect(() => {
        return globalThis.kesamiShell?.onWidgetCommand((action, promptId) => {
            if (action === 'start-call') startCallPrompt(promptId);
            else if (action === 'dismiss-call') dismissCallPrompt(promptId);
            else if (action === 'toggle-mic') toggleMicMute();
            else if (action === 'toggle-system') toggleSystemAudioMute();
            else if (action === 'toggle-pause') {
                if (isPaused) resumeMeeting();
                else if (isRecording) pauseMeeting();
            } else if (action === 'stop') {
                if (isRecording || isPaused) handleStopRecording();
            }
        });
    }, [startCallPrompt, dismissCallPrompt, toggleMicMute, toggleSystemAudioMute, isPaused, isRecording, resumeMeeting, pauseMeeting, handleStopRecording]);

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
            if (loaded) setActiveTab(citation && !citation.preferTranscript && loaded.recording?.videoPath ? 'replay' : 'live');
        },
        [loadMeeting, isIdle, activeMeeting?.id]
    );

    const handleUpdateMeeting = useCallback(
        async updates => {
            const result = await updateActiveMeeting(updates);
            if (result?.ok && ('title' in updates || 'summaryMarkdown' in updates)) history.reload();
            return result;
        },
        [updateActiveMeeting, history]
    );

    const handleRenameSpeaker = useCallback(
        async (currentName, nextName) => {
            const result = await renameSpeaker(currentName, nextName);
            if (result.ok) history.reload();
            return result;
        },
        [renameSpeaker, history]
    );

    const handleChangeTurnSpeaker = useCallback(
        async (turnId, nextName) => {
            const result = await changeTurnSpeaker(turnId, nextName);
            if (result.ok) history.reload();
            return result;
        },
        [changeTurnSpeaker, history]
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

    const meetingAudioError = recordingState?.hasSystemAudio ? null : systemAudioError;

    const banner = stopFailed
        ? { tone: 'warning', text: error || 'Recording stopped. Retry saving this meeting before starting another.', actionLabel: 'Retry save', onAction: handleStopRecording }
        : !isConnected
        ? {
              tone: 'destructive',
              text:
                  connection === 'connecting'
                      ? 'Connecting to your workspace…'
                      : 'Your workspace is offline. Check your connection and service access in Settings.',
          }
        : micError
          ? { tone: 'warning', text: `Microphone unavailable: ${micError}`, onDismiss: null }
          : meetingAudioError
            ? { tone: 'warning', text: `Meeting audio: ${meetingAudioError}`, onDismiss: null }
            : endNotice
              ? { tone: 'warning', text: endNotice, onDismiss: () => setEndNotice(null) }
              : error
              ? { tone: 'warning', text: error }
              : recordingState?.error && recordingState.error !== dismissedRecordingError
                ? { tone: 'warning', text: `Recording: ${recordingState.error}`, onDismiss: () => setDismissedRecordingError(recordingState.error) }
                : null;
    const openSettings = useCallback(tab => {
        setSettingsTab(typeof tab === 'string' ? tab : null);
        setIsSettingsOpen(true);
    }, []);

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
                    stopFailed,
                    autoSummarize: settings.autoSummarize !== false,
                    isGeneratingSummary,
                    durationSeconds,
                    subscribeAudioLevels,
                    micMuted,
                    clientMicMuted,
                    systemAudioMuted,
                    systemAudioSeen,
                    systemAudioError: meetingAudioError,
                    recordingState,
                    nameSuggestions: speakerNames,
                    liveRoster,
                    meetingClient,
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
                onSettings={openSettings}
                onNewMeeting={() => setIsNewMeetingOpen(true)}
                onExport={() => setIsExportOpen(true)}
                onSelectMeeting={handleSelectHistoryMeeting}
                onRenameSpeaker={handleRenameSpeaker}
                onChangeTurnSpeaker={handleChangeTurnSpeaker}
                onUpdate={handleUpdateMeeting}
                onUpdateCommitments={updateCommitments}
                onUpdatePostMeetingAction={updatePostMeetingAction}
                onRegenerateSummary={regenerateSummary}
                onAddNote={addNote}
                onDeleteNote={deleteNote}
                citationFocus={citationFocus}
                license={license}
                onSignOut={onSignOut}
                account={account}
                onAccountChange={onAccountChange}
                authNotice={authNotice}
                isDesktop={IS_DESKTOP_SHELL}
                theme={theme}
                onToggleTheme={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
                noiseSuppression={settings.noiseSuppression !== false}
                onUpdateSettings={updateSettings}
                onPlanChanged={refresh}
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
                        onOpenCalendarSettings={() => {
                            setIsNewMeetingOpen(false);
                            openSettings('calendar');
                        }}
                    />
                )}
                {settingsMounted && (
                    <SettingsModal
                        isOpen={isSettingsOpen}
                        initialTab={settingsTab}
                        onClose={() => setIsSettingsOpen(false)}
                        onOpenPlans={() => {
                            setIsSettingsOpen(false);
                            setActiveTab('pricing');
                        }}
                        settings={settings}
                        license={license}
                        isConnected={isConnected}
                        calendar={calendar}
                        onUpdateSettings={updateSettings}
                        onActivateLicense={activateLicense}
                        onConnectorConnection={setOnConnectorConnection}
                        connectionLocked={!isIdle}
                    />
                )}
            </Suspense>
        </div>
    );
}
