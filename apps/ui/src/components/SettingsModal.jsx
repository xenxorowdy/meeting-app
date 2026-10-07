import React, { useEffect, useState } from 'react';
import { Check, Award, CircleCheckBig, TriangleAlert, UserRound } from 'lucide-react';
import { cn } from '@/utils/cn';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ConnectorsPanel } from '@/components/ConnectorsPanel';
import { useConnectors } from '@/hooks/useConnectors';
import { usePreferences } from '@/hooks/usePreferences';
import { apiRequest } from '@/lib/backend';
import { isRemoteBackend } from '@/lib/connection';
import { isRecordingSupported } from '@/lib/screenRecorder';
import { listAudioInputs, systemAudioAvailability } from '@/lib/systemCapture';

const SARVAM_LANGUAGES = [
    { value: 'unknown', label: 'Detect automatically' },
    { value: 'en-IN', label: 'English (India)' },
    { value: 'hi-IN', label: 'Hindi' },
    { value: 'bn-IN', label: 'Bengali' },
    { value: 'gu-IN', label: 'Gujarati' },
    { value: 'kn-IN', label: 'Kannada' },
    { value: 'ml-IN', label: 'Malayalam' },
    { value: 'mr-IN', label: 'Marathi' },
    { value: 'pa-IN', label: 'Punjabi' },
    { value: 'ta-IN', label: 'Tamil' },
    { value: 'te-IN', label: 'Telugu' },
    { value: 'ur-IN', label: 'Urdu' },
];

const SARVAM_MODES = [
    { value: 'transcribe', label: 'Transcribe in the spoken language' },
    { value: 'codemix', label: 'Code-mixed (for example, Hinglish)' },
    { value: 'translate', label: 'Translate the transcript to English' },
    { value: 'verbatim', label: 'Verbatim, including filler words' },
    { value: 'translit', label: 'Transliterate into Roman script' },
];

const BITRATES = [
    { value: '500000', label: 'Smaller files (~225 MB / hour)' },
    { value: '800000', label: 'Balanced (~360 MB / hour)' },
    { value: '1500000', label: 'Sharper text (~675 MB / hour)' },
];

function formatBytes(bytes) {
    if (!bytes) return '0 MB';
    const mb = bytes / 1_000_000;
    return mb >= 1000 ? `${(mb / 1000).toFixed(1)} GB` : `${Math.round(mb)} MB`;
}

function SettingGroup({ children }) {
    return <div className="divide-y divide-border overflow-hidden rounded-lg border bg-muted">{children}</div>;
}

function SettingRow({ id, label, description, badge, children, stacked = false }) {
    return (
        <div className={cn('gap-4 px-4 py-4', stacked ? 'flex flex-col' : 'flex items-center justify-between')}>
            <div className="min-w-0 space-y-1">
                <div className="flex items-center gap-2">
                    <Label htmlFor={id} className="text-body font-medium">
                        {label}
                    </Label>
                    {badge}
                </div>
                {description && <p className="text-footnote text-muted-foreground">{description}</p>}
            </div>
            <div className={cn('shrink-0', stacked && 'w-full')}>{children}</div>
        </div>
    );
}

const MEETING_CLIENT_LIVE_MS = 15000;
const MEETING_CLIENT_SOURCES = { 'google-meet': 'Google Meet', zoom: 'Zoom' };

function sinceLabel(ms) {
    const seconds = Math.max(0, Math.round(ms / 1000));
    if (seconds < 5) return 'just now';
    if (seconds < 60) return `${seconds} s ago`;
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return `${minutes} min ago`;
    return `${Math.round(minutes / 60)} h ago`;
}

