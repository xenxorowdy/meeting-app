import React, { useMemo, useState } from 'react';
import { Search, Calendar, Clock, Users, Download, Trash2, ChevronRight, ListChecks, X, RotateCw, TriangleAlert } from 'lucide-react';
import { cn } from '@/utils/cn';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { SegmentedControl, SegmentedItem } from '@/components/ui/segmented-control';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
} from '@/components/ui/alert-dialog';

/**
 * Format duration in seconds to "Xm" or "Xh Ym"
 */
function formatDurationNice(seconds = 0) {
    const mins = Math.round(seconds / 60);
    if (mins < 1) return `${Math.max(0, Math.round(seconds))} sec`;
    if (mins < 60) return `${mins} min`;
    const hrs = Math.floor(mins / 60);
    const remainingMins = mins % 60;
    return `${hrs}h ${remainingMins}m`;
}

const DATE_FILTERS = [
    { value: 'ALL', label: 'All' },
    { value: 'TODAY', label: 'Today' },
    { value: 'WEEK', label: 'Week' },
    { value: 'MONTH', label: 'Month' },
];

function plainSnippet(markdown = '') {
    return markdown
        .replace(/^#{1,6}\s+/gm, '')
        .replace(/\*\*([^*]+)\*\*/g, '$1')
        .replace(/[*_`>]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

const DATE_WINDOWS_MS = {
    TODAY: 24 * 60 * 60 * 1000,
    WEEK: 7 * 24 * 60 * 60 * 1000,
    MONTH: 30 * 24 * 60 * 60 * 1000,
};

function StatTile({ label, value, unit }) {
    return (
        <div className="rounded-lg bg-muted px-3 py-2.5">
            <p className="text-footnote text-muted-foreground">{label}</p>
            <p className="mt-0.5 flex items-baseline gap-1">
                <span className="tnum text-title1 font-semibold">{value}</span>
                {unit && <span className="text-footnote text-muted-foreground">{unit}</span>}
            </p>
        </div>
    );
}

function EmptyState({ icon: Icon, title, description, action }) {
    return (
        <div className="flex h-full flex-col items-center justify-center px-6 py-12 text-center">
            <div className="mb-3 flex size-10 items-center justify-center rounded-full bg-muted text-muted-foreground">
                <Icon className="size-5" aria-hidden="true" />
            </div>
            <p className="text-headline font-semibold">{title}</p>
            <p className="mt-1 max-w-sm text-callout text-muted-foreground">{description}</p>
            {action && <div className="mt-3">{action}</div>}
        </div>
    );
}

export function HistoryExplorer({
    meetings = [],
    isLoading = false,
    error = null,
    searchQuery = '',
    onSearchChange,
    onReload,
    isConnected = true,
    selectedMeetingId,
    onSelectMeeting,
    onDeleteMeeting,
    onExportMeeting,
}) {
    const [dateFilter, setDateFilter] = useState('ALL');
    const [pendingDelete, setPendingDelete] = useState(null);

    const stats = useMemo(() => {
        const totalDurationSec = meetings.reduce((acc, meeting) => acc + (meeting.durationSeconds || 0), 0);
        let totalActionItems = 0;
        let pendingActionItems = 0;

        meetings.forEach(meeting => {
            const items = meeting.actionItems || [];
            totalActionItems += items.length;
            pendingActionItems += items.filter(item => typeof item === 'object' && !item.completed).length;
        });

        return {
            totalMeetings: meetings.length,
            totalHours: (totalDurationSec / 3600).toFixed(1),
            totalActionItems,
            pendingActionItems,
        };
    }, [meetings]);

    // Search runs on the backend; the date window is a local narrowing of those results.
    const visibleMeetings = useMemo(() => {
        if (dateFilter === 'ALL') return meetings;
        const cutoff = Date.now() - DATE_WINDOWS_MS[dateFilter];
        return meetings.filter(meeting => (meeting.startedAt || 0) >= cutoff);
    }, [meetings, dateFilter]);

    const confirmDelete = async () => {
        if (pendingDelete && onDeleteMeeting) {
            await onDeleteMeeting(pendingDelete.id);
        }
        setPendingDelete(null);
    };

    return (
        <section aria-label="Meeting history" className="flex h-full flex-col overflow-hidden rounded-xl border bg-card shadow-card">
            <div className="flex flex-col gap-3 p-3 hairline-bottom sm:p-4">
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-3 lg:max-w-2xl">
                    <StatTile label="Meetings" value={stats.totalMeetings} unit="stored" />
                    <StatTile label="Recorded" value={`${stats.totalHours}h`} unit="of audio" />
                    <StatTile label="Open actions" value={stats.pendingActionItems} unit={`of ${stats.totalActionItems}`} />
                </div>

                <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                    <div className="relative flex-1">
                        <Search
                            className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
                            aria-hidden="true"
                        />
                        <Input
                            type="search"
                            placeholder="Search stored meetings"
                            aria-label="Search stored meetings"
                            value={searchQuery}
                            disabled={!isConnected}
                            onChange={event => onSearchChange && onSearchChange(event.target.value)}
                            className="h-8 rounded-full pl-8 pr-8 text-callout"
                        />
                        {searchQuery && (
                            <Button
                                variant="ghost"
                                size="iconXs"
                                onClick={() => onSearchChange && onSearchChange('')}
                                aria-label="Clear search"
                                className="absolute right-0.5 top-1/2 -translate-y-1/2 rounded-full text-muted-foreground"
                            >
                                <X aria-hidden="true" />
                            </Button>
                        )}
                    </div>

                    <div className="flex items-center gap-2">
                        <SegmentedControl value={dateFilter} onValueChange={setDateFilter} aria-label="Filter by date">
                            {DATE_FILTERS.map(filter => (
                                <SegmentedItem key={filter.value} value={filter.value} className="px-3">
                                    {filter.label}
                                </SegmentedItem>
                            ))}
                        </SegmentedControl>

                        <Tooltip>
                            <TooltipTrigger asChild>
                                <Button variant="ghost" size="iconSm" onClick={onReload} disabled={!isConnected} aria-label="Reload meetings">
                                    <RotateCw className={cn(isLoading && 'animate-spin')} aria-hidden="true" />
                                </Button>
                            </TooltipTrigger>
                            <TooltipContent>Reload from the backend</TooltipContent>
                        </Tooltip>
                    </div>
                </div>
            </div>

            <div className="flex-1 overflow-y-auto">
                {!isConnected ? (
                    <EmptyState
                        icon={TriangleAlert}
                        title="Backend offline"
                        description="Meetings are stored by the core backend. Start it to browse and search your history."
                        action={
                            <Button variant="outline" size="sm" onClick={onReload}>
                                <RotateCw aria-hidden="true" />
                                Try again
                            </Button>
                        }
                    />
                ) : error ? (
                    <EmptyState
                        icon={TriangleAlert}
                        title="Couldn’t load meetings"
                        description={error}
                        action={
                            <Button variant="outline" size="sm" onClick={onReload}>
                                <RotateCw aria-hidden="true" />
                                Try again
                            </Button>
                        }
                    />
                ) : isLoading && meetings.length === 0 ? (
                    <ul className="divide-y divide-border" aria-busy="true" aria-label="Loading meetings">
                        {[0, 1, 2].map(row => (
                            <li key={row} className="space-y-2 px-3 py-3.5 sm:px-4">
                                <div className="h-3.5 w-1/3 animate-breathe rounded bg-muted" />
                                <div className="h-3 w-2/3 animate-breathe rounded bg-muted" />
                                <div className="h-3 w-1/4 animate-breathe rounded bg-muted" />
                            </li>
                        ))}
                    </ul>
                ) : visibleMeetings.length === 0 ? (
                    <EmptyState
                        icon={Calendar}
                        title={searchQuery || dateFilter !== 'ALL' ? 'Nothing found' : 'No meetings yet'}
                        description={
                            searchQuery || dateFilter !== 'ALL'
                                ? 'Try a different search or widen the date range.'
                                : 'Recordings you finish are stored here by the backend, with their transcript and notes.'
                        }
                    />
                ) : (
                    <ul className="divide-y divide-border">
                        {visibleMeetings.map(item => {
                            const isSelected = selectedMeetingId === item.id;
                            const formattedDate = new Date(item.startedAt || Date.now()).toLocaleDateString('en-US', {
                                month: 'short',
                                day: 'numeric',
                                year: 'numeric',
                                hour: 'numeric',
                                minute: '2-digit',
                            });

                            const pendingActions = (item.actionItems || []).filter(a => typeof a === 'object' && !a.completed).length;
                            const speakerCount = (item.participants || []).length;
                            const turnCount = (item.transcript || []).length;

                            return (
                                <li key={item.id}>
                                    <div
                                        role="button"
                                        tabIndex={0}
                                        aria-current={isSelected ? 'true' : undefined}
                                        onClick={() => onSelectMeeting && onSelectMeeting(item)}
                                        onKeyDown={event => {
                                            if (event.key === 'Enter' || event.key === ' ') {
                                                event.preventDefault();
                                                onSelectMeeting && onSelectMeeting(item);
                                            }
                                        }}
                                        className={cn(
                                            'group flex cursor-pointer items-start justify-between gap-4 px-3 py-3 transition-colors sm:px-4',
                                            isSelected ? 'bg-primary/[0.10]' : 'hover:bg-muted/60'
                                        )}
                                    >
                                        <div className="min-w-0 flex-1">
                                            <div className="flex flex-wrap items-center gap-2">
                                                <h3 className="truncate text-headline font-semibold">{item.title}</h3>
                                                {isSelected && <Badge variant="tinted">Viewing</Badge>}
                                            </div>

                                            <p className="mt-1 line-clamp-2 text-callout text-muted-foreground">
                                                {plainSnippet(item.summaryMarkdown) || 'No summary stored for this meeting.'}
                                            </p>

                                            <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-footnote text-muted-foreground">
                                                <span className="flex items-center gap-1">
                                                    <Calendar className="size-3" aria-hidden="true" />
                                                    {formattedDate}
                                                </span>
                                                <span className="flex items-center gap-1">
                                                    <Clock className="size-3" aria-hidden="true" />
                                                    {formatDurationNice(item.durationSeconds || 0)}
                                                </span>
                                                <span className="flex items-center gap-1">
                                                    <Users className="size-3" aria-hidden="true" />
                                                    {speakerCount === 0
                                                        ? 'No speakers detected'
                                                        : `${speakerCount} ${speakerCount === 1 ? 'speaker' : 'speakers'}`}
                                                </span>
                                                <span className="tnum">
                                                    {turnCount} {turnCount === 1 ? 'turn' : 'turns'}
                                                </span>
                                                {pendingActions > 0 && (
                                                    <span className="flex items-center gap-1 text-warning">
                                                        <ListChecks className="size-3" aria-hidden="true" />
                                                        {pendingActions} open
                                                    </span>
                                                )}
                                            </div>
                                        </div>

                                        <div className="flex shrink-0 items-center gap-1 self-center">
                                            {onExportMeeting && (
                                                <Tooltip>
                                                    <TooltipTrigger asChild>
                                                        <Button
                                                            variant="ghost"
                                                            size="iconSm"
                                                            aria-label={`Export ${item.title}`}
                                                            className="text-muted-foreground opacity-0 focus-visible:opacity-100 group-hover:opacity-100"
                                                            onClick={event => {
                                                                event.stopPropagation();
                                                                onExportMeeting(item);
                                                            }}
                                                        >
                                                            <Download aria-hidden="true" />
                                                        </Button>
                                                    </TooltipTrigger>
                                                    <TooltipContent>Export notes</TooltipContent>
                                                </Tooltip>
                                            )}

                                            {onDeleteMeeting && (
                                                <Tooltip>
                                                    <TooltipTrigger asChild>
                                                        <Button
                                                            variant="ghost"
                                                            size="iconSm"
                                                            aria-label={`Delete ${item.title}`}
                                                            className="text-muted-foreground opacity-0 hover:text-destructive focus-visible:opacity-100 group-hover:opacity-100"
                                                            onClick={event => {
                                                                event.stopPropagation();
                                                                setPendingDelete(item);
                                                            }}
                                                        >
                                                            <Trash2 aria-hidden="true" />
                                                        </Button>
                                                    </TooltipTrigger>
                                                    <TooltipContent>Delete meeting</TooltipContent>
                                                </Tooltip>
                                            )}

                                            <ChevronRight className="size-4 text-muted-foreground" aria-hidden="true" />
                                        </div>
                                    </div>
                                </li>
                            );
                        })}
                    </ul>
                )}
            </div>

            <AlertDialog open={Boolean(pendingDelete)} onOpenChange={open => !open && setPendingDelete(null)}>
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogTitle>Delete “{pendingDelete?.title}”?</AlertDialogTitle>
                        <AlertDialogDescription>
                            The backend deletes this meeting’s transcript, summary, and action items from this device. This can’t be undone.
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <AlertDialogAction onClick={confirmDelete} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
                            Delete
                        </AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
        </section>
    );
}
