import React, { useMemo } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/utils/cn';

function clock(value) {
    const ms = Date.parse(value);
    if (!Number.isFinite(ms)) return '';
    return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function dayKey(ms) {
    const date = new Date(ms);
    return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

function dayLabel(ms) {
    const date = new Date(ms);
    const today = new Date();
    const tomorrow = new Date(today);
    tomorrow.setDate(today.getDate() + 1);

    if (dayKey(ms) === dayKey(today.getTime())) return 'Today';
    if (dayKey(ms) === dayKey(tomorrow.getTime())) return 'Tomorrow';
    return date.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });
}

function groupByDay(events) {
    const groups = new Map();
    for (const event of events) {
        const ms = Date.parse(event.start);
        if (!Number.isFinite(ms)) continue;
        const key = dayKey(ms);
        if (!groups.has(key)) groups.set(key, { label: dayLabel(ms), events: [] });
        groups.get(key).events.push({ ...event, startMs: ms, endMs: Date.parse(event.end) });
    }
    return [...groups.values()];
}

export function HomeView({ events = [], providers = [], isConnected, canRecord, onStartMeeting, onOpenSettings }) {
    const groups = useMemo(() => groupByDay(events), [events]);
    const anyConnected = providers.some(provider => provider.connected);
    const now = Date.now();

    return (
        <div className="flex h-full flex-col overflow-y-auto">
            {!anyConnected ? (
                <div className="max-w-sm py-16">
                    <h2 className="text-title2">No calendar connected</h2>
                    <p className="mt-2 text-callout text-muted-foreground">
                        Connect Google Calendar or Outlook and today’s meetings appear here, each one a click away from recording.
                    </p>
                    <div className="mt-4 flex items-center gap-4">
                        <Button size="sm" onClick={onOpenSettings} disabled={!isConnected}>
                            Connect a calendar
                        </Button>
                        <button
                            type="button"
                            onClick={() => onStartMeeting()}
                            disabled={!canRecord}
                            className="text-callout text-muted-foreground underline-offset-4 transition-colors duration-200 ease-out hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40"
                        >
                            Record without one
                        </button>
                    </div>
                </div>
            ) : groups.length === 0 ? (
                <div className="max-w-sm py-16">
                    <h2 className="text-title2">Nothing scheduled</h2>
                    <p className="mt-2 text-callout text-muted-foreground">Your calendar is clear for the next twelve hours.</p>
                    <button
                        type="button"
                        onClick={() => onStartMeeting()}
                        disabled={!canRecord}
                        className="mt-4 text-callout text-muted-foreground underline-offset-4 transition-colors duration-200 ease-out hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40"
                    >
                        Start recording anyway
                    </button>
                </div>
            ) : (
                <div className="flex flex-col gap-8">
                    {groups.map(group => (
                        <section key={group.label}>
                            <h2 className="text-title2">{group.label}</h2>
                            <ul className="mt-4 divide-y divide-border border-t">
                                {group.events.map(event => {
                                    const live = event.startMs <= now && event.endMs > now;
                                    return (
                                        <li key={`${event.provider}-${event.id}`}>
                                            <button
                                                type="button"
                                                onClick={() => onStartMeeting(event.title)}
                                                disabled={!canRecord}
                                                className={cn(
                                                    'flex h-12 w-full items-center gap-4 text-left transition-colors duration-200 ease-out',
                                                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40',
                                                    'hover:bg-accent'
                                                )}
                                            >
                                                <span className="tnum w-24 shrink-0 pl-2 text-callout text-muted-foreground">
                                                    {clock(event.start)}
                                                </span>
                                                <span className="min-w-0 flex-1 truncate text-body">{event.title}</span>
                                                {live && <span className="shrink-0 pr-2 text-footnote text-muted-foreground">Now</span>}
                                            </button>
                                        </li>
                                    );
                                })}
                            </ul>
                        </section>
                    ))}

                    <button
                        type="button"
                        onClick={() => onStartMeeting()}
                        disabled={!canRecord}
                        className="self-start text-callout text-muted-foreground underline-offset-4 transition-colors duration-200 ease-out hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40"
                    >
                        Record something not on the calendar
                    </button>
                </div>
            )}
        </div>
    );
}
