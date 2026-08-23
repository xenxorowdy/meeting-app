import React, { useEffect, useState } from 'react';
import { Monitor, AppWindow, TriangleAlert } from 'lucide-react';
import { cn } from '@/utils/cn';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { listSources } from '@/lib/screenRecorder';

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

    useEffect(() => {
        if (!isOpen) return undefined;

        let cancelled = false;
        setIsLoading(true);
        setError(null);

        listSources()
            .then(found => {
                if (cancelled) return;
                setSources(found);
                // Default to a whole screen: it is what most people mean by
                // "record the meeting", and it survives them switching apps.
                setSelectedId(found.find(source => source.kind === 'screen')?.id || found[0]?.id || null);
            })
            .catch(cause => !cancelled && setError(cause.message || 'Could not list what can be recorded.'))
            .finally(() => !cancelled && setIsLoading(false));

        return () => {
            cancelled = true;
        };
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
                    <DialogTitle className="text-title2 font-semibold">What should Alpha record?</DialogTitle>
                    <DialogDescription className="text-callout text-muted-foreground">
                        {batchUpload
                            ? 'The recording is saved on this Mac, then its mixed audio is uploaded to Sarvam after the meeting ends.'
                            : 'The recording is saved on this Mac and never uploaded.'}
                    </DialogDescription>
                </DialogHeader>

                <div className="min-h-0 flex-1 overflow-y-auto p-4">
                    {error ? (
                        <p className="flex items-start gap-2 rounded-lg border bg-muted px-4 py-4 text-callout text-warning">
                            <TriangleAlert className="mt-[2px] size-4 shrink-0" aria-hidden="true" />
                            {error}
                        </p>
                    ) : isLoading ? (
                        <p className="p-4 text-callout text-muted-foreground">Looking for screens and windows…</p>
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
                    <Button onClick={() => onConfirm(selectedId)} disabled={!selectedId}>
                        Start recording
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
