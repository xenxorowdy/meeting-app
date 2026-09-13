import React, { useEffect, useMemo, useState } from 'react';
import { Check, ChevronRight, Folder, FolderPlus, MessageCircle, Search } from 'lucide-react';
import { apiRequest } from '@/lib/backend';
import { cn } from '@/utils/cn';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { MeetingChatPanel } from '@/components/MeetingChatPanel';

const UNFILED = 'unfiled';

function meetingFolderId(meeting) {
    return meeting?.metadata?.collectionId || UNFILED;
}

function shortDate(timestamp) {
    return new Date(timestamp || Date.now()).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

export function WorkspaceView({ meetings = [], isLoading, isConnected, onReload, onSelectMeeting }) {
    const [folders, setFolders] = useState([]);
    const [activeFolder, setActiveFolder] = useState('all');
    const [query, setQuery] = useState('');
    const [newFolder, setNewFolder] = useState('');
    const [selectedIds, setSelectedIds] = useState([]);
    const [error, setError] = useState(null);

    const loadFolders = async () => {
        try {
            const response = await apiRequest('/api/folders');
            setFolders(Array.isArray(response.folders) ? response.folders : []);
        } catch (cause) {
            setError(cause.message);
        }
    };

    useEffect(() => {
        if (isConnected) loadFolders();
    }, [isConnected]);

    const visible = useMemo(() => {
        const needle = query.trim().toLowerCase();
        return meetings.filter(meeting => {
            const inFolder = activeFolder === 'all' || meetingFolderId(meeting) === activeFolder;
            const matches = !needle || `${meeting.title} ${meeting.summaryMarkdown || ''}`.toLowerCase().includes(needle);
            return inFolder && matches;
        });
    }, [activeFolder, meetings, query]);

    useEffect(() => {
        setSelectedIds(previous => previous.filter(id => meetings.some(meeting => meeting.id === id)));
    }, [meetings]);

    const createFolder = async event => {
        event.preventDefault();
        const name = newFolder.trim();
        if (!name) return;
        try {
            const response = await apiRequest('/api/folders', { method: 'POST', body: { name } });
            setFolders(response.folders || []);
            setNewFolder('');
            setError(null);
        } catch (cause) {
            setError(cause.message);
        }
    };

    const moveMeeting = async (meeting, folderId) => {
        try {
            await apiRequest(`/api/meetings/${meeting.id}/folder`, {
                method: 'PATCH',
                body: { folderId: folderId === UNFILED ? null : folderId },
            });
            onReload?.();
            setError(null);
        } catch (cause) {
            setError(cause.message);
        }
    };

    const folderOptions = [{ id: UNFILED, name: 'Unfiled' }, ...folders];
    const activeFolderName = activeFolder === 'all'
        ? 'All meetings'
        : folderOptions.find(folder => folder.id === activeFolder)?.name || 'Folder';
    const selectedMeetings = selectedIds.map(id => meetings.find(meeting => meeting.id === id)).filter(Boolean);

    const selectFolder = folderId => {
        setActiveFolder(folderId);
        setSelectedIds([]);
        setError(null);
    };

    const askMeeting = meeting => {
        setSelectedIds([meeting.id]);
        setError(null);
    };

    const toggleMeeting = meeting => {
        setSelectedIds(ids => ids.includes(meeting.id) ? ids.filter(id => id !== meeting.id) : [...ids, meeting.id]);
        setError(null);
    };

    return (
        <div className="grid h-full min-h-0 flex-1 grid-cols-1 gap-4 overflow-y-auto xl:overflow-hidden xl:grid-cols-[minmax(520px,1.25fr)_minmax(360px,.75fr)]">
            <section className="grid min-h-[300px] grid-cols-[140px_minmax(0,1fr)] overflow-hidden rounded-2xl border bg-card/40">
                <aside className="flex min-h-0 flex-col border-r bg-muted/45 p-3">
                    <p className="px-2 py-2 text-footnote font-semibold uppercase tracking-wider text-muted-foreground">Folders</p>
                    <div className="space-y-1 overflow-y-auto">
                        {[{ id: 'all', name: 'All meetings' }, ...folderOptions].map(folder => (
                            <button key={folder.id} type="button" onClick={() => selectFolder(folder.id)} className={cn('flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-callout', activeFolder === folder.id && selectedIds.length === 0 ? 'bg-background font-medium shadow-sm' : 'text-muted-foreground hover:text-foreground')}>
                                <Folder className="size-4" aria-hidden="true" />
                                <span className="truncate">{folder.name}</span>
                            </button>
                        ))}
                    </div>
                    <form onSubmit={createFolder} className="mt-auto flex gap-1 pt-3">
                        <Input value={newFolder} onChange={event => setNewFolder(event.target.value)} placeholder="New folder" maxLength={60} className="h-8 min-w-0" aria-label="New folder name" />
                        <Button type="submit" size="iconSm" variant="ghost" disabled={!newFolder.trim()} aria-label="Create folder"><FolderPlus /></Button>
                    </form>
                </aside>

                <div className="flex min-w-0 flex-col overflow-hidden bg-background">
                    <div className="flex items-center gap-2 border-b p-3">
                        <div className="relative flex-1">
                            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                            <Input value={query} onChange={event => setQuery(event.target.value)} placeholder="Search meetings" className="pl-9" />
                        </div>
                        <Button variant="outline" size="sm" onClick={onReload}>Refresh</Button>
                    </div>
                    {error && <p className="p-3 text-footnote text-destructive" role="alert">{error}</p>}
                    <div className="flex-1 overflow-y-auto p-2">
                        {isLoading && !meetings.length ? <p className="p-6 text-muted-foreground">Loading meetings…</p> : visible.length === 0 ? <p className="p-6 text-muted-foreground">No meetings in this folder.</p> : (
                            <ul className="space-y-1">
                                {visible.map(meeting => {
                                    const checked = selectedIds.includes(meeting.id);
                                    return <li key={meeting.id} className="group flex items-center gap-2 rounded-xl p-2 hover:bg-muted/65">
                                        <button type="button" onClick={() => toggleMeeting(meeting)} className={cn('flex size-5 shrink-0 items-center justify-center rounded border', checked && 'border-primary bg-primary text-primary-foreground')} aria-label={`${checked ? 'Remove' : 'Add'} ${meeting.title} from Ask Alpha`} aria-pressed={checked}>{checked && <Check className="size-3" />}</button>
                                        <button type="button" onClick={() => onSelectMeeting(meeting)} className="min-w-0 flex-1 text-left">
                                            <span className="block truncate text-callout font-medium">{meeting.title}</span>
                                            <span className="block truncate text-footnote text-muted-foreground">{shortDate(meeting.startedAt)} · {meeting.durationSeconds ? `${Math.max(1, Math.round(meeting.durationSeconds / 60))} min` : 'No duration'}</span>
                                        </button>
                                        <select value={meetingFolderId(meeting)} onChange={event => moveMeeting(meeting, event.target.value)} onClick={event => event.stopPropagation()} className="max-w-28 rounded-md border bg-background px-2 py-1 text-footnote text-muted-foreground opacity-0 group-hover:opacity-100 focus:opacity-100" aria-label={`Move ${meeting.title} to folder`}>
                                            {folderOptions.map(folder => <option key={folder.id} value={folder.id}>{folder.name}</option>)}
                                        </select>
                                        <Button variant="ghost" size="xs" onClick={() => askMeeting(meeting)} className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100" aria-label={`Ask about ${meeting.title}`}>
                                            <MessageCircle className="size-3.5" />
                                            Ask
                                        </Button>
                                        <ChevronRight className="size-4 text-muted-foreground" />
                                    </li>;
                                })}
                            </ul>
                        )}
                    </div>
                </div>
            </section>

            <div className="min-h-[500px] xl:min-h-0">
                <MeetingChatPanel
                    scope={selectedIds.length ? { type: 'meetings', meetingIds: selectedIds } : activeFolder === 'all' ? { type: 'all' } : { type: 'folder', folderId: activeFolder === UNFILED ? null : activeFolder }}
                    scopeLabel={selectedMeetings.length ? selectedMeetings.map(meeting => meeting.title).join(' · ') : activeFolderName}
                    isConnected={isConnected}
                    onSelectMeeting={onSelectMeeting}
                />
            </div>
        </div>
    );
}
