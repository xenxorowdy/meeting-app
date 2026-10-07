import React, { useEffect, useMemo, useState } from 'react';
import { Video } from 'lucide-react';
import { apiRequest } from '@/lib/backend';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';

const DURATIONS = [
    { value: '15', label: '15 minutes' },
    { value: '30', label: '30 minutes' },
    { value: '45', label: '45 minutes' },
    { value: '60', label: '1 hour' },
    { value: '90', label: '1 hour 30 minutes' },
];

function nextHalfHour() {
    const start = new Date();
    start.setSeconds(0, 0);
    start.setMinutes(start.getMinutes() + (30 - (start.getMinutes() % 30)));
    const offset = start.getTimezoneOffset() * 60000;
    return new Date(start.getTime() - offset).toISOString().slice(0, 16);
}

function toRfc3339(localValue) {
    const parsed = new Date(localValue);
    return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

export function NewMeetingModal({ isOpen, onClose, providers, onCreated, onOpenCalendarSettings }) {
    const [title, setTitle] = useState('');
    const [startsAt, setStartsAt] = useState(nextHalfHour);
    const [duration, setDuration] = useState('30');
    const [guests, setGuests] = useState('');
    const [addConference, setAddConference] = useState(true);
    const [pending, setPending] = useState(false);
    const [error, setError] = useState(null);

    const google = useMemo(() => (Array.isArray(providers) ? providers.find(entry => entry.provider === 'google') : null), [providers]);
    const canCreate = Boolean(google?.connected);

    useEffect(() => {
        if (!isOpen) return;
        setTitle('');
        setStartsAt(nextHalfHour());
        setDuration('30');
        setGuests('');
        setAddConference(true);
        setPending(false);
        setError(null);
    }, [isOpen]);

    const submit = async () => {
        const start = toRfc3339(startsAt);
        if (!title.trim()) {
            setError('Give the meeting a title.');
            return;
        }
        if (!start) {
            setError('Pick a valid start time.');
            return;
        }

        setPending(true);
        setError(null);
        try {
            await apiRequest('/api/calendar/events', {
                method: 'POST',
                body: {
                    provider: 'google',
                    title: title.trim(),
                    start,
                    end: new Date(Date.parse(start) + Number(duration) * 60000).toISOString(),
                    attendees: guests
                        .split(/[\s,;]+/)
                        .map(entry => entry.trim())
                        .filter(Boolean),
                    addConference,
                },
            });
            await onCreated?.();
            onClose();
        } catch (cause) {
            setError(cause?.message || 'The calendar would not create that meeting.');
        } finally {
            setPending(false);
        }
    };

    return (
        <Dialog open={isOpen} onOpenChange={open => !open && onClose()}>
            <DialogContent className="flex flex-col gap-0 p-0 sm:max-w-lg">
                <DialogHeader className="space-y-1 p-4 pb-4 pr-12 text-left hairline-bottom">
                    <DialogTitle className="text-title2 font-semibold">New meeting</DialogTitle>
                    <DialogDescription className="text-callout text-muted-foreground">
                        {canCreate
                            ? 'Adds the event to your Google Calendar and invites your guests.'
                            : 'Connect Google Calendar in Settings to schedule from Kesami.'}
                    </DialogDescription>
                </DialogHeader>

                <div className="flex flex-col gap-4 p-4">
                    <div className="space-y-2">
                        <Label htmlFor="meeting-title" className="text-body font-medium">
                            Title
                        </Label>
                        <Input
                            id="meeting-title"
                            value={title}
                            autoFocus
                            placeholder="Design review"
                            disabled={!canCreate}
                            onChange={event => setTitle(event.target.value)}
                        />
                    </div>

                    <div className="flex gap-4">
                        <div className="flex-1 space-y-2">
                            <Label htmlFor="meeting-start" className="text-body font-medium">
                                Starts
                            </Label>
                            <Input
                                id="meeting-start"
                                type="datetime-local"
                                value={startsAt}
                                disabled={!canCreate}
                                onChange={event => setStartsAt(event.target.value)}
                            />
                        </div>
                        <div className="w-44 space-y-2">
                            <Label htmlFor="meeting-duration" className="text-body font-medium">
                                Duration
                            </Label>
                            <Select value={duration} onValueChange={setDuration} disabled={!canCreate}>
                                <SelectTrigger id="meeting-duration" className="w-full">
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    {DURATIONS.map(option => (
                                        <SelectItem key={option.value} value={option.value}>
                                            {option.label}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </div>
                    </div>

                    <div className="space-y-2">
                        <Label htmlFor="meeting-guests" className="text-body font-medium">
                            Guests
                        </Label>
                        <Textarea
                            id="meeting-guests"
                            rows={2}
                            value={guests}
                            placeholder="alex@example.com, sam@example.com"
                            disabled={!canCreate}
                            onChange={event => setGuests(event.target.value)}
                        />
                    </div>

                    <div className="flex items-center justify-between gap-4 hairline-top pt-4">
                        <div className="flex items-center gap-2">
                            <Video className="h-4 w-4 text-muted-foreground" />
                            <Label htmlFor="meeting-conference" className="cursor-pointer text-body font-normal">
                                Add a Google Meet link
                            </Label>
                        </div>
                        <Switch id="meeting-conference" checked={addConference} disabled={!canCreate} onCheckedChange={setAddConference} />
                    </div>

                    {error ? <p className="text-callout text-destructive">{error}</p> : null}
                </div>

                <DialogFooter className="flex-row items-center justify-end gap-2 p-4 pt-4 hairline-top">
                    <Button variant="outline" onClick={onClose}>
                        Cancel
                    </Button>
                    {canCreate || !onOpenCalendarSettings ? (
                        <Button onClick={submit} disabled={!canCreate || pending}>
                            {pending ? 'Creating…' : 'Create meeting'}
                        </Button>
                    ) : (
                        <Button onClick={onOpenCalendarSettings}>Connect Google Calendar</Button>
                    )}
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
