import React, { useCallback, useEffect, useState } from 'react';
import { ArrowUpRight, Check, FileText, Loader2, MessageSquare, RefreshCw } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useMeetingActions } from '@/hooks/useMeetingActions';

const PROVIDERS = [
    { id: 'slack', label: 'Slack', icon: MessageSquare, action: 'Post to Slack' },
    { id: 'jira', label: 'Jira', icon: FileText, action: 'Create Jira recap' },
];
const isBlocked = record => ['succeeded', 'executing', 'unknown'].includes(record?.status);

export function SummarySharing({ meeting, isConnected, disabled, onUpdate, onSettings, controller, compact = false }) {
    const [open, setOpen] = useState(false), [selected, setSelected] = useState('slack');
    const [drafts, setDrafts] = useState({}), [confirmed, setConfirmed] = useState(false);
    const [portalContainer, setPortalContainer] = useState();
    const bindHost = useCallback(node => { if (node) setPortalContainer(node.closest('.ks-app') || undefined); }, []);
    const own = useMeetingActions({ meeting, isConnected, disabled, onUpdate, enabled: !controller && open });
    const flow = controller || own;
    const { data, loading, busy, error, refresh, confirm } = flow;
    const item = data?.suggestions?.find(suggestion => suggestion.kind === `summary_${selected}`);
    const record = data?.history?.find(entry => entry.source?.kind === `summary_${selected}`);
    const target = data?.providers?.[selected];
    const blocked = isBlocked(record);
    const sourceChanged = Boolean(record && (!item || record.source?.revision !== item.revision));
    const draft = item && drafts[item.id];
    const draftStale = Boolean(draft && item && draft.revision !== item.revision);
    const fields = blocked ? record.review : draft?.revision === item?.revision ? draft : item;
    const provider = PROVIDERS.find(entry => entry.id === selected);
    const bodyBytes = new TextEncoder().encode(fields?.body || '').length;
    const titleBytes = new TextEncoder().encode(fields?.title || '').length;
    const ready = item && fields?.title?.trim() && fields?.body?.trim() && bodyBytes <= 20000 && titleBytes <= 250;
    const unavailable = !isConnected || disabled || loading || busy || Boolean(error);

    useEffect(() => { setConfirmed(false); }, [open, selected, item?.revision, target?.revision]);
    const choose = destination => { setSelected(destination); setConfirmed(false); };
    const show = destination => { choose(destination); setOpen(true); if (controller) refresh(); };
    const change = key => event => {
        const value = event.target.value;
        setDrafts(current => ({ ...current, [item.id]: { ...fields, revision: item.revision, [key]: value } }));
        setConfirmed(false);
    };
    const settings = () => { setOpen(false); onSettings?.('connectors'); };
    const submit = async event => {
        event.preventDefault();
        if (!confirmed || !ready || blocked || unavailable || !target?.connected) return;
        setConfirmed(false);
        await confirm(item.id, {
            confirmed: true, revision: item.revision, destination: selected,
            title: fields.title, body: fields.body, providerRevision: target.revision,
        });
    };
    const targetLabel = selected === 'slack'
        ? target?.channelLabel || 'Configured webhook channel'
        : target?.projectKey ? `${target.projectKey} · ${target.issueType || 'Task'}` : 'No project configured';
    const done = record?.status === 'succeeded';
    const statusText = done ? selected === 'slack' ? 'Summary posted to Slack' : 'Created in Jira'
        : blocked ? 'Check delivery in your tool' : target?.connected ? targetLabel : 'Connect to share';

    return <>
        {compact ? <section ref={bindHost} className="ks-summary-sharing" aria-label="Share meeting summary">
            <div><h3>Share the recap</h3><p>Review once, then send to your team.</p></div>
            <div className="ks-share-options">
                {PROVIDERS.map(entry => {
                    const saved = data?.history?.find(row => row.source?.kind === `summary_${entry.id}`);
                    const Icon = saved?.status === 'succeeded' ? Check : entry.icon;
                    const connection = data?.providers?.[entry.id];
                    return <button className="ks-share-option" type="button" key={entry.id} onClick={() => show(entry.id)} disabled={busy || !isConnected || disabled}>
                        <Icon aria-hidden="true" /><span><strong>{entry.label}</strong><small>{saved?.status === 'succeeded' ? 'Shared · view receipt' : isBlocked(saved) ? 'Check delivery' : connection?.connected ? entry.id === 'slack' ? connection.channelLabel || 'Review summary' : connection.projectKey || 'Review summary' : loading ? 'Loading connection…' : 'Connect to share'}</small></span><ArrowUpRight aria-hidden="true" />
                    </button>;
                })}
            </div>
        </section> : <button ref={bindHost} className="ks-summary-edit" type="button" disabled={!isConnected || disabled} onClick={() => show(selected)}><ArrowUpRight aria-hidden="true" /> Share summary</button>}
        <Dialog open={open} onOpenChange={next => { if (!busy) setOpen(next); }}>
            <DialogContent portalContainer={portalContainer} className="ks-share-dialog" onEscapeKeyDown={event => { if (busy) event.preventDefault(); }} onPointerDownOutside={event => { if (busy) event.preventDefault(); }}>
                <DialogHeader className="ks-share-heading">
                    <DialogTitle>Share summary</DialogTitle>
                    <DialogDescription>Review your recap and choose where to share it.</DialogDescription>
                </DialogHeader>
                <div className="ks-share-switch" role="group" aria-label="Summary destination">
                    {PROVIDERS.map(entry => <button type="button" key={entry.id} aria-pressed={selected === entry.id} disabled={busy} onClick={() => choose(entry.id)}><entry.icon aria-hidden="true" />{entry.label}</button>)}
                </div>
                <div className="ks-share-scroll" aria-busy={loading || busy}>
                    {!isConnected && <p role="status" className="ks-share-notice">Reconnect to load or share this summary.</p>}
                    {disabled && <p role="status" className="ks-share-notice">Your meeting is still processing. Sharing will be available when it finishes.</p>}
                    {loading && <p className="ks-share-loading" role="status"><Loader2 aria-hidden="true" />{data ? 'Checking connection…' : 'Preparing your recap…'}</p>}
                    {error && <div role="alert" className="ks-share-notice"><p>{error}</p><button className="ks-text-button" type="button" disabled={busy || loading} onClick={refresh}>Reload summary</button></div>}
                    {!loading && !error && !item && !record && <p className="ks-share-notice">No summary is available yet. Generate a summary before sharing.</p>}
                    {(item || record) && <form className="ks-share-form" data-action-kind={`summary_${selected}`} data-action-status={record?.status || 'suggested'} onSubmit={submit}>
                        <div className="ks-share-target">
                            <provider.icon aria-hidden="true" /><div><strong>{provider.label} · {targetLabel}</strong><p>{selected === 'slack' ? 'Uses the channel assigned to your webhook.' : `${target?.siteUrl || 'Connect your Jira site'}${target?.account ? ` · ${target.account}` : ''}`}</p></div>
                            {!blocked && <button className="ks-text-button" type="button" disabled={busy} onClick={settings}>{target?.connected ? 'Change' : `Connect ${provider.label}`}</button>}
                        </div>
                        {(sourceChanged || draftStale) && <p className="ks-share-notice" role="status">The meeting changed after this review. {blocked ? 'The saved recap below is historical.' : 'Review the latest recap before sharing again.'}</p>}
                        {selected === 'slack' && target?.autoPush && !blocked && <p className="ks-share-notice">Automatic Slack sharing is enabled. Check the channel before posting another recap.</p>}
                        {record?.error && <div className="ks-share-notice" role="alert"><p>{record.error.message}</p>{record.error.code === 'permission_required' && !blocked && <button className="ks-text-button" type="button" onClick={settings}>Reconnect {provider.label}</button>}</div>}
                        {blocked && <p className={`ks-share-result${done ? ' is-success' : ''}`} role="status">{done ? <Check aria-hidden="true" /> : null}{statusText}{!done && '. The outcome is pending or uncertain. Check the provider before taking further action; this recap will not be resent.'}</p>}
                        <label>{selected === 'jira' ? 'Issue title' : 'Title'}<input aria-label="Summary title" required maxLength={250} value={fields?.title || ''} readOnly={blocked} disabled={busy || loading || !item && !blocked} onChange={change('title')} /></label>
                        <label>Summary<textarea aria-label="Summary body" required maxLength={20000} rows={8} value={fields?.body || ''} readOnly={blocked} disabled={busy || loading || !item && !blocked} onChange={change('body')} /></label>
                        <div className="ks-share-content-note"><span>AI-generated · review important details</span><span>{(bodyBytes / 1000).toFixed(1)} / 20 KB</span></div>
                        {(bodyBytes > 20000 || titleBytes > 250) && !blocked && <p className="ks-share-notice" role="alert">Shorten the text to fit the 20 KB summary and 250-byte title limits.</p>}
                        {!blocked && <div className="ks-share-footer">
                            <label className="ks-action-confirm"><input aria-label="Confirm reviewed summary" type="checkbox" checked={confirmed} disabled={unavailable || !ready || !target?.connected} onChange={event => setConfirmed(event.target.checked)} />I reviewed this summary and destination.</label>
                            <div><span>Only the text above is shared.</span><button className="ks-button ks-primary" type="submit" disabled={unavailable || !ready || !confirmed || !target?.connected}>{busy ? <><Loader2 aria-hidden="true" />Sharing…</> : provider.action}</button></div>
                        </div>}
                        {done && <div className="ks-share-footer"><p>Saved {record.finishedAt ? new Date(record.finishedAt).toLocaleString() : 'in meeting history'}. This recap will not be sent again.</p><div>{typeof record.result?.url === 'string' && /^https:\/\//.test(record.result.url) && <a className="ks-button" href={record.result.url} target="_blank" rel="noopener noreferrer">Open Jira issue<ArrowUpRight aria-hidden="true" /></a>}<button className="ks-button" type="button" onClick={() => setOpen(false)}>Done</button></div></div>}
                    </form>}
                </div>
                <div className="ks-share-bottom"><span>Draft edits stay here while this meeting is open.</span><button className="ks-text-button" type="button" disabled={loading || busy} aria-label="Refresh summary connection" onClick={refresh}><RefreshCw aria-hidden="true" />Refresh</button></div>
            </DialogContent>
        </Dialog>
    </>;
}
