import React, { useEffect, useRef, useState } from 'react';
import { Button, Dropdown, Header, Input, Label, Separator } from '@heroui/react';
import { ChevronDown, Folder, FolderMinus, FolderPlus, Repeat, Search } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { suggestFolderName, suggestedFolder } from '@/lib/calendarEvents';

export function AgendaFolderPicker({ event, folders, counts, folderId, seriesFolderId, disabled, portalContainer, onAssign, onCreate }) {
    const [open, setOpen] = useState(false);
    const [query, setQuery] = useState('');
    const [askSeries, setAskSeries] = useState(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const search = useRef(null);
    const menu = useRef(null);
    const running = useRef(false);
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
        if (!open) return;
        const frame = requestAnimationFrame(() => search.current?.focus());
        return () => cancelAnimationFrame(frame);
    }, [open]);

    const close = () => {
        setOpen(false);
        setQuery('');
        setError('');
    };

    const run = async work => {
        if (running.current || disabled) return;
        running.current = true;
        setBusy(true);
        setError('');
        try {
            await work();
        } catch (cause) {
            setError(cause?.message || 'The folder couldn’t be updated.');
        } finally {
            running.current = false;
            setBusy(false);
        }
    };

    const assigned = id => {
        close();
        if (id && event.seriesId && seriesFolderId !== id) setAskSeries(id);
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
            setAskSeries(null);
            setError('');
        });

    const seriesFolder = folders.find(folder => folder.id === askSeries);

    return (
        <div className={`ks-agenda-folder${current ? ' has-folder' : ''}${open ? ' is-open' : ''}`}>
            <Dropdown isOpen={open} onOpenChange={next => (next ? setOpen(true) : close())}>
                <Button
                    type="button"
                    variant="ghost"
                    className="ks-agenda-folder-trigger"
                    isDisabled={disabled || busy}
                    aria-label={current ? `Folder for ${event.title}: ${current.name}` : `Choose a folder for ${event.title}`}
                >
                    <Folder aria-hidden="true" />
                    {current && (
                        <>
                            <span>{current.name}</span>
                            <ChevronDown aria-hidden="true" />
                        </>
                    )}
                </Button>
                <Dropdown.Popover placement="bottom end" offset={4} className="ks-folder-picker ks-folder-dropdown" UNSTABLE_portalContainer={portalContainer}>
                    <label className="ks-folder-picker-search">
                        <span className="sr-only">Search folders</span>
                        <Input
                            variant="secondary"
                            ref={search}
                            value={query}
                            placeholder="Search"
                            maxLength={60}
                            disabled={busy}
                            onChange={changeEvent => setQuery(changeEvent.target.value)}
                            onKeyDown={keyEvent => {
                                if (keyEvent.key === 'ArrowDown') {
                                    keyEvent.preventDefault();
                                    menu.current?.querySelector('[role^="menuitem"]:not([aria-disabled="true"])')?.focus();
                                    return;
                                }
                                if (keyEvent.key !== 'Enter' || busy) return;
                                keyEvent.preventDefault();
                                if (visible.length && needle) choose(visible[0].id);
                                else if (canCreate) create();
                            }}
                        />
                        <Search aria-hidden="true" />
                    </label>
                    <Dropdown.Menu
                        ref={menu}
                        autoFocus={false}
                        className="ks-folder-picker-list"
                        aria-label={`Add ${event.title} to folder`}
                        shouldCloseOnSelect={false}
                        onAction={key => {
                            if (String(key).startsWith('folder:')) choose(String(key).slice(7));
                            else if (key === '__remove') choose(null);
                            else if (key === '__create') {
                                if (canCreate) create();
                                else { setQuery(suggestion); search.current?.focus(); }
                            }
                        }}
                    >
                        <Dropdown.Section selectionMode="single" selectedKeys={new Set(folderId ? [`folder:${folderId}`] : [])}>
                            <Header>Add to folder</Header>
                            {visible.map(folder => (
                                <Dropdown.Item key={folder.id} id={`folder:${folder.id}`} textValue={folder.name} isDisabled={busy}>
                                    <Folder className="ks-folder-icon" style={{ color: folder.color }} aria-hidden="true" />
                                    <Label>{folder.name}</Label>
                                    {folder.id === suggested?.id && folder.id !== folderId && <em>Suggested</em>}
                                    <small>{counts[folder.id] || 0}</small>
                                    <Dropdown.ItemIndicator className="ks-folder-picker-check" />
                                </Dropdown.Item>
                            ))}
                            {!visible.length && <Dropdown.Item id="__empty" textValue={needle ? 'No folders match' : 'No folders yet'} isDisabled className="ks-folder-picker-empty"><Label>{needle ? 'No folders match' : 'No folders yet'}</Label></Dropdown.Item>}
                        </Dropdown.Section>
                        <Separator />
                        <Dropdown.Section>
                            <Dropdown.Item id="__create" textValue={canCreate ? `New folder ${createName}` : 'New folder'} className="ks-folder-picker-create" isDisabled={busy}>
                                <FolderPlus aria-hidden="true" />
                                <Label>{canCreate ? `New folder “${createName}”` : 'New folder'}</Label>
                            </Dropdown.Item>
                            {current && (
                                <Dropdown.Item id="__remove" textValue="Remove from folder" className="ks-folder-picker-remove" isDisabled={busy}>
                                    <FolderMinus aria-hidden="true" /><Label>Remove from folder</Label>
                                </Dropdown.Item>
                            )}
                        </Dropdown.Section>
                    </Dropdown.Menu>
                    {error && <p className="ks-folder-picker-error" role="alert">{error}</p>}
                    {busy && <p className="ks-folder-picker-status" role="status">Updating folder…</p>}
                </Dropdown.Popover>
            </Dropdown>
            <Dialog open={Boolean(askSeries)} onOpenChange={next => { if (!next && !busy) { setAskSeries(null); setError(''); } }}>
                <DialogContent className="ks-folder-picker-series" portalContainer={portalContainer}>
                    <DialogTitle className="ks-folder-picker-title"><Repeat aria-hidden="true" />Auto-add future meetings?</DialogTitle>
                    <DialogDescription>Automatically put all future instances of this recurring meeting into {seriesFolder?.name || 'this folder'}.</DialogDescription>
                    <div className="ks-folder-picker-actions">
                        <Button type="button" variant="primary" className="ks-folder-picker-primary" isDisabled={busy} onPress={autoAdd}>{busy ? 'Updating…' : 'Auto-add'}</Button>
                        <Button type="button" variant="outline" className="ks-folder-picker-secondary" isDisabled={busy} onPress={() => { setAskSeries(null); setError(''); }}>No</Button>
                    </div>
                    {error && <p className="ks-folder-picker-error" role="alert">{error}</p>}
                </DialogContent>
            </Dialog>
        </div>
    );
}