function BrowserExtensionRow({ isConnected }) {
    const [client, setClient] = useState(undefined);
    const [checkedAt, setCheckedAt] = useState(() => Date.now());

    useEffect(() => {
        if (!isConnected) return undefined;
        let cancelled = false;
        const load = async () => {
            try {
                const status = await apiRequest('/api/status');
                if (!cancelled) setClient(status.meetingClient || null);
            } catch {
                if (!cancelled) setClient(undefined);
            }
            if (!cancelled) setCheckedAt(Date.now());
        };
        load();
        const timer = setInterval(load, 3000);
        return () => {
            cancelled = true;
            clearInterval(timer);
        };
    }, [isConnected]);

    const lastSeen = Number.isFinite(client?.lastSeenAt) ? client.lastSeenAt : null;
    const live = lastSeen !== null && checkedAt - lastSeen <= MEETING_CLIENT_LIVE_MS;
    const source = MEETING_CLIENT_SOURCES[client?.source] || 'a meeting tab';
    const state = !isConnected
        ? 'Kesami is offline'
        : client === undefined
          ? 'Checking…'
          : lastSeen === null
            ? 'Not detected yet'
            : live
              ? `${source} · ${sinceLabel(checkedAt - lastSeen)}`
              : `Last seen ${sinceLabel(checkedAt - lastSeen)}`;

    return (
        <SettingRow
            id="browser-extension"
            label="Browser extension"
            badge={
                live ? (
                    <Badge variant="success">Connected</Badge>
                ) : (
                    <Badge variant="outline">{lastSeen === null ? 'Not connected' : 'Idle'}</Badge>
                )
            }
            description="Reads names, who is speaking and your mute state from Google Meet and Zoom calls in Chrome, Brave, Edge or Arc, so the transcript can name people and the meeting can stop when the call ends. To try it, open your browser’s extensions page (brave://extensions in Brave), turn on Developer mode, choose Load unpacked, and pick the apps/extension folder from Kesami’s source. It checks in here as soon as a call tab is open."
        >
            <span className="text-footnote text-muted-foreground" role="status">
                {state}
            </span>
        </SettingRow>
    );
}

