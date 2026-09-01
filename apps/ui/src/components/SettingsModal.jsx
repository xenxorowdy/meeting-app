import React, { useEffect, useState } from 'react';
import { Cpu, Check, Award, CircleCheckBig, TriangleAlert } from 'lucide-react';
import { cn } from '@/utils/cn';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { languageName } from '@/lib/speakers';
import { isRecordingSupported } from '@/lib/screenRecorder';

// Whisper language codes, led by the ones this app is actually used in.
const LANGUAGES = [
    { value: 'auto', label: 'Detect automatically' },
    { value: 'en', label: 'English' },
    { value: 'hi', label: 'Hindi' },
    { value: 'mr', label: 'Marathi' },
    { value: 'bn', label: 'Bengali' },
    { value: 'gu', label: 'Gujarati' },
    { value: 'pa', label: 'Punjabi' },
    { value: 'ta', label: 'Tamil' },
    { value: 'te', label: 'Telugu' },
    { value: 'ur', label: 'Urdu' },
    { value: 'es', label: 'Spanish' },
    { value: 'fr', label: 'French' },
    { value: 'de', label: 'German' },
];

// base and tiny are English-first: they render other languages in the wrong
// script, or translate them instead of transcribing.
const ENGLISH_ONLY_MODELS = ['tiny', 'base'];

