import { PricingView } from './PricingView';
import { AccountSecurity } from './AccountSecurity';
import { PlanBilling } from './PlanBilling';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PanelLeftClose, PanelLeftOpen, ArrowUpRight, ChevronLeft, ChevronRight, CalendarDays, ExternalLink, FileText, Folder, Home, Library, LogIn, LogOut, Mic, Monitor, MoreHorizontal, Moon, Plus, Search, Settings, Sparkles, Star, Sun, UserRound, X } from 'lucide-react';
import { LogoMark } from '@/components/brand/Logo';
import { apiRequest } from '@/lib/backend';
import { MeetingChatPanel } from '@/components/MeetingChatPanel';
import { MemoryFilters } from '@/components/MemoryFilters';
import { memoryScope } from '@/lib/chat';

import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { AGENDA_HORIZON_DAYS, calendarEventLink, countdownLabel, eventFolderId, seriesFolderId } from '@/lib/calendarEvents';
import { AgendaFolderPicker } from './AgendaFolderPicker';
import { MeetingDetail, Avatar } from './MeetingDetail';
import { durationLabel, FOLDER_COLORS, meetingCountLabel } from './designHelpers';

const AGENDA_PAGE_DAYS = 2;
const FOLDER_COLOR_KEY = 'kesami.folder-colors';
const SIDEBAR_COLLAPSED_KEY = 'kesami.sidebar-collapsed';
const EMPTY_FOLDER_RULES = { events: {}, series: {} };

function readFolderColors() {
    try {
        return JSON.parse(localStorage.getItem(FOLDER_COLOR_KEY) || '{}');
    } catch {
        return {};
    }
}

function MeetingCard({ meeting, folders, onOpen, onMove, onDelete, disabled }) {
    const [menu, setMenu] = useState(false);
    const folder = folders.find(item => item.id === meeting.metadata?.collectionId);
    const participants = meeting.participants || [];

    return (
        <article className="ks-meeting-card">
            <button className="ks-meeting-card-body" disabled={disabled} onClick={onOpen}>
                <span className="ks-row-icon" aria-hidden="true">{participants.length ? <UserRound /> : <FileText />}</span>
                <div className="ks-row-copy">
                    <h3>{meeting.title || 'Untitled meeting'}</h3>
                    <p>{participants.length ? participants.join(', ') : 'You'}{folder ? ` · ${folder.name}` : ''}</p>
                </div>
                <time className="ks-row-duration">{durationLabel(meeting.durationSeconds)}</time>
            </button>
            <div className="ks-card-trailing">
                <button className="ks-card-more" aria-label={`Options for ${meeting.title}`} aria-expanded={menu} onClick={() => setMenu(!menu)}>
                    <MoreHorizontal />
                </button>
            </div>
            {menu && (
                <>
                    <button className="ks-menu-dismiss" aria-label="Close meeting menu" onClick={() => setMenu(false)} />
                    <div className="ks-card-menu">
                        <label>
                            MOVE TO FOLDER
                            <select
                                aria-label={`Move ${meeting.title} to folder`}
                                value={meeting.metadata?.collectionId || ''}
                                onChange={event => {
                                    onMove(meeting.id, event.target.value || null);
                                    setMenu(false);
                                }}
                            >
                                <option value="">Unfiled</option>
                                {folders.map(item => (
                                    <option key={item.id} value={item.id}>
                                        {item.name}
                                    </option>
                                ))}
                            </select>
                        </label>
                        <button
                            className="ks-delete-button"
                            onClick={() => {
                                setMenu(false);
                                onDelete(meeting);
                            }}
                        >
                            Delete meeting
                        </button>
                    </div>
                </>
            )}
        </article>
    );
}

