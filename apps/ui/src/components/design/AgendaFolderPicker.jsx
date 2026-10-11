import React, { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, Folder, FolderPlus, Repeat, Search } from 'lucide-react';
import { suggestFolderName, suggestedFolder } from '@/lib/calendarEvents';

export function AgendaFolderPicker({ event, folders, counts, folderId, seriesFolderId, disabled, onAssign, onCreate }) {
    const [open, setOpen] = useState(false);
    const [query, setQuery] = useState('');
    const [askSeries, setAskSeries] = useState(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const trigger = useRef(null);
    const search = useRef(null);
    const current = folders.find(folder => folder.id === folderId) || null;
    const suggestion = suggestFolderName(event.title);
    const suggested = suggestedFolder(event.title, folders);
    const needle = query.trim().toLowerCase();
    const visible = folders
        .filter(folder => !needle || folder.name.toLowerCase().includes(needle))
        .sort((a, b) => Number(b.id === suggested?.id) - Number(a.id === suggested?.id));
    const createName = (query.trim() || (suggested ? '' : suggestion)).slice(0, 60);
    const canCreate = Boolean(createName) && !folders.some(folder => folder.name.trim().toLowerCase() === createName.toLowerCase());

    useEffect(() => {
        if (open && !askSeries) search.current?.focus();
    }, [open, askSeries]);

    const close = () => {
        setOpen(false);
        setQuery('');
        setAskSeries(null);
        setError('');
        trigger.current?.focus();
    };

    const run = async work => {
        setBusy(true);
        setError('');
        try {
            await work();
        } catch (cause) {
            setError(cause?.message || 'The folder couldn’t be updated.');
        } finally {
            setBusy(false);
        }
    };

    const assigned = id => {
        if (id && event.seriesId && seriesFolderId !== id) setAskSeries(id);
        else close();
    };

    const choose = id =>
        run(async () => {
            await onAssign(id, id === null && Boolean(seriesFolderId));
            assigned(id);
        });

    const create = () =>
        run(async () => {
            const folder = await onCreate(createName);
            if (!folder?.id) throw new Error('The folder couldn’t be created.');
            await onAssign(folder.id, false);
            assigned(folder.id);
        });

    const autoAdd = () =>
        run(async () => {
            await onAssign(askSeries, true);
            close();
        });

    const seriesFolder = folders.find(folder => folder.id === askSeries);

    return (
        <div className={`ks-agenda-folder${current ? ' has-folder' : ''}${open ? ' is-open' : ''}`}>
            <button
                ref={trigger}
                type="button"
                className="ks-agenda-folder-trigger"
                disabled={disabled}
                aria-haspopup="dialog"
                aria-expanded={open}
                aria-label={current ? `Folder for ${event.title}: ${current.name}` : `Choose a folder for ${event.title}`}
                title={current ? current.name : 'Add to folder'}
                onClick={() => (open ? close() : setOpen(true))}
            >
                <Folder aria-hidden="true" />
                {current && (
                    <>
                        <span>{current.name}</span>
                        <ChevronDown aria-hidden="true" />
                    </>
                )}
            </button>
            {open && (
                <>
                    <button type="button" className="ks-menu-dismiss" aria-label="Close folder picker" onClick={close} />
                    <div
                        className="ks-folder-picker"
                        role="dialog"
                        aria-label={`Folder for ${event.title}`}
                        onKeyDown={keyEvent => {
                            if (keyEvent.key !== 'Escape') return;
                            keyEvent.stopPropagation();
                            close();
                        }}
                    >
                        {askSeries ? (
                            <div className="ks-folder-picker-series">
                                <p className="ks-folder-picker-title">
                                    <Repeat aria-hidden="true" />
                                    Auto-add future meetings?
                                </p>
                                <p>Automatically put all future instances of this recurring meeting into {seriesFolder?.name || 'this folder'}.</p>
                                <div className="ks-folder-picker-actions">
                                    <button type="button" className="ks-folder-picker-primary" disabled={busy} onClick={autoAdd} autoFocus>
                                        Auto-add
                                    </button>
                                    <button type="button" className="ks-folder-picker-secondary" disabled={busy} onClick={close}>
                                        No
                                    </button>
                                </div>
                                {error && <p className="ks-folder-picker-error" role="alert">{error}</p>}
                            </div>
                        ) : (
                            <>
                                <label className="ks-folder-picker-search">
                                    <span className="sr-only">Search folders</span>
                                    <input
                                        ref={search}
                                        value={query}
                                        placeholder="Search"
                                        maxLength={60}
                                        onChange={changeEvent => setQuery(changeEvent.target.value)}
                                        onKeyDown={keyEvent => {
                                            if (keyEvent.key !== 'Enter' || busy) return;
                                            keyEvent.preventDefault();
                                            if (visible.length && needle) choose(visible[0].id);
                                            else if (canCreate) create();
                                        }}
                                    />
                                    <Search aria-hidden="true" />
                                </label>
                                <ul className="ks-folder-picker-list">
                                    {visible.map(folder => (
                                        <li key={folder.id}>
                                            <button type="button" aria-pressed={folder.id === folderId} disabled={busy} onClick={() => choose(folder.id)}>
                                                <Folder className="ks-folder-icon" style={{ color: folder.color }} aria-hidden="true" />
                                                <span>{folder.name}</span>
                                                {folder.id === suggested?.id && folder.id !== folderId && <em>Suggested</em>}
                                                <small>{counts[folder.id] || 0}</small>
                                                {folder.id === folderId && <Check className="ks-folder-picker-check" aria-label="Current folder" />}
                                            </button>
                                        </li>
                                    ))}
                                    {!visible.length && <li className="ks-folder-picker-empty">{needle ? 'No folders match' : 'No folders yet'}</li>}
                                </ul>
                                <div className="ks-folder-picker-footer">
                                    {canCreate ? (
                                        <button type="button" className="ks-folder-picker-create" disabled={busy} onClick={create}>
                                            <FolderPlus aria-hidden="true" />
                                            New folder “{createName}”
                                        </button>
                                    ) : (
                                        <button
                                            type="button"
                                            className="ks-folder-picker-create"
                                            disabled={busy}
                                            onClick={() => {
                                                setQuery(suggestion);
                                                search.current?.focus();
                                            }}
                                        >
                                            <FolderPlus aria-hidden="true" />
                                            New folder
                                        </button>
                                    )}
                                    {current && (
                                        <button type="button" className="ks-folder-picker-remove" disabled={busy} onClick={() => choose(null)}>
                                            Remove from folder
                                        </button>
                                    )}
                                </div>
                                {error && <p className="ks-folder-picker-error" role="alert">{error}</p>}
                            </>
                        )}
                    </div>
                </>
            )}
        </div>
    );
}
