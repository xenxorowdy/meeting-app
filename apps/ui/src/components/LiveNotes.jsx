import React, { useEffect, useRef, useState } from 'react';
import { Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { formatMs } from '@/lib/speakers';

export function LiveNotes({ notes = [], canWrite = false, hint, onAddNote, onDeleteNote }) {
    const [draft, setDraft] = useState('');
    const [pending, setPending] = useState(false);
    const [error, setError] = useState(null);
    const listRef = useRef(null);

    useEffect(() => {
        if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
    }, [notes.length]);

    const submit = async () => {
        const text = draft.trim();
        if (!text || pending) return;
        setPending(true);
        setError(null);
        const result = await onAddNote(text);
        setPending(false);
        if (result?.ok === false) {
            setError(result.message || 'That note could not be saved.');
            return;
        }
        setDraft('');
    };

    const handleKeyDown = event => {
        if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            submit();
        }
    };

    return (
        <section aria-label="Your notes" className="flex h-full flex-col overflow-hidden rounded-xl border">
            <div className="flex items-center justify-between gap-4 p-4 hairline-bottom">
                <h3 className="text-headline font-semibold">Your notes</h3>
                <span className="tnum text-footnote text-muted-foreground">{notes.length}</span>
            </div>

            <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto">
                {notes.length === 0 ? (
                    <p className="max-w-sm p-4 text-callout text-muted-foreground">
                        Jot what matters as it happens. Each note is stamped with the moment you wrote it, and the summary is written around them.
                    </p>
                ) : (
                    <ul className="divide-y divide-border">
                        {notes.map(note => (
                            <li key={note.id} className="group flex items-start gap-4 px-4 py-2">
                                <span className="tnum w-12 shrink-0 pt-1 text-footnote text-muted-foreground">{formatMs(note.atMs)}</span>
                                <p className="min-w-0 flex-1 whitespace-pre-wrap break-words text-callout">{note.text}</p>
                                {onDeleteNote && (
                                    <Button
                                        variant="ghost"
                                        size="iconSm"
                                        aria-label="Delete note"
                                        onClick={() => onDeleteNote(note.id)}
                                        className="shrink-0 text-muted-foreground opacity-0 transition-opacity duration-200 ease-out focus-visible:opacity-100 group-hover:opacity-100"
                                    >
                                        <Trash2 aria-hidden="true" />
                                    </Button>
                                )}
                            </li>
                        ))}
                    </ul>
                )}
            </div>

            <div className="flex flex-col gap-2 p-4 hairline-top">
                {error && <p className="text-footnote text-warning">{error}</p>}
                <Textarea
                    rows={2}
                    value={draft}
                    disabled={!canWrite}
                    onChange={event => setDraft(event.target.value)}
                    onKeyDown={handleKeyDown}
                    placeholder={canWrite ? 'Add a note — Enter to save, Shift+Enter for a new line' : hint || 'Start a recording to take notes'}
                    aria-label="Add a note"
                    className="min-h-[56px] resize-none"
                />
            </div>
        </section>
    );
}
