import React, { useEffect, useRef, useState } from 'react';
import { Monitor, AppWindow, TriangleAlert, Mic, Check } from 'lucide-react';
import { cn } from '@/utils/cn';
import { LogoMark } from '@/components/brand/Logo';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { listSources, screenPermission } from '@/lib/screenRecorder';

/**
 * Choose what to record. Shown in the app rather than using Chromium's own picker,
 * so the choice can be remembered and the rest of the start flow stays in one
 * window.
 */
export function SourcePicker({ isOpen, onClose, onConfirm, batchUpload = false }) {
    const [sources, setSources] = useState([]);
    const [selectedId, setSelectedId] = useState(null);
    const [mode, setMode] = useState('audio');
    const [tab, setTab] = useState('screens');
    const [error, setError] = useState(null);
    const [isLoading, setIsLoading] = useState(false);
    const [screenAccess, setScreenAccess] = useState(null);
    const requestRef = useRef(0);

    const refreshSources = async (requestPermission = false) => {
        const request = ++requestRef.current;
        setIsLoading(true);
        setError(null);
        try {
            const access = await screenPermission();
            if (request !== requestRef.current) return;
            setScreenAccess(access);
            // Electron can keep reporting the status of an earlier ad hoc build
            // after macOS accepts the installed app. A deliberate retry must
            // ask the capture API itself rather than stop at this status check.
            if ((access === 'denied' || access === 'restricted' || access === 'not-determined') && !requestPermission) return;

            const found = await listSources();
            if (request !== requestRef.current) return;
            setSources(found);
            setSelectedId(found.find(source => source.kind === 'screen')?.id || found[0]?.id || null);
            if (found.length) setScreenAccess('granted');
        } catch (cause) {
            if (request !== requestRef.current) return;
            setError(cause.message || 'Could not list screens and windows.');
        } finally {
            if (request === requestRef.current) setIsLoading(false);
        }
    };

    useEffect(() => {
        if (!isOpen) return undefined;
        setSources([]);
        setSelectedId(null);
        setMode('audio');
        setTab('screens');
        setScreenAccess(null);
        void refreshSources();
        return () => { requestRef.current += 1; };
    }, [isOpen]);

    const screens = sources.filter(source => source.kind === 'screen');
    const windows = sources.filter(source => source.kind === 'window');
    const isAudio = mode === 'audio';
    const isScreen = mode === 'screen';

    const chooseSource = id => {
        setMode('screen');
        setSelectedId(id);
    };

    const renderScreens = () =>
        screens.length === 0 ? (
            <p className="py-2 text-callout text-muted-foreground">Nothing here can be recorded.</p>
        ) : (
            <div className="flex flex-wrap gap-2">
                {screens.map(source => (
                    <button
                        key={source.id}
                        type="button"
                        onClick={() => chooseSource(source.id)}
                        aria-pressed={selectedId === source.id}
                        className={cn(
                            'relative w-40 overflow-hidden rounded-xl border-[1.5px] bg-black transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                            selectedId === source.id ? 'border-foreground/40' : 'border-foreground/[0.08] hover:border-foreground/20'
                        )}
                    >
                        {source.thumbnail ? (
                            <img src={source.thumbnail} alt="" className="block aspect-video w-full object-cover opacity-65" />
                        ) : (
                            <span className="flex aspect-video w-full items-center justify-center bg-muted text-muted-foreground">
                                <Monitor className="size-5" aria-hidden="true" />
                            </span>
                        )}
                        <span className="absolute inset-x-0 bottom-0 truncate bg-gradient-to-t from-black/85 to-transparent px-2.5 py-2 text-left text-caption font-medium text-white">
                            {source.name}
                        </span>
                    </button>
                ))}
            </div>
        );

    const renderWindows = () =>
        windows.length === 0 ? (
            <p className="py-2 text-callout text-muted-foreground">Nothing here can be recorded.</p>
        ) : (
            <div className="flex max-h-36 flex-col gap-1.5 overflow-y-auto">
                {windows.map(source => (
                    <button
                        key={source.id}
                        type="button"
                        onClick={() => chooseSource(source.id)}
                        aria-pressed={selectedId === source.id}
                        className={cn(
                            'flex items-center gap-3 rounded-xl border px-3 py-2.5 text-left transition-colors duration-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                            selectedId === source.id
                                ? 'border-foreground/[0.12] bg-foreground/[0.07] text-foreground'
                                : 'border-transparent bg-foreground/[0.02] text-muted-foreground hover:bg-foreground/[0.05]'
                        )}
                    >
                        <span className={cn('size-2 shrink-0 rounded-full', selectedId === source.id ? 'bg-primary' : 'bg-muted-foreground/50')} />
                        <span className="truncate text-footnote">{source.name}</span>
                    </button>
                ))}
            </div>
        );

    const renderScreenPanel = () =>
        isLoading ? (
            <p className="text-callout text-muted-foreground">Looking for screens and windows…</p>
        ) : screenAccess === 'not-determined' && !error ? (
            <div className="space-y-3 rounded-xl border bg-muted p-4">
                <p className="text-callout text-muted-foreground">To record your screen, allow Kesami to access screens and windows when macOS asks. Recording your voice also needs separate Microphone access.</p>
                <Button variant="outline" onClick={() => void refreshSources(true)}>Choose a screen or window</Button>
            </div>
        ) : screenAccess === 'denied' || screenAccess === 'restricted' || error ? (
            <div className="space-y-3 rounded-xl border bg-muted p-4 text-callout">
                <p className="flex items-start gap-2 text-warning">
                    <TriangleAlert className="mt-[2px] size-4 shrink-0" aria-hidden="true" />
                    {screenAccess === 'denied' || screenAccess === 'restricted'
                        ? 'Allow Kesami in System Settings › Privacy & Security › Screen & System Audio Recording, then restart Kesami.'
                        : 'Screens are unavailable. If you just granted access, restart Kesami and try again.'}
                </p>
                <Button variant="outline" onClick={() => void refreshSources(true)}>Try again</Button>
            </div>
        ) : (
            <Tabs value={tab} onValueChange={setTab}>
                <TabsList className="mb-4 h-auto justify-start gap-1 bg-transparent p-0">
                    {[
                        { value: 'screens', label: `Screens (${screens.length})`, Icon: Monitor },
                        { value: 'windows', label: `Windows (${windows.length})`, Icon: AppWindow },
                    ].map(({ value, label, Icon }) => (
                        <TabsTrigger
                            key={value}
                            value={value}
                            className="h-auto gap-2 rounded-xl border border-transparent px-3.5 py-2 text-footnote font-medium data-[state=active]:border-foreground/[0.12] data-[state=active]:bg-foreground/10 data-[state=active]:font-medium data-[state=active]:shadow-none"
                        >
                            <Icon aria-hidden="true" />
                            {label}
                        </TabsTrigger>
                    ))}
                </TabsList>
                <TabsContent value="screens">{renderScreens()}</TabsContent>
                <TabsContent value="windows">{renderWindows()}</TabsContent>
            </Tabs>
        );

    return (
        <Dialog open={isOpen} onOpenChange={open => !open && onClose()}>
            <DialogContent className="flex max-h-[85vh] flex-col gap-0 p-0 sm:max-w-[520px] sm:rounded-[20px]">
                <DialogHeader className="space-y-3.5 px-8 pb-7 pt-8 pr-14 text-left">
                    <div className="flex items-center gap-3.5">
                        <LogoMark size={36} className="shrink-0" />
                        <div>
                            <p className="text-caption font-medium uppercase tracking-[0.08em] text-muted-foreground">Kesami</p>
                            <DialogTitle className="text-[18px] font-semibold leading-tight tracking-[-0.3px]">What should Kesami record?</DialogTitle>
                        </div>
                    </div>
                    {/* <DialogDescription className="pl-[52px] text-callout leading-[1.55] text-muted-foreground">
                        {batchUpload
                            ? 'The recording is saved on this Mac, then its mixed audio is uploaded to Sarvam after the meeting ends.'
                            : "The recording stays on this Mac — it's never uploaded. Live transcription streams audio as you record."}
                    </DialogDescription>*/}
                </DialogHeader>

                <div className="mx-8 h-px shrink-0 bg-border" />

                <div role="radiogroup" aria-label="What to record" className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-8 py-6">
                    <button
                        type="button"
                        role="radio"
                        aria-checked={isAudio}
                        onClick={() => setMode('audio')}
                        className={cn(
                            'flex w-full items-center gap-4 rounded-2xl border px-5 py-4 text-left transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                            isAudio
                                ? 'border-primary/40 bg-gradient-to-br from-primary/[0.14] to-primary/[0.06] shadow-[0_0_24px_hsl(var(--primary)/0.08)]'
                                : 'border-border bg-foreground/[0.025] hover:bg-foreground/[0.04]'
                        )}
                    >
                        <span
                            className={cn(
                                'flex size-11 shrink-0 items-center justify-center rounded-2xl transition-transform duration-200',
                                isAudio
                                    ? 'scale-105 bg-primary text-primary-foreground shadow-[0_6px_16px_hsl(var(--primary)/0.45)]'
                                    : 'bg-foreground/[0.06] text-muted-foreground'
                            )}
                        >
                            <Mic className={cn("size-5", isAudio? 'text-white':'')} aria-hidden="true" />
                        </span>
                        <span className="min-w-0 flex-1">
                            <span className={cn('block text-[14.5px] font-semibold tracking-[-0.1px]', isAudio ? 'text-foreground' : 'text-muted-foreground')}>Sound only</span>
                            <span className="mt-0.5 block text-footnote leading-relaxed text-muted-foreground">Audio only — no screen capture required</span>
                        </span>
                        {isAudio && (
                            <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground">
                                <Check className="size-3" strokeWidth={2.5} aria-hidden="true" />
                            </span>
                        )}
                    </button>

                    <div
                        className={cn(
                            'overflow-hidden rounded-2xl border transition-colors duration-200',
                            isScreen ? 'border-foreground/[0.12] bg-foreground/[0.03]' : 'border-border bg-foreground/[0.018]'
                        )}
                    >
                        <button
                            type="button"
                            role="radio"
                            aria-checked={isScreen}
                            onClick={() => {
                                setMode('screen');
                                setTab('screens');
                            }}
                            className="flex w-full items-center gap-4 px-5 py-4 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                        >
                            <span
                                  className={cn(
                                    'flex size-11 shrink-0 items-center justify-center rounded-2xl transition-transform duration-200',
                                    isScreen
                                        ? 'scale-105 bg-primary text-primary-foreground shadow-[0_6px_16px_hsl(var(--primary)/0.45)]'
                                        : 'bg-foreground/[0.06] text-muted-foreground'
                                )}
                            >
                                <Monitor className={cn("size-5", isScreen?'text-white' :"")} aria-hidden="true" />
                            </span>
                            <span className="min-w-0 flex-1">
                                <span className={cn('block text-[14.5px] font-semibold tracking-[-0.1px]', isScreen ? 'text-foreground' : 'text-muted-foreground')}>
                                    Screen + sound
                                </span>
                                <span className="mt-0.5 block text-footnote text-muted-foreground">Capture your screen alongside audio</span>
                            </span>
                            {isScreen && (
                                <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-foreground/15 text-foreground">
                                    <Check className="size-3" strokeWidth={2.5} aria-hidden="true" />
                                </span>
                            )}
                        </button>

                        <div
                            inert={!isScreen}
                            className={cn(
                                'grid transition-[grid-template-rows,opacity] duration-300',
                                isScreen ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'
                            )}
                        >
                            <div className="min-h-0 overflow-hidden">
                                <div className="border-t border-foreground/[0.06] px-5 pb-5 pt-4">{renderScreenPanel()}</div>
                            </div>
                        </div>
                    </div>
                </div>

                <DialogFooter className="flex-row items-center justify-end gap-2 px-8 py-5 hairline-top sm:justify-end">
                    <div className="flex items-center gap-2">
                        <Button variant="ghost" onClick={onClose}>
                            Cancel
                        </Button>
                        <Button
                            onClick={() => (isAudio ? onConfirm(null, 'audio') : onConfirm(selectedId, 'screen'))}
                            disabled={isScreen && !selectedId}
                            className="rounded-xl font-semibold shadow-[0_4px_16px_hsl(var(--primary)/0.4)] transition-[background-color,box-shadow,transform] hover:-translate-y-px hover:shadow-[0_6px_20px_hsl(var(--primary)/0.55)]"
                        >
                            {isAudio ? 'Start recording' : 'Record screen'}
                        </Button>
                    </div>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