export function DesignWorkspace({
    activeTab,
    setActiveTab,
    meeting,
    turns,
    interimTurns,
    history,
    calendar,
    session,
    isConnected,
    connection,
    banner,
    onRetry,
    onDismiss,
    onSettings,
    onNewMeeting,
    onExport,
    onSelectMeeting,
    onRenameSpeaker,
    onChangeTurnSpeaker,
    onUpdate,
    onUpdateCommitments,
    onUpdatePostMeetingAction,
    onRegenerateSummary,
    onAddNote,
    onDeleteNote,
    citationFocus,
    license,
    onSignOut,
    account,
    onAccountChange,
    authNotice,
    isDesktop,
    theme = 'dark',
    onToggleTheme,
    workspaceName = 'My workspace',
    displayName = '',
    noiseSuppression = true,
    onUpdateSettings,
    onPlanChanged,
}) {
    const [folders, setFolders] = useState([]);
    const [folderRules, setFolderRules] = useState(EMPTY_FOLDER_RULES);
    const [portalContainer, setPortalContainer] = useState();
    const bindWorkspace = useCallback(node => {
        if (node) setPortalContainer(node.closest('.ks-app') || undefined);
    }, []);
    const [folderId, setFolderId] = useState('all');
    const [query, setQuery] = useState('');
    const [libraryQuestion, setLibraryQuestion] = useState('');
    const [libraryDraft, setLibraryDraft] = useState(null);
    const askLibrary = text => {
        if (!text.trim()) return;
        setScope(folderId === 'all' || folderId === 'unfiled' ? 'all' : folderId);
        setLibraryDraft({ text: text.trim(), key: Date.now(), scope: folderId === 'unfiled' ? { type: 'meetings', meetingIds: visible.map(item => item.id) } : null });
        setActiveTab('ask');
    };
    const [creating, setCreating] = useState(false);
    const [folderName, setFolderName] = useState('');
    const [folderColor, setFolderColor] = useState(FOLDER_COLORS[0]);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const [deleting, setDeleting] = useState(null);
    const [scope, setScope] = useState('all');
    const [memoryFilters, setMemoryFilters] = useState({});
    const [toolsOpen, setToolsOpen] = useState(false);
    const [updatingNoise, setUpdatingNoise] = useState(false);
    const [savedColors, setSavedColors] = useState(readFolderColors);
    const [clock, setClock] = useState(() => Date.now());
    const isMeeting = ['live', 'notes', 'replay'].includes(activeTab);
    useEffect(() => {
        if (activeTab !== 'home') return undefined;
        setClock(Date.now());
        const timer = setInterval(() => setClock(Date.now()), 30000);
        return () => clearInterval(timer);
    }, [activeTab]);
    const canRecord = isConnected && !session.isRecording && !session.isPaused && !session.isProcessing;
    const locked = session.isRecording || session.isPaused || session.isProcessing;
    useEffect(() => {
        if (!isConnected) return;
        let cancelled = false;
        apiRequest('/api/folders')
            .then(result => {
                if (!cancelled) setFolders(result.folders || []);
            })
            .catch(cause => {
                if (!cancelled) setError(cause.message);
            });
        apiRequest('/api/folders/rules')
            .then(result => {
                if (!cancelled) setFolderRules(result.rules || EMPTY_FOLDER_RULES);
            })
            .catch(() => {});
        return () => {
            cancelled = true;
        };
    }, [isConnected]);
    const coloredFolders = useMemo(
        () =>
            folders.map((folder, index) => ({
                ...folder,
                color: savedColors[folder.id] || FOLDER_COLORS[index % FOLDER_COLORS.length],
            })),
        [folders, savedColors]
    );
    const folderCounts = useMemo(() => {
        const counts = {};
        for (const meeting of history.meetings) {
            const id = meeting.metadata?.collectionId;
            if (id) counts[id] = (counts[id] || 0) + 1;
        }
        return counts;
    }, [history.meetings]);
    const addFolder = async name => {
        const result = await apiRequest('/api/folders', { method: 'POST', body: { name } });
        setFolders(result.folders);
        return result.folders.find(folder => !folders.some(old => old.id === folder.id)) || result.folders.find(folder => folder.name.toLowerCase() === name.toLowerCase());
    };
    const assignEventFolder = async (event, folderId, applyToSeries) => {
        const result = await apiRequest('/api/folders/rules', {
            method: 'POST',
            body: { provider: event.provider, eventId: String(event.id), seriesId: event.seriesId || null, folderId, applyToSeries },
        });
        setFolderRules(result.rules || EMPTY_FOLDER_RULES);
        if (result.filed?.length) history.reload();
    };
    const openFolder = id => {
        setFolderId(id);
        setQuery('');
        setActiveTab('history');
    };
    const move = async (id, target) => {
        try {
            await apiRequest(`/api/meetings/${encodeURIComponent(id)}/folder`, { method: 'PATCH', body: { folderId: target } });
            history.reload();
            setError('');
        } catch (cause) {
            setError(cause.message);
        }
    };
    const create = async event => {
        event.preventDefault();
        if (!folderName.trim() || busy) return;
        setBusy(true);
        setError('');
        try {
            const result = await apiRequest('/api/folders', { method: 'POST', body: { name: folderName.trim() } });
            const added = result.folders.find(folder => !folders.some(old => old.id === folder.id));
            if (added) {
                const next = { ...savedColors, [added.id]: folderColor };
                setSavedColors(next);
                try {
                    localStorage.setItem(FOLDER_COLOR_KEY, JSON.stringify(next));
                } catch {
                    /* Color still has a fallback. */
                }
            }
            setFolders(result.folders);
            setCreating(false);
            setFolderName('');
            if (added) openFolder(added.id);
        } catch (cause) {
            setError(cause.message);
        } finally {
            setBusy(false);
        }
    };
    const now = new Date(clock);
    const greetingName = (displayName.trim() || account?.name || '').trim().split(/\s+/)[0];
    const profileName = account?.name || displayName.trim() || workspaceName;
    const googleCalendar = calendar.providers.find(provider => provider.provider === 'google');
    const canSchedule = Boolean(googleCalendar?.connected || googleCalendar?.configured);
    const calendarConnected = calendar.providers.some(provider => provider.connected);
    const showAgenda = calendarConnected || calendar.providers.some(provider => provider.configured) || calendar.events.length > 0;
    const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
        try { return localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === '1'; } catch { return false; }
    });
    const toggleSidebar = () => setSidebarCollapsed(value => {
        try { localStorage.setItem(SIDEBAR_COLLAPSED_KEY, value ? '0' : '1'); } catch {}
        return !value;
    });
    const [agendaOffset, setAgendaOffset] = useState(0);
    const agendaDays = Array.from({ length: AGENDA_PAGE_DAYS }, (_, index) => {
        const date = new Date(now);
        date.setDate(date.getDate() + agendaOffset + index);
        return { date, label: date.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' }),
            events: calendar.events.filter(event => new Date(event.start).toDateString() === date.toDateString()).sort((a, b) => new Date(a.start) - new Date(b.start)) };
    });
    const visible = useMemo(() => {
        const needle = query.trim().toLowerCase();
        return history.meetings.filter(
            item =>
                (folderId === 'all' || (item.metadata?.collectionId || 'unfiled') === folderId) &&
                `${item.title} ${item.summaryMarkdown || ''}`.toLowerCase().includes(needle)
        );
    }, [history.meetings, folderId, query]);
    const list = activeTab === 'home' ? history.meetings.slice(0, 6) : visible;
    const folder = coloredFolders.find(item => item.id === folderId);
    const plan = license?.tier ? `${license.tier[0].toUpperCase()}${license.tier.slice(1)} Plan` : 'Meeting workspace';
    // The backend treats anything short of a paid subscription as free (session_tier), so offer the upgrade
    // unless the licence says otherwise.
    const status = banner?.onAction
        ? { text: banner.text, actionLabel: banner.actionLabel, onAction: banner.onAction }
        : error
          ? { text: error, actionLabel: 'Dismiss', onAction: () => setError('') }
          : history.error
            ? { text: history.error, actionLabel: 'Dismiss', onAction: history.clearError }
            : banner?.tone === 'destructive'
              ? connection === 'connecting'
                  ? { text: 'Connecting to Kesami…' }
                  : { text: 'Kesami is offline. Your meetings appear again when it reconnects.', actionLabel: 'Reconnect', onAction: onRetry }
              : banner
                ? { text: banner.text, actionLabel: 'Dismiss', onAction: banner.onDismiss === null ? null : banner.onDismiss || onDismiss }
                : null;

    return (
        <div ref={bindWorkspace} className={`ks-workspace${isMeeting ? ' ks-workspace-meeting' : ''}${sidebarCollapsed ? ' is-sidebar-collapsed' : ''}${isDesktop ? ' is-desktop' : ''}`}>
            <aside className="ks-sidebar" id="ks-sidebar" aria-label="Workspace navigation">
                <div className={`ks-traffic drag-region${isDesktop ? ' ks-traffic-desktop' : ''}`}>
                    <span className="ks-sidebar-brand"><LogoMark size={24} /> <span className="ks-nav-label">Kesami</span></span>
                    <button
                        type="button"
                        className="ks-sidebar-toggle no-drag"
                        aria-label="Collapse sidebar"
                        aria-expanded="true"
                        aria-controls="ks-sidebar"
                        title="Collapse sidebar"
                        onClick={toggleSidebar}
                    >
                        <PanelLeftClose aria-hidden="true" />
                    </button>
                </div>
                <div className="ks-new-meeting">
                    <button
                        className={`ks-button ${locked ? 'ks-red' : 'ks-primary'}`}
                        title="New Meeting"
                        disabled={!isConnected || session.isProcessing}
                        onClick={() => (locked ? setActiveTab('live') : session.onStart())}
                    >
                        <i />
                        <span className="ks-nav-label">
                            {session.isRecording
                                ? 'Recording…'
                                : session.isPaused
                                  ? 'Recording paused'
                                  : session.isProcessing
                                    ? session.stopFailed ? 'Save pending' : 'Processing…'
                                    : 'New Meeting'}
                        </span>
                    </button>
                </div>
                <nav className="ks-sidebar-nav">
                    <button aria-current={activeTab === 'home' ? 'page' : undefined} className={activeTab === 'home' ? 'is-active' : ''} title="Home" onClick={() => setActiveTab('home')}>
                        <Home className="ks-home-icon" />
                        <span className="ks-nav-label">Home</span>
                    </button>
                    <button aria-current={activeTab === 'history' && folderId === 'all' ? 'page' : undefined} className={activeTab === 'history' && folderId === 'all' ? 'is-active' : ''} title="All meetings" onClick={() => openFolder('all')}>
                        <Library />
                        <span className="ks-nav-label">All meetings</span>
                    </button>
                    <button aria-current={activeTab === 'ask' ? 'page' : undefined} className={activeTab === 'ask' ? 'is-active' : ''} title="Ask Kesami" onClick={() => setActiveTab('ask')}>
                        <Sparkles />
                        <span className="ks-nav-label">Ask Kesami</span>
                    </button>
                    <div className="ks-folder-heading">
                        <span>Folders</span>
                        <button
                            aria-label="New folder"
                            disabled={!isConnected}
                            onClick={() => {
                                setCreating(true);
                                setError('');
                            }}
                        >
                            <Plus />
                        </button>
                    </div>
                    {coloredFolders.map(item => (
                        <button
                            key={item.id}
                            aria-current={activeTab === 'history' && folderId === item.id ? 'page' : undefined}
                            className={activeTab === 'history' && folderId === item.id ? 'is-active' : ''}
                            title={item.name}
                            onClick={() => openFolder(item.id)}
                        >
                            <Folder className="ks-folder-icon" style={{ color: item.color }} aria-hidden="true" />
                            <span>{item.name}</span>
                            <small>{folderCounts[item.id] || 0}</small>
                        </button>
                    ))}
                    {!folders.length && (
                        <p className="ks-no-folders">
                            Organize your meetings.
                        </p>
                    )}
                </nav>
                <div className="ks-sidebar-footer">
                    <div className="ks-footer-utility">
                        <button title="Settings" onClick={onSettings}>
                            <Settings />
                            <span className="ks-nav-label">Settings</span>
                        </button>
                        <button aria-label="Workspace tools" aria-expanded={toolsOpen} onClick={() => setToolsOpen(!toolsOpen)}>
                            <MoreHorizontal />
                        </button>
                    </div>
                    {toolsOpen && (
                        <div className="ks-workspace-tools">
                            <button
                                className="ks-sidebar-control"
                                role="switch"
                                aria-label="Noise cancellation"
                                aria-checked={noiseSuppression}
                                disabled={!isConnected || updatingNoise || !onUpdateSettings}
                                title="Reduce background noise in your microphone"
                                onClick={async () => {
                                    setUpdatingNoise(true);
                                    try {
                                        const result = await onUpdateSettings({ noiseSuppression: !noiseSuppression });
                                        if (!result?.ok || !result.persisted) setError(result?.message || 'Noise cancellation could not be saved.');
                                        else setError('');
                                    } finally {
                                        setUpdatingNoise(false);
                                    }
                                }}
                            >
                                <Mic />
                                <span>Noise cancel</span>
                                <span className={`ks-toggle ${noiseSuppression ? '' : 'is-off'}`} aria-hidden="true">
                                    <i />
                                </span>
                            </button>

                            <button onClick={() => { setActiveTab('profile'); setToolsOpen(false); }}><UserRound />Account</button>
                            <button onClick={() => { setActiveTab('pricing'); setToolsOpen(false); }}><Star />Plans &amp; pricing</button>
                            <button disabled={locked} onClick={() => { setToolsOpen(false); onSignOut(); }}>
                                {account ? <LogOut /> : <LogIn />}
                                {account ? 'Sign out' : 'Sign in'}
                            </button>
                        </div>
                    )}
                    <button className={`ks-profile ${activeTab === 'profile' ? 'is-active' : ''}`} title={profileName} onClick={() => setActiveTab('profile')}>
                        <Avatar name={profileName} />
                        <span>
                            {profileName}<small>{plan}</small>
                        </span>
                        <i className={isConnected ? 'online' : ''} title={isConnected ? 'Connected' : connection === 'connecting' ? 'Connecting' : 'Offline'} />
                    </button>
                </div>
            </aside>
            <main className="ks-main">
                <div className="ks-main-toolbar">
                    {sidebarCollapsed && (
                        <button
                            type="button"
                            className="ks-sidebar-toggle ks-sidebar-expand no-drag"
                            aria-label="Expand sidebar"
                            aria-expanded="false"
                            aria-controls="ks-sidebar"
                            title="Expand sidebar"
                            onClick={toggleSidebar}
                        >
                            <PanelLeftOpen aria-hidden="true" />
                        </button>
                    )}
                    <label className="ks-global-search">
                        <Search aria-hidden="true" />
                        <input aria-label="Search meetings" placeholder="Search your meetings…" value={query}
                            onChange={event => { setQuery(event.target.value); setFolderId('all'); setActiveTab('history'); }} />
                        {query && <button type="button" aria-label="Clear search" onClick={() => setQuery('')}><X /></button>}
                    </label>
                    {!isConnected && <button type="button" className="ks-service-status" onClick={onRetry}><i aria-hidden="true" />Offline · Retry</button>}
                    <button
                        className="ks-theme-toggle"
                        type="button"
                        aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
                        title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
                        onClick={onToggleTheme}
                    >
                        {theme === 'dark' ? <Sun aria-hidden="true" /> : <Moon aria-hidden="true" />}
                    </button>
                </div>
                {status && (
                    <div className="ks-status" role="status">
                        <span>{status.text}</span>
                        {status.onAction && <button onClick={status.onAction}>{status.actionLabel}</button>}
                    </div>
                )}
                {(activeTab === 'home' || activeTab === 'history') && (
                    <div className="ks-home-scroll" key={activeTab}>
                        <div className={`ks-home${activeTab === 'home' ? ` ks-dashboard${showAgenda ? '' : ' ks-dashboard-no-agenda'}` : ''}`}>
                            {activeTab === 'home' ? (
                                <>
                                    <header className="ks-home-heading">
                                        <div className="ks-home-heading-text">
                                            <span className="ks-home-eyebrow">{now.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })}</span>
                                            <h1>Good {now.getHours() < 12 ? 'morning' : now.getHours() < 18 ? 'afternoon' : 'evening'}{greetingName ? `, ${greetingName}` : ''}.</h1>
                                        </div>
                                        <div className="ks-home-controls">
                                        <button type="button" className="ks-home-schedule" onClick={() => setActiveTab('ask')}><Sparkles size={14} />Ask AI</button>
                                        {canSchedule && (
                                            <button type="button" className="ks-home-schedule" onClick={onNewMeeting}>
                                                <Plus size={14} />
                                                Schedule meeting
                                            </button>
                                        )}
                                        </div>
                                    </header>
                                    {showAgenda && <section className="ks-agenda" aria-label="Upcoming meetings">
                                        <div className="ks-agenda-heading"><h2>Coming up</h2><div className="ks-agenda-paging">
                                            <button type="button" className="ks-agenda-today" onClick={() => setAgendaOffset(0)} aria-current={agendaOffset === 0 ? 'date' : undefined}>Today</button>
                                            <button type="button" className="ks-icon-button" aria-label="Previous two days" disabled={agendaOffset <= 0} onClick={() => setAgendaOffset(value => Math.max(0, value - AGENDA_PAGE_DAYS))}><ChevronLeft /></button>
                                            <button type="button" className="ks-icon-button" aria-label="Next two days" disabled={agendaOffset + AGENDA_PAGE_DAYS >= AGENDA_HORIZON_DAYS} onClick={() => setAgendaOffset(value => Math.min(AGENDA_HORIZON_DAYS - AGENDA_PAGE_DAYS, value + AGENDA_PAGE_DAYS))}><ChevronRight /></button>
                                        </div></div>
                                        <div className="ks-agenda-card">
                                        {agendaDays.map(day => (
                                            <div className="ks-agenda-day" key={day.label}>
                                                <div className={`ks-agenda-date${day.date.toDateString() === now.toDateString() ? ' is-today' : ''}`} aria-label={day.label} aria-current={day.date.toDateString() === now.toDateString() ? 'date' : undefined}>
                                                    <strong>{day.date.getDate()}</strong><span>{day.date.toLocaleDateString([], { month: 'long' })}{day.date.toDateString() === now.toDateString() && <i className="ks-agenda-today-dot" aria-hidden="true" />}<small>{day.date.toLocaleDateString([], { weekday: 'short' })}</small></span>
                                                </div>
                                                <div className="ks-agenda-events">
                                                {!day.events.length && <p className="ks-agenda-empty">No events {day.date.toDateString() === now.toDateString() ? 'today' : 'scheduled'}</p>}
                                                {day.events.map((event, index) => {
                                                    const start = new Date(event.start);
                                                    const ended = new Date(event.end) <= now;
                                                    const link = calendarEventLink(event);
                                                    const isJoinLink = typeof event.joinUrl === 'string' && event.joinUrl.trim() === link;
                                                    return (
                                                        <div key={`${event.provider}-${event.id}`} className="ks-agenda-row">
                                                            <button
                                                                className="ks-agenda-main"
                                                                disabled={!canRecord}
                                                                onClick={() => session.onStart(event.title, event)}
                                                            >
                                                                <time>
                                                                    {start.toLocaleTimeString([], {
                                                                        hour: 'numeric',
                                                                        minute: '2-digit',
                                                                        hour12: false,
                                                                    })}
                                                                </time>
                                                                <i style={{ background: FOLDER_COLORS[index % FOLDER_COLORS.length] }} />
                                                                <strong>{event.title}</strong>
                                                                <span className="ks-agenda-range">{start.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })} – {new Date(event.end).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })}</span>
                                                                <small className={ended ? 'is-done' : ''}>
                                                                    {ended ? 'done' : countdownLabel(start - now)}
                                                                </small>
                                                            </button>
                                                            {link && (
                                                                <a
                                                                    className="ks-agenda-link"
                                                                    href={link}
                                                                    target="_blank"
                                                                    rel="noreferrer"
                                                                    aria-label={`${isJoinLink ? 'Join' : 'Open link for'} ${event.title}`}
                                                                >
                                                                    <ExternalLink />
                                                                    {isJoinLink ? 'Join' : 'Open link'}
                                                                </a>
                                                            )}
                                                            {event.id != null && (
                                                                <AgendaFolderPicker
                                                                    event={event}
                                                                    folders={coloredFolders}
                                                                    counts={folderCounts}
                                                                    folderId={eventFolderId(event, folderRules)}
                                                                    seriesFolderId={seriesFolderId(event, folderRules)}
                                                                    disabled={!isConnected}
                                                                    onAssign={(folderId, applyToSeries) => assignEventFolder(event, folderId, applyToSeries)}
                                                                    onCreate={addFolder}
                                                                />
                                                            )}
                                                        </div>
                                                    );
                                                })}
                                                </div>
                                            </div>
                                        ))}
                                        </div>
                                        {!calendarConnected && !calendar.events.length && (
                                            <div className="ks-empty-card">
                                                <CalendarDays className="ks-empty-icon" aria-hidden="true" />
                                                <h3>{calendarConnected ? 'Nothing scheduled today' : 'Bring your calendar into view'}</h3>
                                                <p>
                                                    {calendarConnected
                                                        ? 'Start a meeting whenever you’re ready.'
                                                        : 'Connect a calendar to see your upcoming meetings here.'}
                                                </p>
                                                {!calendarConnected && (
                                                    <button className="ks-text-button" onClick={() => onSettings('calendar')}>
                                                        Calendar settings <ArrowUpRight aria-hidden="true" />
                                                    </button>
                                                )}
                                            </div>
                                        )}
                                    </section>}
                                    <div className="ks-section-label ks-recent-heading">
                                        <h2>Recent meetings</h2>
                                        <button className="ks-view-all" onClick={() => openFolder('all')}>
                                            View all
                                        </button>
                                    </div>
                                </>
                            ) : (
                                <>
                                    <header className="ks-folder-title">
                                        {folder && <i style={{ background: folder.color }} />}
                                        <h1>{folder?.name || 'All meetings'}</h1>
                                        <span>{meetingCountLabel(visible.length)}</span>
                                    </header>
                                    <div className="ks-library-search">
                                        <button className="ks-button" onClick={history.reload}>
                                            Refresh
                                        </button>
                                    </div>
                                </>
                            )}
                            <div className="ks-meetings-list">
                                {list.map((item, index) => (
                                    <React.Fragment key={item.id}>
                                    {(index === 0 || new Date(list[index - 1].startedAt).toDateString() !== new Date(item.startedAt).toDateString()) && <h3 className="ks-meeting-date-group">{new Date(item.startedAt).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })}</h3>}
                                    <MeetingCard
                                        key={item.id}
                                        meeting={item}
                                        folders={coloredFolders}
                                        disabled={locked}
                                        onOpen={() => onSelectMeeting(item)}
                                        onMove={move}
                                        onDelete={setDeleting}
                                    />
                                    </React.Fragment>
                                ))}
                            </div>
                            {activeTab === 'history' && <form className="ks-library-ask" onSubmit={event => { event.preventDefault(); askLibrary(libraryQuestion); }}>
                                <input aria-label="Ask about your meetings" placeholder="Ask anything" value={libraryQuestion} onChange={event => setLibraryQuestion(event.target.value)} maxLength={4000} />
                                <button type="button" disabled={!isConnected} onClick={() => askLibrary('List recent action items with their owners and deadlines, citing the meetings.')}><Sparkles />List recent todos</button>
                            </form>}
                            {!list.length && (
                                <div className="ks-empty-card">
                                    <Library className="ks-empty-icon" aria-hidden="true" />
                                    <h3>{history.isLoading ? 'Loading meetings…' : query ? 'No matching meetings' : folderId !== 'all' ? 'This folder is ready for meetings' : 'Your next conversation starts here'}</h3>
                                    <p>{query ? 'Try a different title or a phrase from your meeting notes.' : 'Record a conversation to build a searchable collection of notes, decisions, and next steps.'}</p>
                                    {!history.isLoading && !query && <button type="button" className="ks-button ks-primary" disabled={!canRecord} onClick={() => session.onStart()}>
                                        <Mic /> {history.meetings.length ? 'Record a meeting' : 'Record your first meeting'}
                                    </button>}
                                </div>
                            )}
                        </div>
                    </div>
                )}
                {isMeeting && (
                    <MeetingDetail
                        key={meeting?.id || 'new'}
                        onUpgrade={() => setActiveTab('pricing')}
                        meeting={meeting}
                        folderName={folders.find(folder => folder.id === meeting?.metadata?.collectionId)?.name}
                        turns={turns}
                        interimTurns={interimTurns}
                        initialTab={activeTab === 'notes' ? 'summary' : activeTab === 'replay' ? 'replay' : 'transcript'}
                        session={session}
                        isConnected={isConnected}
                        citationFocus={citationFocus}
                        onBack={() => setActiveTab('home')}
                        onExport={onExport}
                        onUpdate={onUpdate}
                        onUpdateCommitments={onUpdateCommitments}
                        onUpdatePostMeetingAction={onUpdatePostMeetingAction}
                        onActionSettings={onSettings}
                        onRegenerateSummary={onRegenerateSummary}
                        onSelectMeeting={onSelectMeeting}
                        onRenameSpeaker={onRenameSpeaker}
                        onChangeTurnSpeaker={onChangeTurnSpeaker}
                        onAddNote={onAddNote}
                        onDeleteNote={onDeleteNote}
                    />
                )}
                {activeTab === 'ask' && (
                    <div className="ks-ask-view">
                        <MeetingChatPanel
                            draft={libraryDraft}
                            onDraftConsumed={() => setLibraryDraft(current => current ? { ...current, text: '' } : null)}
                            scope={memoryScope(libraryDraft?.scope || (scope === 'all' ? { type: 'all' } : { type: 'folder', folderId: scope }), memoryFilters)}
                            filterControl={<MemoryFilters onApply={setMemoryFilters} disabled={!isConnected} />}
                            scopeLabel="Answers from your conversations"
                            onUpgrade={() => setActiveTab('pricing')}
                            scopeControl={
                                <label className="ks-chat-scope">
                                    Search in
                                    <select aria-label="AI search scope" value={scope} onChange={event => { setScope(event.target.value); setLibraryDraft(null); }}>
                                        <option value="all">All meetings</option>
                                        {folders.map(item => (
                                            <option key={item.id} value={item.id}>
                                                {item.name}
                                            </option>
                                        ))}
                                    </select>
                                </label>
                            }
                            isConnected={isConnected}
                            onSelectMeeting={onSelectMeeting}
                        />
                    </div>
                )}
                {activeTab === 'profile' && (
                    <div className="ks-home-scroll">
                        <div className="ks-account">
                            <h1>{account ? 'Your account' : 'Your workspace'}</h1>
                            <p>
                                {account
                                    ? 'Your meeting library and recordings stay on this computer. Your account holds your plan.'
                                    : 'You’re using Kesami on this computer without an account.'}
                            </p>
                            {authNotice && <p role="alert">{authNotice}</p>}
                            <section className="ks-account-card">
                                <Avatar name={profileName} />
                                <div>
                                    <h2>{profileName}</h2>
                                    <p>{account?.email || 'Not signed in'}</p>
                                </div>
                                <span className="ks-tag">{isConnected ? 'CONNECTED' : 'OFFLINE'}</span>
                            </section>
                            {account && <PlanBilling onUpgrade={() => setActiveTab('pricing')} />}
                            {account && <AccountSecurity account={account} onAccountChange={onAccountChange} disabled={locked} />}
                            <section className="ks-account-card ks-account-stack">
                                <h2>Preferences</h2>
                                <button onClick={() => onSettings('audio')}>
                                    Audio &amp; recording <Settings />
                                </button>
                                <button onClick={() => onSettings('calendar')}>
                                    Calendar connections <Plus />
                                </button>
                            </section>
                            <button className="ks-button" disabled={locked} onClick={onSignOut}>
                                {account ? 'Sign out' : 'Sign in'}
                            </button>
                        </div>
                    </div>
                )}
                {activeTab === 'pricing' && (
                    <div className="ks-home-scroll">
                        <PricingView
                            account={account}
                            currentTier={license?.tier || 'free'}
                            canSignIn={!locked}
                            onSettings={() => onSettings('recording')}
                            onSignIn={onSignOut}
                            onSubscribed={onPlanChanged}
                        />
                    </div>
                )}
            </main>
            <Dialog open={creating} onOpenChange={setCreating}>
                <DialogContent portalContainer={portalContainer} className="ks-modal">
                    <DialogTitle>New folder</DialogTitle>
                    <DialogDescription>Keep related meetings together.</DialogDescription>
                    <form onSubmit={create}>
                        <label className="ks-field">
                            NAME
                            <input
                                autoFocus
                                placeholder="e.g. Sales, Design, 1:1s…"
                                maxLength={60}
                                value={folderName}
                                onChange={event => setFolderName(event.target.value)}
                            />
                        </label>
                        <span className="ks-field">COLOR</span>
                        <div className="ks-color-picker">
                            {FOLDER_COLORS.map(color => (
                                <button
                                    type="button"
                                    key={color}
                                    aria-label={`Folder color ${color}`}
                                    aria-pressed={folderColor === color}
                                    style={{ background: color }}
                                    onClick={() => setFolderColor(color)}
                                />
                            ))}
                        </div>
                        {error && (
                            <p className="ks-error" role="alert">
                                {error}
                            </p>
                        )}
                        <footer>
                            <button type="button" className="ks-button" onClick={() => setCreating(false)}>
                                Cancel
                            </button>
                            <button className="ks-button ks-primary" disabled={busy || !folderName.trim()}>
                                {busy ? 'Creating…' : 'Create folder'}
                            </button>
                        </footer>
                    </form>
                </DialogContent>
            </Dialog>
            <Dialog
                open={Boolean(deleting)}
                onOpenChange={open => {
                    if (!busy && !open) setDeleting(null);
                }}
            >
                <DialogContent portalContainer={portalContainer} className="ks-modal">
                    <DialogTitle>Delete meeting?</DialogTitle>
                    <DialogDescription>“{deleting?.title}” and its transcript, notes, and recording will be permanently deleted.</DialogDescription>
                    {error && (
                        <p className="ks-error" role="alert">
                            {error}
                        </p>
                    )}
                    <footer>
                        <button className="ks-button" disabled={busy} onClick={() => setDeleting(null)}>
                            Cancel
                        </button>
                        <button
                            className="ks-button ks-red"
                            disabled={busy}
                            onClick={async () => {
                                setBusy(true);
                                const ok = await history.deleteMeeting(deleting.id);
                                setBusy(false);
                                if (ok) setDeleting(null);
                                else setError('Could not delete this meeting. Please try again.');
                            }}
                        >
                            {busy ? 'Deleting…' : 'Delete'}
                        </button>
                    </footer>
                </DialogContent>
            </Dialog>
        </div>
    );
}
