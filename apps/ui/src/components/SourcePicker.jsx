import React, { useEffect, useRef, useState } from 'react';
import { Monitor, AppWindow, TriangleAlert, Mic } from 'lucide-react';
import { cn } from '@/utils/cn';
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
        setScreenAccess(null);
        void refreshSources();
        return () => { requestRef.current += 1; };
    }, [isOpen]);

    const screens = sources.filter(source => source.kind === 'screen');
    const windows = sources.filter(source => source.kind === 'window');

    const renderGrid = items =>
        items.length === 0 ? (
            <p className="p-4 text-callout text-muted-foreground">Nothing here can be recorded.</p>
        ) : (
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                {items.map(source => (
                    <button
                        key={source.id}
                        type="button"
                        onClick={() => setSelectedId(source.id)}
                        aria-pressed={selectedId === source.id}
                        className={cn(
                            'flex flex-col gap-1 rounded-lg border p-1 text-left transition-colors',
                            selectedId === source.id ? 'border-primary bg-primary/[0.1]' : 'hover:bg-muted'
                        )}
                    >
                        {source.thumbnail ? (
                            <img src={source.thumbnail} alt="" className="aspect-video w-full rounded object-cover" />
                        ) : (
                            <span className="flex aspect-video w-full items-center justify-center rounded bg-muted">
                                {source.kind === 'screen' ? <Monitor className="size-4" /> : <AppWindow className="size-4" />}
                            </span>
                        )}
                        <span className="truncate text-footnote">{source.name}</span>
                    </button>
                ))}
            </div>
        );

    return (
        <Dialog open={isOpen} onOpenChange={open => !open && onClose()}>
            <DialogContent className="flex max-h-[80vh] flex-col gap-0 p-0 sm:max-w-2xl">
                <DialogHeader className="space-y-1 p-4 pb-4 pr-12 text-left hairline-bottom">
                    <DialogTitle className="text-title2 font-semibold">What should Kesami record?</DialogTitle>
                    <DialogDescription className="text-callout text-muted-foreground">
                        {batchUpload
                            ? 'The recording is saved on this Mac, then its mixed audio is uploaded to Sarvam after the meeting ends.'
                            : 'The recording is saved on this Mac and never uploaded.'}
                    </DialogDescription>
                </DialogHeader>

                <div className="min-h-0 flex-1 overflow-y-auto p-4">
                    <button
                        type="button"
                        onClick={() => onConfirm(null, 'audio')}
                        className="mb-4 flex w-full items-center gap-3 rounded-xl border bg-primary/[0.06] p-4 text-left transition-colors hover:bg-primary/[0.11] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                        <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground">
                            <Mic className="size-5" aria-hidden="true" />
                        </span>
                        <span className="min-w-0 flex-1">
                            <span className="block text-headline font-semibold">Sound only</span>
                            <span className="block text-callout text-muted-foreground">Record your microphone without sharing or capturing your screen.</span>
                        </span>
                    </button>

                    <div className="mb-3 flex items-center gap-3 text-footnote text-muted-foreground">
                        <span className="h-px flex-1 bg-border" />
                        Or record a screen with sound
                        <span className="h-px flex-1 bg-border" />
                    </div>
                    {isLoading ? (
                        <p className="p-4 text-callout text-muted-foreground">Looking for screens and windows…</p>
                    ) : screenAccess === 'not-determined' && !error ? (
                        <div className="space-y-3 rounded-lg border bg-muted p-4">
                            <p className="text-callout text-muted-foreground">To record your screen, allow Kesami to access screens and windows when macOS asks. Recording your voice also needs separate Microphone access.</p>
                            <Button variant="outline" onClick={() => void refreshSources(true)}>Choose a screen or window</Button>
                        </div>
                    ) : screenAccess === 'denied' || screenAccess === 'restricted' || error ? (
                        <div className="space-y-3 rounded-lg border bg-muted p-4 text-callout">
                            <p className="flex items-start gap-2 text-warning">
                                <TriangleAlert className="mt-[2px] size-4 shrink-0" aria-hidden="true" />
                                {screenAccess === 'denied' || screenAccess === 'restricted'
                                    ? 'Allow Kesami in System Settings › Privacy & Security › Screen & System Audio Recording, then restart Kesami.'
                                    : 'Screens are unavailable. If you just granted access, restart Kesami and try again.'}
                            </p>
                            <Button variant="outline" onClick={() => void refreshSources(true)}>Try again</Button>
                        </div>
                    ) : (
                        <Tabs defaultValue="screens">
                            <TabsList className="mb-4 w-full">
                                <TabsTrigger value="screens" className="flex-1">
                                    <Monitor aria-hidden="true" />
                                    Screens ({screens.length})
                                </TabsTrigger>
                                <TabsTrigger value="windows" className="flex-1">
                                    <AppWindow aria-hidden="true" />
                                    Windows ({windows.length})
                                </TabsTrigger>
                            </TabsList>
                            <TabsContent value="screens">{renderGrid(screens)}</TabsContent>
                            <TabsContent value="windows">{renderGrid(windows)}</TabsContent>
                        </Tabs>
                    )}
                </div>

                <DialogFooter className="flex-row justify-end gap-2 p-4 pt-4 hairline-top">
                    <Button variant="ghost" onClick={onClose}>
                        Cancel
                    </Button>
                    <Button onClick={() => onConfirm(selectedId, 'screen')} disabled={!selectedId}>
                        Screen + sound
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