export function SettingsModal({
    isOpen,
    onClose,
    settings,
    license,
    isConnected = false,
    calendar,
    onUpdateSettings,
    onActivateLicense,
    onConnectorConnection,
    onOpenPlans,
    initialTab = null,
    connectionLocked = false,
}) {
    const [activeTab, setActiveTab] = useState(initialTab || 'personal');
    const [preferences, setPreferences] = usePreferences();
    const connectors = useConnectors({ enabled: isOpen && isConnected && activeTab === 'connectors' });
    const handleConnectorConnection = connectors.handleConnectionEvent;

    useEffect(() => {
        if (!onConnectorConnection) return undefined;
        onConnectorConnection(handleConnectorConnection);
        return () => onConnectorConnection(null);
    }, [onConnectorConnection, handleConnectorConnection]);
    const remoteBackend = isRemoteBackend() || settings?.deploymentMode === 'hosted';
    const localMediaSupported = !remoteBackend && settings?.supportsLocalRecording !== false;
    const localTranscriptionSupported = localMediaSupported && settings?.cloudManaged !== true;
    const [formData, setFormData] = useState(settings);
    const [licenseKey, setLicenseKey] = useState('');
    const [activation, setActivation] = useState(null);
    const [saveState, setSaveState] = useState(null);
    const [usageBytes, setUsageBytes] = useState(null);
    const [screenPermission, setScreenPermission] = useState(null);
    const [audioInputs, setAudioInputs] = useState([]);
    const [systemAudioSource, setSystemAudioSource] = useState(null);
    const recordingSupported = isRecordingSupported();
    const defaultSystemSourceLabel =
        systemAudioSource?.source === 'native'
            ? 'Automatic — system audio helper'
            : systemAudioSource?.source === 'device'
              ? `Automatic — ${systemAudioSource.device?.label || 'loopback device'}`
              : 'Automatic — no source detected';
    const systemAudioDescription =
        systemAudioSource && !systemAudioSource.available
            ? systemAudioSource.reason
            : 'Everyone else on the call is captured here and transcribed as soon as the meeting starts, with or without a screen recording.';
    const widgetSupported = Boolean(globalThis.kesamiShell);
    const notificationTestSupported = Boolean(globalThis.kesamiShell?.testNotification);
    const [notificationTest, setNotificationTest] = useState(null);

    const handleTestNotification = async () => {
        setNotificationTest({ status: 'busy' });
        try {
            const result = await globalThis.kesamiShell.testNotification();
            if (!result?.shown) {
                setNotificationTest({ status: 'error', message: result?.reason || 'The notification couldn’t be sent.' });
                return;
            }
            const problem =
                result.backendOnline === false
                    ? ' Kesami’s engine isn’t running yet, so meeting reminders can’t load your calendar — it restarts on its own within a few seconds.'
                    : result.calendarState === 'none'
                      ? ' Connect a calendar above to get meeting reminders.'
                      : '';
            setNotificationTest({
                status: problem ? 'error' : 'ok',
                message: `Sent. If nothing appeared, allow notifications for Kesami in System Settings.${problem}`,
            });
        } catch (cause) {
            setNotificationTest({ status: 'error', message: cause?.message || 'The notification couldn’t be sent.' });
        }
    };

    // Adopt whatever the backend reported the last time the sheet was opened. The
    // key field always starts blank — the backend never sends it back.
    useEffect(() => {
        if (isOpen) {
            setFormData({
                ...settings,
                transcriptionProvider: settings?.transcriptionProvider === 'sarvam' && localTranscriptionSupported ? 'sarvam' : 'sarvam-realtime',
                sarvamDiarizeAfterMeeting: localTranscriptionSupported && settings?.sarvamDiarizeAfterMeeting !== false,
                geminiApiKey: '',
                openaiApiKey: '',
                sarvamApiKey: '',
                googleCalendarClientSecret: '',
            });
            setSaveState(null);
            setActivation(null);
        }
    }, [isOpen, settings, localTranscriptionSupported]);

    useEffect(() => {
        if (isOpen && initialTab) setActiveTab(initialTab);
    }, [isOpen, initialTab]);

    useEffect(() => {
        if (!isOpen || !globalThis.kesamiRecorder) return;
        globalThis.kesamiRecorder
            .usage()
            .then(result => setUsageBytes(result.bytes))
            .catch(() => setUsageBytes(0));
        globalThis.kesamiRecorder
            .screenPermission()
            .then(setScreenPermission)
            .catch(() => {});
    }, [isOpen]);

    useEffect(() => {
        if (!isOpen) return undefined;
        let cancelled = false;
        listAudioInputs()
            .then(devices => {
                if (!cancelled) setAudioInputs(devices);
            })
            .catch(() => {});
        systemAudioAvailability()
            .then(state => {
                if (!cancelled) setSystemAudioSource(state);
            })
            .catch(() => {});
        return () => {
            cancelled = true;
        };
    }, [isOpen]);

    const handleActivateLicense = async event => {
        event.preventDefault();
        if (!licenseKey.trim() || !onActivateLicense) return;
        setActivation({ status: 'loading' });
        const result = await onActivateLicense(licenseKey.trim());
        setActivation({ status: result.ok ? 'valid' : 'invalid', message: result.message });
    };

    const handleSave = async () => {
        if (!onUpdateSettings) return;
        setSaveState({ status: 'saving' });

        // An untouched key field means "leave it alone". Sending the empty string
        // would clear a key the user never intended to remove.
        const payload = {
            ...formData,
            transcriptionProvider,
            sarvamDiarizeAfterMeeting: localTranscriptionSupported && formData.sarvamDiarizeAfterMeeting !== false,
        };
        delete payload.whisperModel;
        delete payload.sttLanguage;
        delete payload.deploymentMode;
        delete payload.supportsLocalRecording;
        delete payload.calendarConnectSupported;
        delete payload.cloudManaged;
        if (!payload.geminiApiKey) delete payload.geminiApiKey;
        if (!payload.openaiApiKey) delete payload.openaiApiKey;
        if (!payload.sarvamApiKey) delete payload.sarvamApiKey;
        delete payload.geminiApiKeySet;
        delete payload.openaiApiKeySet;
        delete payload.sarvamApiKeySet;
        for (const provider of ['google', 'microsoft']) {
            for (const suffix of ['ClientId', 'ClientSecret']) {
                const key = `${provider}Calendar${suffix}`;
                if (!payload[key]?.trim()) delete payload[key];
                delete payload[`${key}Set`];
            }
            delete payload[`${provider}CalendarConnected`];
        }

        const result = await onUpdateSettings(payload);

        if (!result?.ok) {
            setSaveState({ status: 'error', message: result?.message || 'These settings couldn’t be saved. Try again.' });
            return;
        }

        setSaveState({
            status: 'saved',
            message: result.persisted ? 'Saved.' : 'Applied for this session.',
        });

        if (result.persisted) {
            setTimeout(onClose, 400);
        }
    };

    const transcriptionProvider = formData.transcriptionProvider === 'sarvam' && localTranscriptionSupported ? 'sarvam' : 'sarvam-realtime';
    const usesSarvamBatch = transcriptionProvider === 'sarvam';
    const diarizeAfterMeeting = localTranscriptionSupported && formData.sarvamDiarizeAfterMeeting !== false;
    const diarizes = usesSarvamBatch || diarizeAfterMeeting;

    const tier = license?.tier ? license.tier.charAt(0).toUpperCase() + license.tier.slice(1) : 'Unknown';
    const meetingsThisMonth = license?.usage?.meetingsThisMonth ?? license?.usage?.meetingsCount;

    return (
        <Dialog open={isOpen} onOpenChange={open => !open && onClose()}>
            <DialogContent className="flex max-h-[86vh] flex-col gap-0 p-0 sm:max-w-3xl">
                <DialogHeader className="space-y-1 p-4 pb-4 pr-12 text-left hairline-bottom">
                    <DialogTitle className="text-title2 font-semibold">Settings</DialogTitle>
                    <DialogDescription className="text-callout text-muted-foreground">Make Kesami work the way you do.</DialogDescription>
                </DialogHeader>

                <Tabs value={activeTab} onValueChange={setActiveTab} className="flex min-h-0 flex-1 flex-col">
                    <div className="px-4 pt-4">
                        <TabsList className="h-auto w-full justify-start overflow-x-auto p-1">
                            <TabsTrigger value="personal" className="h-9 flex-1">
                                Personal
                            </TabsTrigger>
                            <TabsTrigger value="audio" className="h-9 flex-1">
                                Audio
                            </TabsTrigger>
                            <TabsTrigger value="ai" className="h-9 flex-1">
                                Transcription
                            </TabsTrigger>
                            <TabsTrigger value="calendar" className="h-9 flex-1">
                                Calendar
                            </TabsTrigger>
                            <TabsTrigger value="connectors" className="h-9 flex-1">
                                Connectors
                            </TabsTrigger>
                            <TabsTrigger value="recording" className="h-9 flex-1">
                                Recording
                            </TabsTrigger>
                            <TabsTrigger value="license" className="h-9 flex-1">
                                Plan
                            </TabsTrigger>
                        </TabsList>
                    </div>

                    <div className="min-h-0 flex-1 overflow-y-auto p-4">
                        <TabsContent value="personal" className="space-y-5">
                            <div className="flex items-center gap-3 rounded-xl border bg-primary/5 p-4">
                                <div className="flex size-11 items-center justify-center rounded-xl bg-primary/10 text-primary">
                                    <UserRound className="size-5" aria-hidden="true" />
                                </div>
                                <div>
                                    <h3 className="text-body font-semibold">Your workspace, your way</h3>
                                    <p className="text-callout text-muted-foreground">Personal preferences save automatically on this device.</p>
                                </div>
                            </div>
                            <SettingGroup>
                                <SettingRow id="display-name" label="Your name" description="Used to personalize your workspace." stacked>
                                    <Input
                                        id="display-name"
                                        autoComplete="given-name"
                                        maxLength={80}
                                        placeholder="How should Kesami greet you?"
                                        value={preferences.displayName}
                                        onChange={event => setPreferences({ displayName: event.target.value })}
                                    />
                                </SettingRow>
                                {/* <SettingRow id="workspace-name" label="Workspace name" stacked>
                                    <Input id="workspace-name" maxLength={80} placeholder="My workspace" value={preferences.workspaceName} onChange={event => setPreferences({ workspaceName: event.target.value })} />
                                </SettingRow>*/}
                                <SettingRow
                                    id="text-size"
                                    label="Text size"
                                    description="Comfortable reading across notes, transcripts, and chat."
                                    stacked
                                >
                                    <Select value={preferences.textSize} onValueChange={value => setPreferences({ textSize: value })}>
                                        <SelectTrigger id="text-size">
                                            <SelectValue />
                                        </SelectTrigger>
                                        <SelectContent>
                                            <SelectItem value="comfortable">Comfortable</SelectItem>
                                            <SelectItem value="large">Large</SelectItem>
                                        </SelectContent>
                                    </Select>
                                </SettingRow>
                                <SettingRow
                                    id="reduced-motion"
                                    label="Reduce motion"
                                    description="Keep transitions and live effects subtle. Your system preference is also respected."
                                >
                                    <Switch
                                        id="reduced-motion"
                                        checked={preferences.reducedMotion}
                                        onCheckedChange={value => setPreferences({ reducedMotion: value })}
                                    />
                                </SettingRow>
                            </SettingGroup>
                        </TabsContent>

                        <TabsContent value="audio" className="space-y-4">
                            {connectionLocked && (
                                <p className="text-callout text-muted-foreground">
                                    Finish the current meeting before changing audio devices. Mute and noise cancellation remain available.
                                </p>
                            )}
                            <SettingGroup>
                                <SettingRow
                                    id="mic-device"
                                    label="Microphone"
                                    description="Everything picked up by this microphone is attributed to you in the transcript."
                                    stacked
                                >
                                    <Select
                                        disabled={connectionLocked}
                                        value={formData.micDeviceId}
                                        onValueChange={value => setFormData({ ...formData, micDeviceId: value })}
                                    >
                                        <SelectTrigger id="mic-device" className="w-full">
                                            <SelectValue />
                                        </SelectTrigger>
                                        <SelectContent>
                                            <SelectItem value="default">System default microphone</SelectItem>
                                            {audioInputs.map(device => (
                                                <SelectItem key={device.deviceId} value={device.deviceId}>
                                                    {device.label}
                                                </SelectItem>
                                            ))}
                                        </SelectContent>
                                    </Select>
                                </SettingRow>

                                <SettingRow id="system-device" label="Meeting audio" description={systemAudioDescription} stacked>
                                    <Select
                                        disabled={connectionLocked}
                                        value={formData.systemDeviceId}
                                        onValueChange={value => setFormData({ ...formData, systemDeviceId: value })}
                                    >
                                        <SelectTrigger id="system-device" className="w-full">
                                            <SelectValue />
                                        </SelectTrigger>
                                        <SelectContent>
                                            <SelectItem value="default">{defaultSystemSourceLabel}</SelectItem>
                                            {audioInputs.map(device => (
                                                <SelectItem key={device.deviceId} value={device.deviceId}>
                                                    {device.label}
                                                </SelectItem>
                                            ))}
                                        </SelectContent>
                                    </Select>
                                </SettingRow>

                                <SettingRow
                                    id="noise-suppression"
                                    label="Noise cancellation"
                                    description="Reduces background noise in your microphone and the recorded audio. Applies during recording too."
                                >
                                    <Switch
                                        id="noise-suppression"
                                        checked={formData.noiseSuppression !== false}
                                        onCheckedChange={checked => setFormData({ ...formData, noiseSuppression: checked })}
                                    />
                                </SettingRow>

                                <SettingRow
                                    id="echo-suppression"
                                    label="Echo suppression"
                                    description="Drops speaker bleed picked up by the microphone."
                                >
                                    <Switch
                                        id="echo-suppression"
                                        checked={Boolean(formData.echoSuppression)}
                                        onCheckedChange={checked => setFormData({ ...formData, echoSuppression: checked })}
                                    />
                                </SettingRow>
                            </SettingGroup>
                        </TabsContent>

                        <TabsContent value="ai" className="space-y-4">
                            <SettingGroup>
                                <SettingRow
                                    id="sarvam-language"
                                    label="Meeting language"
                                    description="The language people mostly speak. Detect automatically handles mixed-language calls."
                                    stacked
                                >
                                    <Select
                                        value={formData.sarvamLanguage || 'unknown'}
                                        onValueChange={value => setFormData({ ...formData, sarvamLanguage: value })}
                                    >
                                        <SelectTrigger id="sarvam-language" className="w-full">
                                            <SelectValue />
                                        </SelectTrigger>
                                        <SelectContent>
                                            {SARVAM_LANGUAGES.map(languageOption => (
                                                <SelectItem key={languageOption.value} value={languageOption.value}>
                                                    {languageOption.label}
                                                </SelectItem>
                                            ))}
                                        </SelectContent>
                                    </Select>
                                </SettingRow>

                                <SettingRow id="sarvam-mode" label="Transcript style" stacked>
                                    <Select
                                        value={formData.sarvamMode || 'transcribe'}
                                        onValueChange={value => setFormData({ ...formData, sarvamMode: value })}
                                    >
                                        <SelectTrigger id="sarvam-mode" className="w-full">
                                            <SelectValue />
                                        </SelectTrigger>
                                        <SelectContent>
                                            {SARVAM_MODES.map(mode => (
                                                <SelectItem key={mode.value} value={mode.value}>
                                                    {mode.label}
                                                </SelectItem>
                                            ))}
                                        </SelectContent>
                                    </Select>
                                </SettingRow>

                                {!usesSarvamBatch && localTranscriptionSupported && (
                                    <SettingRow
                                        id="sarvam-diarize-after"
                                        label="Separate speakers after the meeting"
                                        description={
                                            localMediaSupported
                                                ? 'Refines who said what once the meeting ends.'
                                                : 'Not available with this workspace. Live speaker labels still work.'
                                        }
                                    >
                                        <Switch
                                            id="sarvam-diarize-after"
                                            disabled={!localMediaSupported}
                                            checked={diarizeAfterMeeting}
                                            onCheckedChange={checked => setFormData({ ...formData, sarvamDiarizeAfterMeeting: checked })}
                                        />
                                    </SettingRow>
                                )}

                                {diarizes && (
                                    <SettingRow
                                        id="sarvam-speakers"
                                        label="Expected speakers"
                                        description="Automatic detection is recommended for meetings."
                                        stacked
                                    >
                                        <Select
                                            value={formData.sarvamNumSpeakers == null ? 'auto' : String(formData.sarvamNumSpeakers)}
                                            onValueChange={value =>
                                                setFormData({ ...formData, sarvamNumSpeakers: value === 'auto' ? null : Number(value) })
                                            }
                                        >
                                            <SelectTrigger id="sarvam-speakers" className="w-full">
                                                <SelectValue />
                                            </SelectTrigger>
                                            <SelectContent>
                                                <SelectItem value="auto">Detect automatically</SelectItem>
                                                {[2, 3, 4, 5, 6, 8, 10, 15, 20].map(count => (
                                                    <SelectItem key={count} value={String(count)}>
                                                        {count} speakers
                                                    </SelectItem>
                                                ))}
                                            </SelectContent>
                                        </Select>
                                    </SettingRow>
                                )}
                                <SettingRow
                                    id="auto-summarize"
                                    label="Summarize when a recording ends"
                                    description="Creates a summary and action items from your transcript when the meeting ends."
                                >
                                    <Switch
                                        id="auto-summarize"
                                        checked={Boolean(formData.autoSummarize)}
                                        onCheckedChange={checked => setFormData({ ...formData, autoSummarize: checked })}
                                    />
                                </SettingRow>
                            </SettingGroup>
                        </TabsContent>

                        <TabsContent value="calendar" className="space-y-4">
                            <SettingGroup>
                                {(calendar?.providers || []).map(provider => {
                                    const waiting = calendar?.pendingProvider === provider.provider;
                                    return (
                                        <SettingRow
                                            key={provider.provider}
                                            id={`calendar-${provider.provider}`}
                                            label={provider.label}
                                            description={
                                                provider.connected
                                                    ? provider.provider === 'google'
                                                        ? `Connected as ${provider.account || 'your account'}. If you previously granted read-only access, disconnect and reconnect to allow event editing.`
                                                        : `Connected as ${provider.account || 'your account'}. Kesami reads upcoming events and never writes to your calendar.`
                                                    : provider.configured
                                                      ? provider.provider === 'google'
                                                          ? 'Opens your browser to sign in, then returns to Kesami. Requests permission to view, create, edit, and delete events.'
                                                          : 'Opens your browser to sign in, then returns to Kesami. Read-only access to events.'
                                                      : 'Not available in this version of Kesami yet.'
                                            }
                                            badge={provider.connected ? <Badge variant="success">Connected</Badge> : null}
                                        >
                                            {provider.connected ? (
                                                <Button variant="secondary" size="sm" onClick={() => calendar.disconnect(provider.provider)}>
                                                    Disconnect
                                                </Button>
                                            ) : (
                                                <Button
                                                    size="sm"
                                                    disabled={!provider.configured || waiting}
                                                    onClick={() => calendar.connect(provider.provider)}
                                                >
                                                    {waiting ? 'Waiting for browser' : 'Connect'}
                                                </Button>
                                            )}
                                        </SettingRow>
                                    );
                                })}
                            </SettingGroup>

                            {calendar?.error && (
                                <div className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/[0.08] px-4 py-4">
                                    <TriangleAlert className="mt-[1px] size-4 shrink-0 text-warning" aria-hidden="true" />
                                    <p className="text-footnote text-muted-foreground">{calendar.error}</p>
                                </div>
                            )}

                            <SettingGroup>
                                <SettingRow
                                    id="meeting-reminders"
                                    label="Remind me before a meeting"
                                    description="A notification a minute before any scheduled meeting, with a Join button, and a countdown in the menu bar. Clicking the notification opens the call and starts recording."
                                >
                                    <Switch
                                        id="meeting-reminders"
                                        checked={formData.meetingReminders !== false}
                                        onCheckedChange={checked => setFormData({ ...formData, meetingReminders: checked })}
                                    />
                                </SettingRow>
                                {notificationTestSupported && (
                                    <SettingRow
                                        id="test-notification"
                                        label="Test notifications"
                                        description={
                                            notificationTest?.message ||
                                            'Sends a sample notification. The first one makes macOS ask whether Kesami may show notifications.'
                                        }
                                    >
                                        <div className="flex items-center gap-2">
                                            <Button variant="ghost" size="sm" onClick={() => globalThis.kesamiShell.openNotificationSettings?.()}>
                                                System Settings
                                            </Button>
                                            <Button variant="secondary" size="sm" disabled={notificationTest?.status === 'busy'} onClick={handleTestNotification}>
                                                Send test
                                            </Button>
                                        </div>
                                    </SettingRow>
                                )}
                                <SettingRow
                                    id="auto-record-meetings"
                                    label="Record scheduled meetings automatically"
                                    description="When a calendar meeting starts, recording begins on its own (sound only). The reminder says so and has a Don’t Record button for that meeting."
                                >
                                    <Switch
                                        id="auto-record-meetings"
                                        checked={formData.autoRecordMeetings !== false}
                                        onCheckedChange={checked => setFormData({ ...formData, autoRecordMeetings: checked })}
                                    />
                                </SettingRow>
                                <BrowserExtensionRow isConnected={isConnected} />
                                <SettingRow
                                    id="auto-stop-on-meeting-end"
                                    label="Stop recording when the meeting ends"
                                    description="When the meeting client reports the call is over — or its tab drops out — recording stops and the summary is generated. A rejoin within a few seconds is not treated as an end."
                                >
                                    <Switch
                                        id="auto-stop-on-meeting-end"
                                        checked={formData.autoStopOnMeetingEnd !== false}
                                        onCheckedChange={checked => setFormData({ ...formData, autoStopOnMeetingEnd: checked })}
                                    />
                                </SettingRow>
                                <SettingRow
                                    id="prompt-unscheduled-calls"
                                    label="Prompt to record detected calls"
                                    description="A floating card when a browser call or sustained microphone use is detected, including calendar meetings. Start records audio immediately; unanswered cards disappear after two minutes."
                                >
                                    <Switch
                                        id="prompt-unscheduled-calls"
                                        checked={formData.promptForUnscheduledCalls !== false}
                                        onCheckedChange={checked => setFormData({ ...formData, promptForUnscheduledCalls: checked })}
                                    />
                                </SettingRow>
                            </SettingGroup>
                        </TabsContent>

                        <TabsContent value="connectors" className="space-y-4">
                            <ConnectorsPanel connectors={connectors} disabled={!isConnected} />
                        </TabsContent>

                        <TabsContent value="recording" className="space-y-4">
                            {!recordingSupported && (
                                <p className="flex items-start gap-2 rounded-lg border bg-muted px-4 py-4 text-callout text-muted-foreground">
                                    <TriangleAlert className="mt-[2px] size-4 shrink-0" aria-hidden="true" />
                                    Screen recording needs the Kesami desktop window. It is unavailable in a browser tab.
                                </p>
                            )}

                            <SettingGroup>
                                <SettingRow
                                    id="floating-widget"
                                    label="Floating status widget"
                                    description="A small always-on-top pill that appears while a meeting is being transcribed. Click it to read the live transcript without leaving your call."
                                >
                                    <Switch
                                        id="floating-widget"
                                        disabled={!widgetSupported}
                                        checked={formData.floatingWidget !== false}
                                        onCheckedChange={checked => setFormData({ ...formData, floatingWidget: checked })}
                                    />
                                </SettingRow>
                            </SettingGroup>

                            <SettingGroup>
                                <SettingRow
                                    id="recording-bitrate"
                                    label="Video quality"
                                    description="Used when you record a screen. You choose sound only or screen and sound each time a meeting starts."
                                    stacked
                                >
                                    <Select
                                        value={String(formData.recordingBitsPerSecond || 800000)}
                                        onValueChange={value => setFormData({ ...formData, recordingBitsPerSecond: Number(value) })}
                                    >
                                        <SelectTrigger id="recording-bitrate" className="w-full" disabled={!recordingSupported}>
                                            <SelectValue />
                                        </SelectTrigger>
                                        <SelectContent>
                                            {BITRATES.map(option => (
                                                <SelectItem key={option.value} value={option.value}>
                                                    {option.label}
                                                </SelectItem>
                                            ))}
                                        </SelectContent>
                                    </Select>
                                </SettingRow>
                            </SettingGroup>

                            <p className="text-footnote text-muted-foreground">
                                {!recordingSupported
                                    ? 'Recordings are available in the desktop app.'
                                    : usageBytes === null
                                      ? 'Measuring recording storage…'
                                      : `Recordings are using ${formatBytes(usageBytes)}.`}
                                {' Deleting a meeting from your library also deletes its recording.'}
                            </p>

                            {screenPermission === 'denied' && (
                                <p className="flex items-start gap-1 text-footnote text-warning">
                                    <TriangleAlert className="mt-[1px] size-4 shrink-0" aria-hidden="true" />
                                    macOS is blocking screen recording. Allow Kesami in System Settings › Privacy &amp; Security › Screen Recording,
                                    then restart the app.
                                </p>
                            )}
                        </TabsContent>

                        <TabsContent value="license" className="space-y-4">
                            {license ? (
                                <div className="flex items-center gap-4 rounded-lg border bg-muted px-4 py-4">
                                    <div
                                        className={cn(
                                            'flex size-9 items-center justify-center rounded-lg',
                                            license.tier === 'free' ? 'bg-secondary text-secondary-foreground' : 'bg-primary text-primary-foreground'
                                        )}
                                    >
                                        <Award className="size-4" aria-hidden="true" />
                                    </div>
                                    <div className="min-w-0">
                                        <div className="flex items-center gap-2">
                                            <h4 className="text-headline font-semibold">{tier}</h4>
                                            {license.status === 'active' && (
                                                <Badge variant="success">
                                                    <Check aria-hidden="true" />
                                                    Active
                                                </Badge>
                                            )}
                                            {license.canRecord === false && <Badge variant="destructive">Recording blocked</Badge>}
                                        </div>
                                        <p className="text-footnote text-muted-foreground">
                                            {typeof meetingsThisMonth === 'number' ? `${meetingsThisMonth} meetings this month` : 'Your current plan'}
                                        </p>
                                    </div>
                                </div>
                            ) : (
                                <p className="flex items-center gap-2 rounded-lg border bg-muted px-4 py-4 text-callout text-muted-foreground">
                                    <TriangleAlert className="size-4 shrink-0" aria-hidden="true" />
                                    Plan details are unavailable while Kesami is offline.
                                </p>
                            )}

                            {license?.tier !== 'pro' && license?.tier !== 'enterprise' && typeof license?.usage?.minutesUsed === 'number' && (
                                <p className="text-callout text-muted-foreground">
                                    {license.usage.minutesUsed} of {license.usage.freeMonthlyMinutes} free recording minutes used this month.
                                </p>
                            )}

                            {onOpenPlans && (
                                <Button variant="outline" onClick={onOpenPlans}>
                                    <Award aria-hidden="true" />
                                    {license?.tier === 'pro' || license?.tier === 'enterprise' ? 'Manage plan' : 'See plans'}
                                </Button>
                            )}

                            {license?.licenseActivationSupported === true && (
                                <form onSubmit={handleActivateLicense} className="space-y-2">
                                    <Label htmlFor="license-key" className="text-body font-medium">
                                        License key
                                    </Label>
                                    <div className="flex gap-2">
                                        <Input
                                            id="license-key"
                                            value={licenseKey}
                                            onChange={event => setLicenseKey(event.target.value)}
                                            placeholder="PRO-XXXX-XXXX-XXXX"
                                            className="font-mono"
                                            disabled={!isConnected}
                                        />
                                        <Button
                                            type="submit"
                                            variant="outline"
                                            disabled={!isConnected || !licenseKey.trim() || activation?.status === 'loading'}
                                        >
                                            {activation?.status === 'loading' ? 'Checking' : 'Activate'}
                                        </Button>
                                    </div>

                                    {activation?.status === 'valid' && (
                                        <p className="flex items-center gap-1 text-footnote text-success" role="status">
                                            <CircleCheckBig className="size-4" aria-hidden="true" />
                                            {activation.message}
                                        </p>
                                    )}
                                    {activation?.status === 'invalid' && (
                                        <p className="flex items-start gap-1 text-footnote text-destructive" role="alert">
                                            <TriangleAlert className="mt-[1px] size-4 shrink-0" aria-hidden="true" />
                                            {activation.message}
                                        </p>
                                    )}
                                </form>
                            )}
                        </TabsContent>
                    </div>
                </Tabs>

                <DialogFooter className="flex-row items-center justify-between gap-4 p-4 pt-4 hairline-top sm:justify-between">
                    <div className="min-w-0">
                        {saveState?.message && (
                            <p className={cn('truncate text-footnote', saveState.status === 'error' ? 'text-destructive' : 'text-muted-foreground')}>
                                {saveState.message}
                            </p>
                        )}
                    </div>

                    <div className="flex items-center gap-2">
                        <Button variant="ghost" onClick={onClose}>
                            Close
                        </Button>
                        {!['personal', 'connectors', 'license'].includes(activeTab) && (
                            <Button onClick={handleSave} disabled={!isConnected || saveState?.status === 'saving'}>
                                {saveState?.status === 'saved' && <Check aria-hidden="true" />}
                                {saveState?.status === 'saving' ? 'Saving…' : saveState?.status === 'saved' ? 'Saved' : 'Save changes'}
                            </Button>
                        )}
                    </div>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
