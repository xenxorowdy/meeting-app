import React, { useEffect, useState } from 'react';
import { Check, Award, CircleCheckBig, TriangleAlert, Server, ShieldCheck, UserRound, Loader2 } from 'lucide-react';
import { cn } from '@/utils/cn';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { usePreferences } from '@/hooks/usePreferences';
import { getBackendConnection, saveBackendConnection, testBackendConnection, isRemoteBackend } from '@/lib/connection';
import { isRecordingSupported } from '@/lib/screenRecorder';

const TRANSCRIPTION_PROVIDERS = [
    { value: 'sarvam-realtime', label: 'Live transcription · recommended' },
    { value: 'sarvam', label: 'Process recording after the meeting' },
];

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

// What the backend can actually run. The previous list offered GPT-4o and a local
// Llama, neither of which it has ever had a client for.
const SUMMARY_PROVIDERS = [
    { value: 'auto', label: 'Choose automatically' },
    { value: 'gemini', label: 'Google Gemini' },
    { value: 'claude-cli', label: 'Claude Code CLI' },
    { value: 'heuristic', label: 'Basic summary (no AI provider)' },
];

const GEMINI_MODELS = [
    { value: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash — fast, recommended' },
    { value: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro — slower, more thorough' },
];

const CLAUDE_MODELS = [
    { value: 'sonnet', label: 'Claude Sonnet' },
    { value: 'opus', label: 'Claude Opus' },
    { value: 'haiku', label: 'Claude Haiku' },
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

export function SettingsModal({
    isOpen,
    onClose,
    settings,
    license,
    engine,
    backendUrl,
    isConnected = false,
    calendar,
    onUpdateSettings,
    onActivateLicense,
    connectionLocked = false,
}) {
    const [activeTab, setActiveTab] = useState('personal');
    const [preferences, setPreferences] = usePreferences();
    const [connectionDraft, setConnectionDraft] = useState(getBackendConnection);
    const [connectionState, setConnectionState] = useState(null);
    const remoteBackend = isRemoteBackend() || settings?.deploymentMode === 'hosted';
    const localMediaSupported = !remoteBackend && settings?.supportsLocalRecording !== false;
    const [formData, setFormData] = useState(settings);
    const [licenseKey, setLicenseKey] = useState('');
    const [activation, setActivation] = useState(null);
    const [saveState, setSaveState] = useState(null);
    const [usageBytes, setUsageBytes] = useState(null);
    const [screenPermission, setScreenPermission] = useState(null);
    const recordingSupported = isRecordingSupported();
    const widgetSupported = Boolean(globalThis.alphaShell);

    // Adopt whatever the backend reported the last time the sheet was opened. The
    // key field always starts blank — the backend never sends it back.
    useEffect(() => {
        if (isOpen) {
            setFormData({ ...settings, transcriptionProvider: settings?.transcriptionProvider === 'sarvam' && localMediaSupported ? 'sarvam' : 'sarvam-realtime', sarvamDiarizeAfterMeeting: localMediaSupported && settings?.sarvamDiarizeAfterMeeting !== false, geminiApiKey: '', sarvamApiKey: '', googleCalendarClientSecret: '' });
            setConnectionDraft(getBackendConnection());
            setConnectionState(null);
            setSaveState(null);
            setActivation(null);
        }
    }, [isOpen, settings, localMediaSupported]);

    useEffect(() => {
        if (!isOpen || !globalThis.alphaRecorder) return;
        globalThis.alphaRecorder
            .usage()
            .then(result => setUsageBytes(result.bytes))
            .catch(() => setUsageBytes(0));
        globalThis.alphaRecorder
            .screenPermission()
            .then(setScreenPermission)
            .catch(() => {});
    }, [isOpen]);

    const handleActivateLicense = async event => {
        event.preventDefault();
        if (!licenseKey.trim() || !onActivateLicense) return;
        setActivation({ status: 'loading' });
        const result = await onActivateLicense(licenseKey.trim());
        setActivation({ status: result.ok ? 'valid' : 'invalid', message: result.message });
    };

    const handleConnection = async (save = false) => {
        setConnectionState({ status: 'checking' });
        try {
            await testBackendConnection(connectionDraft);
            if (save) {
                await saveBackendConnection(connectionDraft);
                globalThis.location?.reload();
            } else {
                setConnectionState({ status: 'success', message: 'Connected and authenticated. Your workspace is ready.' });
            }
        } catch (error) {
            setConnectionState({ status: 'error', message: error.message });
        }
    };

    const handleSave = async () => {
        if (!onUpdateSettings) return;
        setSaveState({ status: 'saving' });

        // An untouched key field means "leave it alone". Sending the empty string
        // would clear a key the user never intended to remove.
        const payload = { ...formData, transcriptionProvider, sarvamDiarizeAfterMeeting: localMediaSupported && formData.sarvamDiarizeAfterMeeting !== false };
        delete payload.whisperModel;
        delete payload.sttLanguage;
        delete payload.deploymentMode;
        delete payload.supportsLocalRecording;
        delete payload.calendarConnectSupported;
        if (!payload.geminiApiKey) delete payload.geminiApiKey;
        if (!payload.sarvamApiKey) delete payload.sarvamApiKey;
        delete payload.geminiApiKeySet;
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
            setSaveState({ status: 'error', message: result?.message || 'The backend rejected these settings.' });
            return;
        }

        setSaveState({
            status: 'saved',
            message: result.persisted ? 'Saved to the backend.' : 'Applied for this session — the core backend does not store settings yet.',
        });

        if (result.persisted) {
            setTimeout(onClose, 400);
        }
    };

    const stt = engine?.stt;
    const summary = engine?.summary;
    // Which models are worth offering follows from the engine that will run: a
    // Gemini model handed to the Claude CLI is rejected outright.
    const resolvedProvider =
        (formData.summaryProvider && formData.summaryProvider !== 'auto' ? formData.summaryProvider : summary?.provider) || 'gemini';
    const summaryModels = resolvedProvider === 'claude-cli' ? CLAUDE_MODELS : resolvedProvider === 'gemini' ? GEMINI_MODELS : [];
    const transcriptionProvider = formData.transcriptionProvider === 'sarvam' && localMediaSupported ? 'sarvam' : 'sarvam-realtime';
    const usesSarvam = transcriptionProvider.startsWith('sarvam');
    const usesSarvamBatch = transcriptionProvider === 'sarvam';
    const diarizeAfterMeeting = localMediaSupported && formData.sarvamDiarizeAfterMeeting !== false;
    const diarizes = usesSarvamBatch || diarizeAfterMeeting;

    const tier = license?.tier ? license.tier.charAt(0).toUpperCase() + license.tier.slice(1) : 'Unknown';
    const meetingsThisMonth = license?.usage?.meetingsThisMonth ?? license?.usage?.meetingsCount;

    return (
        <Dialog open={isOpen} onOpenChange={open => !open && onClose()}>
            <DialogContent className="flex max-h-[86vh] flex-col gap-0 p-0 sm:max-w-3xl">
                <DialogHeader className="space-y-1 p-4 pb-4 pr-12 text-left hairline-bottom">
                    <DialogTitle className="text-title2 font-semibold">Settings</DialogTitle>
                    <DialogDescription className="text-callout text-muted-foreground">
                        Make Alpha work the way you do.
                    </DialogDescription>
                </DialogHeader>

                <Tabs value={activeTab} onValueChange={setActiveTab} className="flex min-h-0 flex-1 flex-col">
                    <div className="px-4 pt-4">
                        <TabsList className="h-auto w-full justify-start overflow-x-auto p-1">
                            <TabsTrigger value="personal" className="h-9 flex-1">Personal</TabsTrigger>
                            <TabsTrigger value="audio" className="h-9 flex-1">
                                Audio
                            </TabsTrigger>
                            <TabsTrigger value="ai" className="h-9 flex-1">
                                Transcription
                            </TabsTrigger>
                            <TabsTrigger value="calendar" className="h-9 flex-1">
                                Calendar
                            </TabsTrigger>
                            <TabsTrigger value="recording" className="h-9 flex-1">
                                Recording
                            </TabsTrigger>
                            <TabsTrigger value="connection" className="h-9 flex-1">Connection</TabsTrigger>
                            <TabsTrigger value="license" className="h-9 flex-1">
                                License
                            </TabsTrigger>
                        </TabsList>
                    </div>

                    <div className="min-h-0 flex-1 overflow-y-auto p-4">
                        <TabsContent value="personal" className="space-y-5">
                            <div className="flex items-center gap-3 rounded-xl border bg-primary/5 p-4">
                                <div className="flex size-11 items-center justify-center rounded-xl bg-primary/10 text-primary"><UserRound className="size-5" aria-hidden="true" /></div>
                                <div><h3 className="text-body font-semibold">Your workspace, your way</h3><p className="text-callout text-muted-foreground">Personal preferences save automatically on this device.</p></div>
                            </div>
                            <SettingGroup>
                                <SettingRow id="display-name" label="Your name" description="Used to personalize your workspace." stacked>
                                    <Input id="display-name" autoComplete="given-name" maxLength={80} placeholder="How should Alpha greet you?" value={preferences.displayName} onChange={event => setPreferences({ displayName: event.target.value })} />
                                </SettingRow>
                                <SettingRow id="workspace-name" label="Workspace name" stacked>
                                    <Input id="workspace-name" maxLength={80} placeholder="My workspace" value={preferences.workspaceName} onChange={event => setPreferences({ workspaceName: event.target.value })} />
                                </SettingRow>
                                <SettingRow id="text-size" label="Text size" description="Comfortable reading across notes, transcripts, and chat." stacked>
                                    <Select value={preferences.textSize} onValueChange={value => setPreferences({ textSize: value })}>
                                        <SelectTrigger id="text-size"><SelectValue /></SelectTrigger>
                                        <SelectContent><SelectItem value="comfortable">Comfortable</SelectItem><SelectItem value="large">Large</SelectItem></SelectContent>
                                    </Select>
                                </SettingRow>
                                <SettingRow id="reduced-motion" label="Reduce motion" description="Keep transitions and live effects subtle. Your system preference is also respected.">
                                    <Switch id="reduced-motion" checked={preferences.reducedMotion} onCheckedChange={value => setPreferences({ reducedMotion: value })} />
                                </SettingRow>
                            </SettingGroup>
                        </TabsContent>

                        <TabsContent value="connection" className="space-y-5">
                            <div className="flex items-start gap-3 rounded-xl border bg-muted p-4">
                                <Server className="mt-1 size-5 shrink-0 text-primary" aria-hidden="true" />
                                <div className="space-y-1"><h3 className="text-body font-semibold">{remoteBackend ? 'Hosted backend' : 'Local backend'}</h3><p className="text-callout leading-relaxed text-muted-foreground">Connect your app to a dedicated Alpha workspace. Transcripts, AI requests, and workspace settings are handled by the connected backend.</p></div>
                                <Badge className="ml-auto shrink-0" variant={isConnected ? 'success' : 'muted'}>{isConnected ? 'Connected' : 'Offline'}</Badge>
                            </div>
                            <SettingGroup>
                                <SettingRow id="backend-url" label="Backend address" description="Use an HTTPS address for a hosted service, or http://127.0.0.1:48900 for a local backend." stacked>
                                    <Input id="backend-url" type="url" autoCapitalize="none" autoCorrect="off" spellCheck={false} disabled={connectionLocked} value={connectionDraft.url} onChange={event => { setConnectionDraft({ ...connectionDraft, url: event.target.value }); setConnectionState(null); }} placeholder="https://meetings.example.com" />
                                </SettingRow>
                                <SettingRow id="backend-token" label="Access token" description="Provided by your backend administrator. Kept for this app session; enter it again after quitting. Local backends may not require one." stacked>
                                    <Input id="backend-token" type="password" autoComplete="off" autoCapitalize="none" spellCheck={false} disabled={connectionLocked} value={connectionDraft.token} onChange={event => { setConnectionDraft({ ...connectionDraft, token: event.target.value }); setConnectionState(null); }} placeholder="Enter workspace access token" />
                                </SettingRow>
                            </SettingGroup>
                            {connectionLocked && <p className="text-callout text-warning">Finish the current meeting before changing your connection.</p>}
                            <div className="flex flex-wrap items-center gap-3">
                                <Button variant="outline" disabled={connectionLocked || connectionState?.status === 'checking'} onClick={() => handleConnection(false)}>{connectionState?.status === 'checking' && <Loader2 className="size-4 animate-spin" aria-hidden="true" />}Test connection</Button>
                                <Button disabled={connectionLocked || connectionState?.status === 'checking'} onClick={() => handleConnection(true)}>Connect &amp; reload</Button>
                            </div>
                            {connectionState?.message && <p role={connectionState.status === 'error' ? 'alert' : 'status'} className={cn('flex items-start gap-2 text-callout', connectionState.status === 'error' ? 'text-destructive' : 'text-success')}><ShieldCheck className="mt-0.5 size-4 shrink-0" aria-hidden="true" />{connectionState.message}</p>}
                            <p className="text-footnote leading-relaxed text-muted-foreground">Changing the connection reloads Alpha. Hosted mode streams audio securely while video recordings stay on this device. Use a dedicated backend for each private workspace.</p>
                        </TabsContent>

                        <TabsContent value="audio" className="space-y-4">
                            <SettingGroup>
                                <SettingRow
                                    id="mic-device"
                                    label="Microphone"
                                    description="Captured in this window at 16 kHz and streamed to the backend. Everything from it is attributed to you."
                                    stacked
                                >
                                    <Select value={formData.micDeviceId} onValueChange={value => setFormData({ ...formData, micDeviceId: value })}>
                                        <SelectTrigger id="mic-device" className="w-full">
                                            <SelectValue />
                                        </SelectTrigger>
                                        <SelectContent>
                                            <SelectItem value="default">System default microphone</SelectItem>
                                        </SelectContent>
                                    </Select>
                                </SettingRow>

                                <SettingRow
                                    id="system-device"
                                    label="Meeting audio"
                                    description="Other participants are captured with the screen, so they are only transcribed while a recording is running."
                                    stacked
                                >
                                    <Select
                                        value={formData.systemDeviceId}
                                        onValueChange={value => setFormData({ ...formData, systemDeviceId: value })}
                                    >
                                        <SelectTrigger id="system-device" className="w-full">
                                            <SelectValue />
                                        </SelectTrigger>
                                        <SelectContent>
                                            <SelectItem value="default">Native helper (system audio)</SelectItem>
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
                                    id="transcription-provider"
                                    label="Transcription engine"
                                    description="Audio is sent securely to Sarvam for transcription. Live mode works with your local or hosted Alpha backend."
                                    badge={<Badge variant="tinted">{usesSarvamBatch ? 'Cloud processing' : 'Live streaming'}</Badge>}
                                    stacked
                                >
                                    <Select
                                        value={transcriptionProvider}
                                        onValueChange={value =>
                                            setFormData({
                                                ...formData,
                                                transcriptionProvider: value,
                                            })
                                        }
                                    >
                                        <SelectTrigger id="transcription-provider" className="w-full">
                                            <SelectValue />
                                        </SelectTrigger>
                                        <SelectContent>
                                            {TRANSCRIPTION_PROVIDERS.map(provider => (
                                                <SelectItem
                                                    key={provider.value}
                                                    value={provider.value}
                                                    disabled={provider.value === 'sarvam' && (!recordingSupported || !localMediaSupported)}
                                                >
                                                    {provider.label}
                                                </SelectItem>
                                            ))}
                                        </SelectContent>
                                    </Select>
                                </SettingRow>

                                {usesSarvam && (
                                    <>
                                        <SettingRow
                                            id="sarvam-key"
                                            label="Sarvam API key"
                                            description={
                                                usesSarvamBatch
                                                    ? 'Stored privately on your Alpha backend. The completed recording is sent to Sarvam for transcription and speaker separation.'
                                                    : 'Stored privately on your Alpha backend. Audio is sent to Sarvam during the meeting and transcribed as people speak.'
                                            }
                                            badge={
                                                stt?.sarvam?.apiKeySet || formData.sarvamApiKeySet ? (
                                                    <Badge variant="success">
                                                        <Check aria-hidden="true" />
                                                        Saved
                                                    </Badge>
                                                ) : null
                                            }
                                            stacked
                                        >
                                            <Input
                                                id="sarvam-key"
                                                type="password"
                                                autoComplete="off"
                                                className="w-full font-mono"
                                                placeholder={stt?.sarvam?.apiKeySet || formData.sarvamApiKeySet ? 'Saved — type to replace' : 'sk_…'}
                                                value={formData.sarvamApiKey || ''}
                                                onChange={event => setFormData({ ...formData, sarvamApiKey: event.target.value })}
                                            />
                                        </SettingRow>

                                        <SettingRow id="sarvam-language" label="Sarvam language" stacked>
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

                                        <SettingRow id="sarvam-mode" label="Sarvam output" stacked>
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

                                        {!usesSarvamBatch && (
                                            <SettingRow
                                                id="sarvam-diarize-after"
                                                label="Separate speakers after the meeting"
                                                description={localMediaSupported ? "Refines speaker labels using the completed recording. Requires desktop recording on the same machine as the backend." : "Available when the desktop app and backend share local recording storage. Live speaker labels still work with your hosted backend."}
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
                                    </>
                                )}

                                <SettingRow
                                    id="summary-provider"
                                    label="Summary engine"
                                    description="Writes the summary, decisions, action items, and follow-up email when a recording ends."
                                    badge={
                                        summary?.provider ? (
                                            <Badge variant={summary.provider === 'heuristic' ? 'muted' : 'tinted'}>
                                                {summary.provider === 'heuristic' ? 'No AI' : summary.provider}
                                            </Badge>
                                        ) : null
                                    }
                                    stacked
                                >
                                    <Select
                                        value={formData.summaryProvider || 'auto'}
                                        onValueChange={value => setFormData({ ...formData, summaryProvider: value })}
                                    >
                                        <SelectTrigger id="summary-provider" className="w-full">
                                            <SelectValue />
                                        </SelectTrigger>
                                        <SelectContent>
                                            {SUMMARY_PROVIDERS.map(provider => (
                                                <SelectItem key={provider.value} value={provider.value} disabled={remoteBackend && provider.value === 'claude-cli'}>
                                                    {provider.label}
                                                </SelectItem>
                                            ))}
                                        </SelectContent>
                                    </Select>
                                </SettingRow>

                                {summaryModels.length > 0 && (
                                    <SettingRow id="ai-model" label="Summary model" stacked>
                                        <Select value={formData.aiModel} onValueChange={value => setFormData({ ...formData, aiModel: value })}>
                                            <SelectTrigger id="ai-model" className="w-full">
                                                <SelectValue />
                                            </SelectTrigger>
                                            <SelectContent>
                                                {summaryModels.map(model => (
                                                    <SelectItem key={model.value} value={model.value}>
                                                        {model.label}
                                                    </SelectItem>
                                                ))}
                                            </SelectContent>
                                        </Select>
                                    </SettingRow>
                                )}

                                <SettingRow
                                    id="gemini-key"
                                    label="Google Gemini API key"
                                    description="Stored privately on your Alpha backend. Meeting transcripts and chat questions are sent to Google when you use Gemini."
                                    badge={
                                        summary?.geminiKeySet ? (
                                            <Badge variant="success">
                                                <Check aria-hidden="true" />
                                                Saved
                                            </Badge>
                                        ) : null
                                    }
                                    stacked
                                >
                                    <Input
                                        id="gemini-key"
                                        type="password"
                                        autoComplete="off"
                                        className="w-full font-mono"
                                        // The key is never sent back by the backend, so this is always
                                        // blank on open: typing replaces it, leaving it alone keeps it.
                                        placeholder={summary?.geminiKeySet ? 'Saved — type to replace' : 'AIza…'}
                                        value={formData.geminiApiKey || ''}
                                        onChange={event => setFormData({ ...formData, geminiApiKey: event.target.value })}
                                    />
                                </SettingRow>

                                <SettingRow
                                    id="auto-summarize"
                                    label="Summarize when a recording ends"
                                    description={
                                        transcriptionProvider === 'sarvam'
                                            ? 'Runs the selected summary engine after Sarvam returns the diarized batch transcript.'
                                            : 'Creates a summary and action items from your transcript when the meeting ends.'
                                    }
                                >
                                    <Switch
                                        id="auto-summarize"
                                        checked={Boolean(formData.autoSummarize)}
                                        onCheckedChange={checked => setFormData({ ...formData, autoSummarize: checked })}
                                    />
                                </SettingRow>
                            </SettingGroup>

                            <p className="text-footnote leading-relaxed text-muted-foreground">
                                Live transcription uses Sarvam Saaras. Provider keys are stored on the connected backend and are never returned to this screen.
                                {remoteBackend && ' Hosted connections use live audio streaming; recording files stay on this device.'}
                            </p>
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
                                                        : `Connected as ${provider.account || 'your account'}. Alpha reads upcoming events and never writes to your calendar.`
                                                    : provider.configured
                                                      ? provider.provider === 'google'
                                                          ? 'Opens your browser to sign in, then returns to Alpha. Requests permission to view, create, edit, and delete events.'
                                                          : 'Opens your browser to sign in, then returns to Alpha. Read-only access to events.'
                                                      : 'Add an OAuth client id below before connecting.'
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
                                    description="A notification a minute before any scheduled meeting, and a countdown in the menu bar. Clicking the notification starts the recording."
                                >
                                    <Switch
                                        id="meeting-reminders"
                                        checked={formData.meetingReminders !== false}
                                        onCheckedChange={checked => setFormData({ ...formData, meetingReminders: checked })}
                                    />
                                </SettingRow>
                            </SettingGroup>

                            <SettingGroup>
                                <SettingRow
                                    id="google-client-id"
                                    label="Google client id"
                                    description="From a Google Cloud OAuth client of type Desktop app. Stored locally, never sent anywhere but Google."
                                    stacked
                                >
                                    <Input
                                        id="google-client-id"
                                        type="password"
                                        placeholder={formData.googleCalendarClientIdSet ? 'Saved' : '…apps.googleusercontent.com'}
                                        value={formData.googleCalendarClientId || ''}
                                        onChange={event => setFormData({ ...formData, googleCalendarClientId: event.target.value })}
                                    />
                                </SettingRow>
                                <SettingRow
                                    id="google-client-secret"
                                    label="Google client secret"
                                    description="From the same Google Cloud Desktop app client as your client id. Required if Google reports that client_secret is missing. Leave blank to keep the saved value."
                                    stacked
                                >
                                    <Input
                                        id="google-client-secret"
                                        type="password"
                                        autoComplete="new-password"
                                        placeholder={formData.googleCalendarClientSecretSet ? 'Saved — type to replace' : 'Paste the client secret'}
                                        value={formData.googleCalendarClientSecret || ''}
                                        onChange={event => setFormData({ ...formData, googleCalendarClientSecret: event.target.value })}
                                    />
                                </SettingRow>
                                <SettingRow
                                    id="microsoft-client-id"
                                    label="Microsoft client id"
                                    description="The application (client) id from an Entra app registration with a public-client localhost redirect."
                                    stacked
                                >
                                    <Input
                                        id="microsoft-client-id"
                                        type="password"
                                        placeholder={formData.microsoftCalendarClientIdSet ? 'Saved' : 'Application (client) id'}
                                        value={formData.microsoftCalendarClientId || ''}
                                        onChange={event => setFormData({ ...formData, microsoftCalendarClientId: event.target.value })}
                                    />
                                </SettingRow>
                            </SettingGroup>
                        </TabsContent>

                        <TabsContent value="recording" className="space-y-4">
                            {!recordingSupported && (
                                <p className="flex items-start gap-2 rounded-lg border bg-muted px-4 py-4 text-callout text-muted-foreground">
                                    <TriangleAlert className="mt-[2px] size-4 shrink-0" aria-hidden="true" />
                                    Screen recording needs the Alpha desktop window. It is unavailable in a browser tab.
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
                                    id="record-screen"
                                    label="Record the screen"
                                    description={
                                        transcriptionProvider === 'sarvam'
                                            ? 'Required for Sarvam: the recording carries the complete mixed audio that is uploaded after the meeting ends.'
                                            : 'Keeps a video on this device for replay. Audio is sent to your selected transcription provider.'
                                    }
                                >
                                    <Switch
                                        id="record-screen"
                                        disabled={!recordingSupported || transcriptionProvider === 'sarvam'}
                                        checked={Boolean(formData.recordScreen)}
                                        onCheckedChange={checked => setFormData({ ...formData, recordScreen: checked })}
                                    />
                                </SettingRow>

                                <SettingRow
                                    id="recording-source"
                                    label="What to record"
                                    description="Asking each time lets you share one window instead of the whole screen."
                                    stacked
                                >
                                    <Select
                                        value={formData.recordingSource === 'ask' ? 'ask' : 'screen'}
                                        onValueChange={value => setFormData({ ...formData, recordingSource: value === 'ask' ? 'ask' : 'screen' })}
                                    >
                                        <SelectTrigger id="recording-source" className="w-full" disabled={!recordingSupported}>
                                            <SelectValue />
                                        </SelectTrigger>
                                        <SelectContent>
                                            <SelectItem value="ask">Ask me each time</SelectItem>
                                            <SelectItem value="screen">Always the whole screen</SelectItem>
                                        </SelectContent>
                                    </Select>
                                </SettingRow>

                                <SettingRow id="recording-bitrate" label="Video quality" stacked>
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
                                {!recordingSupported ? 'Recordings are available in the desktop app.' : usageBytes === null ? 'Measuring recording storage…' : `Recordings are using ${formatBytes(usageBytes)}.`}
                                {' Deleting a meeting from History deletes its recording too.'}
                            </p>

                            {screenPermission === 'denied' && (
                                <p className="flex items-start gap-1 text-footnote text-warning">
                                    <TriangleAlert className="mt-[1px] size-4 shrink-0" aria-hidden="true" />
                                    macOS is blocking screen recording. Allow Alpha in System Settings › Privacy &amp; Security › Screen Recording,
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
                                            Reported by the backend
                                            {typeof meetingsThisMonth === 'number' ? ` · ${meetingsThisMonth} meetings this month` : ''}
                                        </p>
                                    </div>
                                </div>
                            ) : (
                                <p className="flex items-center gap-2 rounded-lg border bg-muted px-4 py-4 text-callout text-muted-foreground">
                                    <TriangleAlert className="size-4 shrink-0" aria-hidden="true" />
                                    No license information — the backend is not reachable.
                                </p>
                            )}

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
                        </TabsContent>
                    </div>
                </Tabs>

                <DialogFooter className="flex-row items-center justify-between gap-4 p-4 pt-4 hairline-top sm:justify-between">
                    <div className="min-w-0">
                        <p className="truncate text-footnote text-muted-foreground">
                            {backendUrl}
                            {engine?.version ? ` · core ${engine.version}` : ''}
                        </p>
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
                        {!['personal', 'connection'].includes(activeTab) && <Button onClick={handleSave} disabled={!isConnected || saveState?.status === 'saving'}>
                            {saveState?.status === 'saved' && <Check aria-hidden="true" />}
                            {saveState?.status === 'saving' ? 'Saving…' : saveState?.status === 'saved' ? 'Saved' : 'Save changes'}
                        </Button>}
                    </div>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