const TRANSCRIPTION_PROVIDERS = [
    { value: 'whisper', label: 'Whisper — live, on device' },
    { value: 'sarvam', label: 'Sarvam Saaras — batch + speakers' },
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
    { value: 'heuristic', label: 'On device only (no AI)' },
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
}) {
    const [activeTab, setActiveTab] = useState('audio');
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
            setFormData({ ...settings, geminiApiKey: '', sarvamApiKey: '' });
            setSaveState(null);
            setActivation(null);
        }
    }, [isOpen, settings]);

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

    const handleSave = async () => {
        if (!onUpdateSettings) return;
        setSaveState({ status: 'saving' });

        // An untouched key field means "leave it alone". Sending the empty string
        // would clear a key the user never intended to remove.
        const payload = { ...formData };
        if (!payload.geminiApiKey) delete payload.geminiApiKey;
        if (!payload.sarvamApiKey) delete payload.sarvamApiKey;
        delete payload.geminiApiKeySet;
        delete payload.sarvamApiKeySet;

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
    const detectedLanguage = stt?.languageMode === 'auto' ? languageName(stt.detectedLanguage) : null;
    const usableModels = (stt?.availableModels || []).filter(entry => entry.usable);
    const brokenModels = (stt?.availableModels || []).filter(entry => !entry.usable).map(entry => entry.model);
    const language = formData.sttLanguage || 'auto';
    const englishOnlyModel = ENGLISH_ONLY_MODELS.includes(formData.whisperModel);
    const nonEnglishSelected = language !== 'en' && language !== 'auto';
    const transcriptionProvider = formData.transcriptionProvider || 'whisper';

    const tier = license?.tier ? license.tier.charAt(0).toUpperCase() + license.tier.slice(1) : 'Unknown';
    const meetingsThisMonth = license?.usage?.meetingsThisMonth ?? license?.usage?.meetingsCount;

    return (
        <Dialog open={isOpen} onOpenChange={open => !open && onClose()}>
            <DialogContent className="flex max-h-[86vh] flex-col gap-0 p-0 sm:max-w-2xl">
                <DialogHeader className="space-y-1 p-4 pb-4 pr-12 text-left hairline-bottom">
                    <DialogTitle className="text-title2 font-semibold">Settings</DialogTitle>
                    <DialogDescription className="text-callout text-muted-foreground">
                        Choose your audio sources, transcription engine, and license.
                    </DialogDescription>
                </DialogHeader>

                <Tabs value={activeTab} onValueChange={setActiveTab} className="flex min-h-0 flex-1 flex-col">
                    <div className="px-4 pt-4">
                        <TabsList className="w-full">
                            <TabsTrigger value="audio" className="flex-1">
                                Audio
                            </TabsTrigger>
                            <TabsTrigger value="ai" className="flex-1">
                                Transcription
                            </TabsTrigger>
                            <TabsTrigger value="calendar" className="flex-1">
                                Calendar
                            </TabsTrigger>
                            <TabsTrigger value="recording" className="flex-1">
                                Recording
                            </TabsTrigger>
                            <TabsTrigger value="license" className="flex-1">
                                License
                            </TabsTrigger>
                        </TabsList>
                    </div>

                    <div className="min-h-0 flex-1 overflow-y-auto p-4">
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
                                    description="Whisper writes live turns locally. Sarvam processes the complete recording in one batch and separates speakers before summarization."
                                    badge={
                                        transcriptionProvider === 'whisper' ? (
                                            <Badge variant="success">
                                                <Cpu aria-hidden="true" />
                                                On device
                                            </Badge>
                                        ) : (
                                            <Badge variant="tinted">Batch cloud</Badge>
                                        )
                                    }
                                    stacked
                                >
                                    <Select
                                        value={transcriptionProvider}
                                        onValueChange={value =>
                                            setFormData({
                                                ...formData,
                                                transcriptionProvider: value,
                                                ...(value === 'sarvam' ? { recordScreen: true } : {}),
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
                                                    disabled={provider.value === 'sarvam' && !recordingSupported}
                                                >
                                                    {provider.label}
                                                </SelectItem>
                                            ))}
                                        </SelectContent>
                                    </Select>
                                </SettingRow>

                                {transcriptionProvider === 'sarvam' && (
                                    <>
                                        <SettingRow
                                            id="sarvam-key"
                                            label="Sarvam API key"
                                            description="Stored privately on this Mac. The completed meeting recording is uploaded to Sarvam for batch transcription and speaker diarization."
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
                                                <SelectItem key={provider.value} value={provider.value}>
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
                                    description="Stored on this Mac, readable only by your user account. The transcript is sent to Google when a summary is written."
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

                                {transcriptionProvider === 'whisper' && (
                                    <>
                                        <SettingRow
                                            id="whisper-model"
                                            label="Whisper model"
                                            description="Runs on this device. Audio never leaves your Mac for transcription."
                                            badge={
                                                <Badge variant="success">
                                                    <Cpu aria-hidden="true" />
                                                    On device
                                                </Badge>
                                            }
                                            stacked
                                        >
                                            <Select
                                                value={formData.whisperModel}
                                                onValueChange={value => setFormData({ ...formData, whisperModel: value })}
                                            >
                                                <SelectTrigger id="whisper-model" className="w-full">
                                                    <SelectValue />
                                                </SelectTrigger>
                                                <SelectContent>
                                                    {usableModels.length === 0 ? (
                                                        <SelectItem value={formData.whisperModel}>{formData.whisperModel}</SelectItem>
                                                    ) : (
                                                        usableModels.map(entry => (
                                                            <SelectItem key={entry.model} value={entry.alias || entry.model}>
                                                                Whisper {entry.alias || entry.model}
                                                            </SelectItem>
                                                        ))
                                                    )}
                                                </SelectContent>
                                            </Select>
                                        </SettingRow>

                                        <SettingRow
                                            id="stt-language"
                                            label="Spoken language"
                                            description="Whisper decodes with this language. Detection handles a meeting that switches between languages."
                                            stacked
                                        >
                                            <Select
                                                value={formData.sttLanguage || 'auto'}
                                                onValueChange={value => setFormData({ ...formData, sttLanguage: value })}
                                            >
                                                <SelectTrigger id="stt-language" className="w-full">
                                                    <SelectValue />
                                                </SelectTrigger>
                                                <SelectContent>
                                                    {LANGUAGES.map(language => (
                                                        <SelectItem key={language.value} value={language.value}>
                                                            {language.label}
                                                        </SelectItem>
                                                    ))}
                                                </SelectContent>
                                            </Select>
                                        </SettingRow>
                                    </>
                                )}

                                <SettingRow
                                    id="auto-summarize"
                                    label="Summarize when a recording ends"
                                    description={
                                        transcriptionProvider === 'sarvam'
                                            ? 'Runs the selected summary engine after Sarvam returns the diarized batch transcript.'
                                            : 'Sends the transcript to the summary model. Turn this off to keep everything on device.'
                                    }
                                >
                                    <Switch
                                        id="auto-summarize"
                                        checked={Boolean(formData.autoSummarize)}
                                        onCheckedChange={checked => setFormData({ ...formData, autoSummarize: checked })}
                                    />
                                </SettingRow>
                            </SettingGroup>

                            {stt && (
                                <div className="space-y-2 text-footnote">
                                    <p className="text-muted-foreground">
                                        Engine:{' '}
                                        {transcriptionProvider === 'sarvam'
                                            ? `Sarvam ${stt.sarvam?.model || 'saaras:v3'} · batch with speaker diarization`
                                            : stt.engine === 'unavailable'
                                              ? 'Whisper is not installed'
                                              : `${stt.engine} · ${stt.status}`}
                                        {transcriptionProvider === 'whisper' &&
                                            stt.status === 'starting' &&
                                            ' — a large model can take a few minutes to compile the first time'}
                                        {transcriptionProvider === 'whisper' && detectedLanguage && ` · detected ${detectedLanguage} so far`}
                                    </p>

                                    {transcriptionProvider === 'whisper' && stt.scriptDriftTurns > 0 && (
                                        <p className="flex items-start gap-1 text-warning">
                                            <TriangleAlert className="mt-[1px] size-4 shrink-0" aria-hidden="true" />
                                            {stt.scriptDriftTurns} {stt.scriptDriftTurns === 1 ? 'line was' : 'lines were'} written in Arabic script
                                            instead of Devanagari. Whisper does this to Hindi occasionally; picking Hindi above instead of detection
                                            avoids it, at the cost of transcribing English badly.
                                        </p>
                                    )}

                                    {transcriptionProvider === 'whisper' && englishOnlyModel && nonEnglishSelected && (
                                        <p className="flex items-start gap-1 text-warning">
                                            <TriangleAlert className="mt-[1px] size-4 shrink-0" aria-hidden="true" />
                                            Whisper {formData.whisperModel} is English-first and will render this language in the wrong script, or
                                            translate it. Choose small or larger for accurate non-English transcription.
                                        </p>
                                    )}

                                    {transcriptionProvider === 'whisper' && brokenModels.length > 0 && (
                                        <p className="text-muted-foreground">
                                            Incomplete on this machine, so not offered: {brokenModels.join(', ')}. Re-download to use them.
                                        </p>
                                    )}
                                </div>
                            )}
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
                                                    ? `Connected as ${provider.account || 'your account'}. Alpha reads upcoming events and never writes to your calendar.`
                                                    : provider.configured
                                                      ? 'Opens your browser to sign in, then returns to Alpha. Read-only access to events.'
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
                                    description="A notification a minute before any scheduled meeting with two or more people invited. Clicking it starts the recording."
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
                                    description="A small always-on-top pill showing whether Alpha is recording. Click it to read the live transcript without leaving your call."
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
                                            : 'Saves a video of each meeting on this Mac so you can replay it with the transcript. Nothing is uploaded.'
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
                                {usageBytes === null ? 'Measuring what recordings are using…' : `Recordings are using ${formatBytes(usageBytes)}.`}
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
                            Cancel
                        </Button>
                        <Button onClick={handleSave} disabled={!isConnected || saveState?.status === 'saving'}>
                            {saveState?.status === 'saved' && <Check aria-hidden="true" />}
                            {saveState?.status === 'saving' ? 'Saving' : saveState?.status === 'saved' ? 'Saved' : 'Save'}
                        </Button>
                    </div>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
