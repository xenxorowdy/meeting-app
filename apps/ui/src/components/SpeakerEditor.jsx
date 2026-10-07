import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Star, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { SegmentedControl, SegmentedItem } from '@/components/ui/segmented-control';
import { isGenericSpeaker, suggestionReason } from '@/lib/speakers';

export function SpeakerEditor({ turn, lineCount = 1, canRenameAll, canChangeLine, suggest, onRenameAll, onChangeLine, onDone, onCancel }) {
    const [scope, setScope] = useState(canRenameAll && (!canChangeLine || isGenericSpeaker(turn.speaker)) ? 'all' : 'line');
    const [name, setName] = useState('');
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState('');
    const panelRef = useRef(null);
    const single = scope === 'line';
    useEffect(() => {
        panelRef.current?.scrollIntoView?.({ block: 'nearest' });
    }, []);
    const suggestions = useMemo(
        () => (suggest ? suggest(single ? { turnId: turn.id } : { speaker: turn.speaker }) : []),
        [suggest, single, turn.id, turn.speaker]
    );

    const apply = async value => {
        const next = String(value || '').trim();
        if (!next) {
            setError('Enter a name.');
            return;
        }
        if (next === turn.speaker) {
            onCancel();
            return;
        }
        setSaving(true);
        setError('');
        const result = single ? await onChangeLine(next) : await onRenameAll(next);
        setSaving(false);
        if (result?.ok) onDone({ scope, name: next, from: turn.speaker, count: single ? 1 : lineCount });
        else setError(result?.message || 'Could not change the speaker.');
    };

    return (
        <div
            ref={panelRef}
            className="ks-speaker-editor mt-2 rounded-xl border border-border bg-background p-3 shadow-sm"
            role="group"
            aria-label="Change who said this"
            onKeyDown={event => {
                if (event.key === 'Escape') {
                    event.stopPropagation();
                    onCancel();
                }
            }}
        >
            <div className="flex items-center gap-2">
                <p className="text-callout font-semibold">Who said this?</p>
                <Button type="button" variant="ghost" size="iconXs" className="ml-auto" aria-label="Close speaker editor" onClick={onCancel}>
                    <X aria-hidden="true" />
                </Button>
            </div>
            {canRenameAll && canChangeLine && (
                <SegmentedControl className="mt-2 w-full" value={scope} onValueChange={setScope} aria-label="Lines to change">
                    <SegmentedItem value="all">{lineCount === 1 ? 'Every line' : `All ${lineCount} lines`}</SegmentedItem>
                    <SegmentedItem value="line">Just this line</SegmentedItem>
                </SegmentedControl>
            )}
            <p className="mt-2 text-footnote text-muted-foreground">
                {single ? 'Only this line changes.' : `Renames ${turn.speaker} everywhere in this meeting, tasks included.`}
            </p>
            <form
                className="mt-2 flex items-center gap-2"
                onSubmit={event => {
                    event.preventDefault();
                    apply(name);
                }}
            >
                <Input
                    autoFocus
                    value={name}
                    onChange={event => setName(event.target.value)}
                    maxLength={80}
                    placeholder="Type a name"
                    aria-label="Speaker name"
                    className="h-8 min-w-0 flex-1"
                />
                <Button type="submit" size="sm" disabled={saving || !name.trim()}>
                    {saving ? 'Saving…' : 'Save'}
                </Button>
            </form>
            {suggestions.length > 0 && (
                <div className="mt-3">
                    <p className="text-footnote font-medium text-muted-foreground">Suggestions</p>
                    <ul className="mt-1 flex flex-wrap gap-2" aria-label="Suggested speakers">
                        {suggestions.map(suggestion => (
                            <li key={suggestion.name}>
                                <button
                                    type="button"
                                    disabled={saving}
                                    onClick={() => apply(suggestion.name)}
                                    className="ks-speaker-suggestion flex max-w-full flex-col items-start rounded-lg border border-border px-2 py-1 text-left transition-colors hover:border-primary hover:bg-primary/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60 data-[recommended=true]:border-primary/60"
                                    data-recommended={suggestion.recommended ? 'true' : undefined}
                                >
                                    <span className="flex items-center gap-1 text-callout font-medium">
                                        {suggestion.recommended && <Star className="size-3.5 text-primary" aria-hidden="true" />}
                                        {suggestion.name}
                                    </span>
                                    <span className="text-footnote text-muted-foreground">
                                        {suggestion.recommended ? 'Recommended · ' : ''}
                                        {suggestionReason(suggestion, single)}
                                    </span>
                                </button>
                            </li>
                        ))}
                    </ul>
                </div>
            )}
            {error && (
                <p className="mt-2 text-footnote text-destructive" role="alert">
                    {error}
                </p>
            )}
        </div>
    );
}
