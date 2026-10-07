import React, { useEffect, useState } from 'react';
import { useMeetingActions } from '@/hooks/useMeetingActions';
import { SummarySharing } from '@/components/SummarySharing';
import { copyToClipboard } from '@/lib/clipboard';
import { formatMs } from '@/lib/speakers';

const TYPES = { action_item: 'Action item', commitment: 'Commitment', follow_up: 'Follow-up', calendar: 'Calendar suggestion', email: 'Email follow-up', jira: 'Jira suggestion', summary_slack: 'Share summary to Slack', summary_jira: 'Create Jira recap' };
const CLASSIFICATIONS = { explicit_commitment: 'Explicit promise', other_person_commitment: 'Reported promise by another person', suggested_action: 'Suggestion · acceptance needs review', extracted_action: 'Extracted or edited task · review required', generated_draft: 'AI draft · check every claim', generated_summary: 'AI summary · check every claim' };
const DESTINATIONS = { local_task: 'Save local task', local_draft: 'Create local email draft', google_calendar: 'Add to Google Calendar', jira: 'Create Jira ticket', slack: 'Post summary to Slack' };

function ActionCard({ item, record, busy, disabled, onConfirm, onSource, onSettings, providers }) {
    const [reviewing, setReviewing] = useState(false);
    const [fields, setFields] = useState(() => ({ destination: item.destination, title: item.title, person: item.person || '', dueDate: item.dueDate || '', body: item.body || '', recipients: '', start: '', end: '' }));
    const [confirmed, setConfirmed] = useState(false);
    const [copyState, setCopyState] = useState(''), [formError, setFormError] = useState('');
    const change = key => event => { setFields(value => ({ ...value, [key]: event.target.value })); setConfirmed(false); };
    const status = record?.status;
    const blocked = status === 'succeeded' || status === 'executing' || status === 'unknown';
    const sourceChanged = blocked && record?.source?.revision !== item.revision;
    const external = ['jira', 'google_calendar', 'slack'].includes(fields.destination);
    const summary = item.kind?.startsWith('summary_');
    const destinations = summary ? [[item.destination, item.destination === 'jira' ? 'Create one Jira recap issue' : DESTINATIONS.slack]] : Object.entries(DESTINATIONS).filter(([id]) => id !== 'slack');
    const target = providers?.[fields.destination];
    const bodyBytes = new TextEncoder().encode(fields.body).length;
    useEffect(() => { setConfirmed(false); }, [target?.revision]);
    const submit = async event => {
        event.preventDefault(); setFormError('');
        const payload = { ...fields, confirmed, revision: item.revision, providerRevision: external ? target?.revision || '' : '', person: fields.destination === 'local_task' ? fields.person : '', dueDate: fields.destination === 'local_task' ? fields.dueDate : '', body: fields.destination === 'local_task' ? '' : fields.body, recipients: ['local_draft', 'google_calendar'].includes(fields.destination) ? fields.recipients.split(/[,;]/).map(s => s.trim()).filter(Boolean) : [], start: '', end: '' };
        if (fields.destination === 'google_calendar') {
            const start = new Date(fields.start), end = new Date(fields.end);
            if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end <= start) { setFormError('Choose valid start and end times; the event must end after it starts.'); return; }
            payload.start = start.toISOString(); payload.end = end.toISOString();
        }
        if (await onConfirm(item.id, payload)) { setReviewing(false); setConfirmed(false); }
    };
    return <article className="ks-commitment ks-action" data-action-kind={item.kind} data-action-status={status || 'suggested'}>
        <header><strong>{TYPES[item.kind] || 'Suggested action'}</strong><span>{CLASSIFICATIONS[item.classification] || 'Reviewed suggestion'}</span></header>
        <h3>{status === 'succeeded' ? record.review?.title || item.title : item.title}</h3>
        {!summary && <p className="ks-commitment-meta">{(status === 'succeeded' ? record.review?.person || record.source?.person : item.person) || 'Owner needs review'} · Due: {(status === 'succeeded' ? record.review?.dueDate || record.source?.dueDate : item.dueDate) || 'No explicit date detected'}</p>}
        {item.excerpt && !sourceChanged ? <><blockquote>“{item.excerpt}”</blockquote><button className="ks-text-button" type="button" onClick={() => onSource(item)}>Transcript source · {formatMs(item.startMs || 0)}</button></> : <p className="ks-chat-note">{sourceChanged ? 'Meeting sources changed after this confirmation. The saved action is historical; check the latest transcript before drawing conclusions.' : summary ? 'Review the generated recap before sharing. Only the reviewed text is shared; other meeting fields are not attached.' : 'No verified transcript excerpt for this item. Check the transcript and review the content.'}</p>}
        {summary && <details><summary>{blocked ? 'View confirmed summary' : 'Preview summary'}</summary><pre className="ks-action-draft">{blocked ? record?.review?.body : item.body}</pre></details>}
        {summary && item.destination === 'slack' && providers?.slack?.autoPush && <p className="ks-chat-note">Automatic Slack notes sharing is enabled. This meeting may already have been posted; check the channel before confirming a manual post.</p>}
        {status === 'succeeded' && <p role="status">{record.review?.destination === 'local_draft' ? 'Draft saved locally · not sent' : record.review?.destination === 'local_task' ? 'Task saved locally' : record.review?.destination === 'jira' ? 'Created in Jira' : record.review?.destination === 'slack' ? 'Summary posted to Slack' : 'Created in Google Calendar'}</p>}
        {status === 'succeeded' && typeof record.result?.url === 'string' && /^https:\/\//.test(record.result.url) && <a className="ks-text-button" href={record.result.url} target="_blank" rel="noopener noreferrer">Open created {record.review?.destination === 'jira' ? 'ticket' : 'event'}</a>}
        {['executing', 'unknown'].includes(status) && <p role="status">{status === 'executing' ? 'Dispatch was recorded; a receipt is pending or the attempt was interrupted.' : 'The provider outcome is unknown.'} Check the provider before taking further action. Kesami will not resend this action.</p>}
        {record?.error && <div role="alert"><p>{record.error.message}</p>{record.error.code === 'permission_required' && <button type="button" className="ks-text-button" onClick={() => onSettings?.(fields.destination === 'google_calendar' ? 'calendar' : 'connectors')}>Open Settings</button>}</div>}
        {record?.result?.draft && <details><summary>View saved draft</summary><p>To: {record.result.draft.recipients.join(', ')}</p><strong>{record.result.draft.subject}</strong><pre className="ks-action-draft">{record.result.draft.body}</pre><button type="button" className="ks-text-button" onClick={async () => { try { await copyToClipboard(`${record.result.draft.subject}\n\n${record.result.draft.body}`); setCopyState('Draft copied'); } catch { setCopyState('Could not copy. Select the draft text.'); } }}>Copy draft</button><p role="status">{copyState}</p></details>}
        {!blocked && !reviewing && <button className="ks-button" type="button" disabled={busy || disabled} onClick={() => setReviewing(true)}>{status === 'failed' ? 'Review & retry' : 'Review'}</button>}
        {reviewing && !blocked && <form className="ks-action-form" onSubmit={submit}>
            <label>Destination<select aria-label="Action destination" value={fields.destination} disabled={busy} onChange={change('destination')}>{destinations.map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label>
            {external && <p className="ks-chat-note">{fields.destination === 'slack' ? `Slack · ${target?.channelLabel || 'Channel configured by the incoming webhook'} (label only; does not select a channel)` : fields.destination === 'jira' ? `Jira · ${target?.siteUrl || 'Not configured'} · Project: ${target?.projectKey || 'Not configured'} · Type: ${target?.issueType || 'Task'}` : `Google Calendar · primary calendar · ${target?.account || 'Not connected'}`}<br />{target?.connected ? fields.destination === 'slack' ? 'Webhook configured. Verify its channel in Slack.' : `Connected as ${target.account || 'configured account'}` : 'Connect this provider in Settings before creation.'}{!target?.connected && <><br /><button type="button" className="ks-text-button" onClick={() => onSettings?.(fields.destination === 'google_calendar' ? 'calendar' : 'connectors')}>Open Settings</button></>}</p>}
            {formError && <p role="alert">{formError}</p>}
            <label>{fields.destination === 'local_draft' ? 'Email subject' : 'Action title'}<input aria-label="Action title" required maxLength={250} value={fields.title} disabled={busy} onChange={change('title')} /></label>
            {fields.destination === 'local_task' && <><label>Person responsible<input aria-label="Action owner" required maxLength={120} value={fields.person} disabled={busy} onChange={change('person')} /></label><label>Due date as stated<input aria-label="Action due date" maxLength={100} value={fields.dueDate} disabled={busy} onChange={change('dueDate')} /></label></>}
            {['local_draft', 'google_calendar'].includes(fields.destination) && <label>{fields.destination === 'local_draft' ? 'Recipients' : 'Invitees (optional)'}<input aria-label="Action recipients" required={fields.destination === 'local_draft'} placeholder="person@company.com, …" value={fields.recipients} disabled={busy} onChange={change('recipients')} /></label>}
            {fields.destination === 'google_calendar' && <><p className="ks-chat-note">Choose exact dates and times in your device timezone. Dates such as “next Tuesday” are not resolved automatically. Google Calendar will invite the email addresses you enter.</p><label>Start<input aria-label="Action start" type="datetime-local" required value={fields.start} disabled={busy} onChange={change('start')} /></label><label>End<input aria-label="Action end" type="datetime-local" required min={fields.start || undefined} value={fields.end} disabled={busy} onChange={change('end')} /></label></>}
            {fields.destination !== 'local_task' && <label>{fields.destination === 'local_draft' ? 'Email body' : 'Description shared with provider'}<textarea aria-label="Action body" required={fields.destination === 'local_draft' || summary || fields.destination === 'slack'} maxLength={20000} rows={summary ? 10 : 5} value={fields.body} disabled={busy} onChange={change('body')} />{bodyBytes > 20000 && <span role="alert">Shorten the text to fit the 20 KB sharing limit before confirming.</span>}</label>}
            <p className="ks-chat-note">{external ? 'The reviewed content above will be shared with the displayed provider destination. Configure the connection in Settings first.' : fields.destination === 'local_draft' ? 'This creates a local draft. It does not send email or open an email account.' : 'Confirm the owner accepted the task. This saves a local action item.'}</p>
            <label className="ks-action-confirm"><input aria-label="Confirm reviewed action" type="checkbox" checked={confirmed} disabled={busy || disabled} onChange={event => setConfirmed(event.target.checked)} />I reviewed the content and destination and confirm this action.</label>
            <div className="ks-commitment-controls"><button className="ks-button ks-primary" type="submit" disabled={busy || disabled || !confirmed || (fields.destination !== 'local_task' && bodyBytes > 20000)}>{busy ? 'Saving…' : summary && fields.destination === 'jira' ? 'Create one Jira recap issue' : DESTINATIONS[fields.destination]}</button><button className="ks-text-button" type="button" disabled={busy} onClick={() => { setReviewing(false); setConfirmed(false); }}>Cancel review</button></div>
        </form>}
    </article>;
}

export function MeetingActions({ meeting, isConnected, disabled, onUpdate, onSource, onSettings }) {
    const flow = useMeetingActions({ meeting, isConnected, disabled, onUpdate });
    const { data, loading, busy, error, refresh, confirm } = flow;
    const history = data?.history || [], suggestions = data?.suggestions || [];
    const previous = history.filter(record => !suggestions.some(item => item.id === record.id));
    return <div className="ks-detail-scroll"><section className="ks-commitments ks-actions">
        <header><div><h2>After this meeting</h2><p>Review suggested actions, then choose what to do.</p></div><button className="ks-text-button" type="button" disabled={loading || busy} onClick={refresh}>Refresh actions</button></header>
        <p className="ks-chat-note">Review suggested tasks before saving or creating them in your tools.</p>
        {!isConnected && <p role="status">Reconnect to load or confirm actions.</p>}{disabled && <p role="status">Wait for meeting processing to finish.</p>}
        {loading && <p role="status">Loading actions…</p>}
        {data?.coverage === 'partial' && <p role="status" className="ks-chat-note">Showing a limited set of suggestions. Review the remaining transcript and tasks manually.</p>}
        {error && <div role="alert"><p>{error}</p><button className="ks-text-button" type="button" disabled={busy || loading} onClick={refresh}>Reload actions</button></div>}
        {!loading && !error && !suggestions.length && !history.length && <p className="ks-commitment-empty">No suggested actions yet. Review the meeting’s commitments or add a task in Summary.</p>}
        {suggestions.some(item => item.kind.startsWith('summary_')) && <SummarySharing meeting={meeting} isConnected={isConnected} disabled={disabled} onUpdate={onUpdate} onSettings={onSettings} controller={flow} compact />}
        {suggestions.filter(item => !item.kind.startsWith('summary_')).map(item => <ActionCard key={`${item.id}-${item.revision}-${history.find(r => r.id === item.id)?.status || ''}`} item={item} record={history.find(r => r.id === item.id)} busy={busy} disabled={disabled || !isConnected || loading || Boolean(error)} onConfirm={confirm} onSource={onSource} onSettings={onSettings} providers={data?.providers} />)}
        {previous.length > 0 && <details className="ks-commitment-other"><summary>Previous action history ({previous.length})</summary><p className="ks-chat-note">Saved confirmations are historical. Their original meeting sources may have changed.</p>{previous.map(record => <ActionCard key={record.id} item={{ ...record.source, sourceTurnIds: [], excerpt: '', title: record.review.title }} record={record} busy={busy} disabled onConfirm={confirm} onSource={onSource} onSettings={onSettings} providers={data?.providers} />)}</details>}
    </section></div>;
}
