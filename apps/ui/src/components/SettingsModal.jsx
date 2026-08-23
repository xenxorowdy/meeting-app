import React, { useEffect, useState } from 'react';
import { Mic, Cpu, Key, Check, Sparkles, Award, CircleCheckBig, TriangleAlert } from 'lucide-react';
import { cn } from '@/utils/cn';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

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

function SettingGroup({ children }) {
    return <div className="divide-y divide-border overflow-hidden rounded-lg border bg-muted">{children}</div>;
}

function SettingRow({ id, label, description, badge, children, stacked = false }) {
    return (
        <div className={cn('gap-3 px-3 py-3', stacked ? 'flex flex-col' : 'flex items-center justify-between')}>
            <div className="min-w-0 space-y-0.5">
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

export function SettingsModal({ isOpen, onClose, settings, license, engine, backendUrl, isConnected = false, onUpdateSettings, onActivateLicense }) {
    const [activeTab, setActiveTab] = useState('audio');
    const [formData, setFormData] = useState(settings);
    const [licenseKey, setLicenseKey] = useState('');
    const [activation, setActivation] = useState(null);
    const [saveState, setSaveState] = useState(null);

    // Adopt whatever the backend reported the last time the sheet was opened.
    useEffect(() => {
        if (isOpen) {
            setFormData(settings);
            setSaveState(null);
            setActivation(null);
        }
    }, [isOpen, settings]);

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
        const result = await onUpdateSettings(formData);

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
    const usableModels = (stt?.availableModels || []).filter(entry => entry.usable);
    const brokenModels = (stt?.availableModels || []).filter(entry => !entry.usable).map(entry => entry.model);
    const language = formData.sttLanguage || 'auto';
    const englishOnlyModel = ENGLISH_ONLY_MODELS.includes(formData.whisperModel);
    const nonEnglishSelected = language !== 'en' && language !== 'auto';

    const tier = license?.tier ? license.tier.charAt(0).toUpperCase() + license.tier.slice(1) : 'Unknown';
    const meetingsThisMonth = license?.usage?.meetingsThisMonth ?? license?.usage?.meetingsCount;

    return (
        <Dialog open={isOpen} onOpenChange={open => !open && onClose()}>
            <DialogContent className="flex max-h-[86vh] flex-col gap-0 p-0 sm:max-w-2xl">
                <DialogHeader className="space-y-1 p-5 pb-4 pr-12 text-left hairline-bottom">
                    <DialogTitle className="text-title2 font-semibold">Settings</DialogTitle>
                    <DialogDescription className="text-callout text-muted-foreground">
                        Choose your audio sources, transcription engine, and license.
                    </DialogDescription>
                </DialogHeader>

                <Tabs value={activeTab} onValueChange={setActiveTab} className="flex min-h-0 flex-1 flex-col">
                    <div className="px-5 pt-4">
                        <TabsList className="w-full">
                            <TabsTrigger value="audio" className="flex-1">
                                <Mic aria-hidden="true" />
                                Audio
                            </TabsTrigger>
                            <TabsTrigger value="ai" className="flex-1">
                                <Sparkles aria-hidden="true" />
                                Transcription
                            </TabsTrigger>
                            <TabsTrigger value="license" className="flex-1">
                                <Key aria-hidden="true" />
                                License
                            </TabsTrigger>
                        </TabsList>
                    </div>

                    <div className="min-h-0 flex-1 overflow-y-auto p-5">
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
                                    description="Other participants are captured by the platform's native helper, not by this window."
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
                                    id="ai-model"
                                    label="Summary model"
                                    description="Writes the summary, decisions, action items, and follow-up email when a recording ends."
                                    stacked
                                >
                                    <Select value={formData.aiModel} onValueChange={value => setFormData({ ...formData, aiModel: value })}>
                                        <SelectTrigger id="ai-model" className="w-full">
                                            <SelectValue />
                                        </SelectTrigger>
                                        <SelectContent>
                                            <SelectItem value="claude-3-5-sonnet">Claude 3.5 Sonnet</SelectItem>
                                            <SelectItem value="gpt-4o">GPT-4o</SelectItem>
                                            <SelectItem value="ollama-llama3">Llama 3, on this device</SelectItem>
                                        </SelectContent>
                                    </Select>
                                </SettingRow>

                                <SettingRow
                                    id="whisper-model"
                                    label="Transcription model"
                                    description="Runs on this device. Audio never leaves your Mac for transcription."
                                    badge={
                                        <Badge variant="success">
                                            <Cpu aria-hidden="true" />
                                            On device
                                        </Badge>
                                    }
                                    stacked
                                >
                                    <Select value={formData.whisperModel} onValueChange={value => setFormData({ ...formData, whisperModel: value })}>
                                        <SelectTrigger id="whisper-model" className="w-full">
                                            <SelectValue />
                                        </SelectTrigger>
                                        <SelectContent>
                                            {usableModels.length === 0 ? (
                                                <SelectItem value={formData.whisperModel}>{formData.whisperModel}</SelectItem>
                                            ) : (
                                                usableModels.map(entry => (
                                                    <SelectItem key={entry.model} value={entry.model}>
                                                        Whisper {entry.model}
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

                                <SettingRow
                                    id="auto-summarize"
                                    label="Summarize when a recording ends"
                                    description="Sends the transcript to the summary model. Turn this off to keep everything on device."
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
                                        Engine: {stt.engine === 'unavailable' ? 'not installed' : `${stt.engine} · ${stt.status}`}
                                        {stt.status === 'starting' && ' — a large model can take a few minutes to compile the first time'}
                                    </p>

                                    {englishOnlyModel && nonEnglishSelected && (
                                        <p className="flex items-start gap-1.5 text-warning">
                                            <TriangleAlert className="mt-[1px] size-3.5 shrink-0" aria-hidden="true" />
                                            Whisper {formData.whisperModel} is English-first and will render this language in the wrong script, or
                                            translate it. Choose small or larger for accurate non-English transcription.
                                        </p>
                                    )}

                                    {brokenModels.length > 0 && (
                                        <p className="text-muted-foreground">
                                            Incomplete on this machine, so not offered: {brokenModels.join(', ')}. Re-download to use them.
                                        </p>
                                    )}
                                </div>
                            )}
                        </TabsContent>

                        <TabsContent value="license" className="space-y-4">
                            {license ? (
                                <div className="flex items-center gap-3 rounded-lg border bg-muted px-3 py-3">
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
                                <p className="flex items-center gap-2 rounded-lg border bg-muted px-3 py-3 text-callout text-muted-foreground">
                                    <TriangleAlert className="size-3.5 shrink-0" aria-hidden="true" />
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
                                    <p className="flex items-center gap-1.5 text-footnote text-success" role="status">
                                        <CircleCheckBig className="size-3.5" aria-hidden="true" />
                                        {activation.message}
                                    </p>
                                )}
                                {activation?.status === 'invalid' && (
                                    <p className="flex items-start gap-1.5 text-footnote text-destructive" role="alert">
                                        <TriangleAlert className="mt-[1px] size-3.5 shrink-0" aria-hidden="true" />
                                        {activation.message}
                                    </p>
                                )}
                            </form>
                        </TabsContent>
                    </div>
                </Tabs>

                <DialogFooter className="flex-row items-center justify-between gap-3 p-5 pt-4 hairline-top sm:justify-between">
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
