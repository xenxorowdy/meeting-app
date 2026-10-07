import React, { useEffect, useRef, useState } from 'react';
import { apiRequest } from '@/lib/backend';
import { formatMs } from '@/lib/speakers';

const LABELS = {
    explicit_commitment: 'Explicit commitment',
    suggested_action: 'Suggested action · no accepted owner',
    discussion: 'Discussion / hypothesis',
    other_person_commitment: 'Reported commitment by another person',
    unclear: 'Unclear statement',
};
const actionable = item => ['explicit_commitment', 'suggested_action', 'other_person_commitment'].includes(item.classification);

function ReviewCard({ item, revision, busy, disabled, onReview, onSource }) {
    const [person, setPerson] = useState(item.reviewedPerson || item.person || '');
    const [action, setAction] = useState(item.reviewedAction || item.targetAction || '');
    const [reviewing, setReviewing] = useState(false);
    const pending = item.status === 'pending';
    const confirm = event => {
        event.preventDefault();
        onReview(item.id, { status: 'confirmed', transcriptRevision: revision, person: person.trim(), targetAction: action.trim() });
    };
    return (
        <article className="ks-commitment" data-classification={item.classification} data-status={item.status}>
            <header><strong>{item.reviewedPerson || item.person || 'Owner not established'}</strong><span>{LABELS[item.classification]}</span></header>
            <h3>{item.reviewedAction || item.targetAction}</h3>
            <p className="ks-commitment-meta">Due: {item.dueDate || 'No explicit date detected'} <span>Confidence: {item.confidence === 'high' ? 'High' : item.confidence === 'medium' ? 'Medium' : 'Low'}</span></p>
            {item.references?.length > 0 && <p className="ks-chat-note">Mentioned: {item.references.map(ref => `${ref.name} (${ref.kind})`).join(', ')}</p>}
            <blockquote>“{item.commitment}”</blockquote>
            <button type="button" className="ks-text-button" onClick={() => onSource(item)}>Transcript · {item.speaker || 'Unknown speaker'} · {formatMs(item.startMs)}</button>
            <p className="ks-chat-note">{item.confidenceReason}</p>
            {!pending && <p role="status">{item.status === 'confirmed' ? 'Confirmed · saved to action items' : 'Dismissed'}</p>}
            {pending && (
                <div className="ks-commitment-controls">
                    {actionable(item) && !reviewing && <button type="button" className="ks-button" disabled={busy || disabled} onClick={() => setReviewing(true)}>Review {item.classification === 'suggested_action' ? 'suggestion' : 'commitment'}</button>}
                    {!reviewing && <button type="button" className="ks-text-button" disabled={busy || disabled} onClick={() => onReview(item.id, { status: 'dismissed', transcriptRevision: revision })}>Dismiss</button>}
                    {reviewing && (
                        <form onSubmit={confirm}>
                            <label>Person responsible<input aria-label="Commitment person" required maxLength={200} value={person} disabled={busy || disabled} onChange={event => setPerson(event.target.value)} /></label>
                            <label>Target action<input aria-label="Commitment target action" required maxLength={1000} value={action} disabled={busy || disabled} onChange={event => setAction(event.target.value)} /></label>
                            <p className="ks-chat-note">{item.classification === 'suggested_action' ? 'Assign an owner only after confirming they accepted this suggestion. ' : 'Check who made the promise and what they agreed to do. '}This saves a local task.</p>
                            <div><button className="ks-button ks-primary" type="submit" disabled={busy || disabled || !person.trim() || !action.trim()}>{busy ? 'Saving…' : 'Confirm & add action'}</button><button type="button" className="ks-text-button" disabled={busy} onClick={() => setReviewing(false)}>Cancel review</button></div>
                        </form>
                    )}
                </div>
            )}
        </article>
    );
}

export function MeetingCommitments({ meeting, isConnected, disabled, onUpdate, onSource }) {
    const [data, setData] = useState(null);
    const [loading, setLoading] = useState(true);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const [attempt, setAttempt] = useState(0);
    const requestRef = useRef(0);
    useEffect(() => {
        const request = ++requestRef.current;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 10000);
        setLoading(true);
        setError('');
        apiRequest(`/api/meetings/${encodeURIComponent(meeting.id)}/commitments`, { signal: controller.signal })
            .then(response => { if (requestRef.current === request) setData(response); })
            .catch(cause => { if (requestRef.current === request) setError(controller.signal.aborted ? 'Loading took too long. Retry when Kesami is connected.' : cause.message); })
            .finally(() => { clearTimeout(timer); if (requestRef.current === request) setLoading(false); });
        return () => { ++requestRef.current; controller.abort(); clearTimeout(timer); };
    }, [meeting.id, meeting.transcript, attempt]);
    const mutate = async (id = null, review = {}) => {
        if (busy) return;
        const request = requestRef.current;
        setBusy(true);
        setError('');
        try {
            const result = await onUpdate?.(id, review);
            if (requestRef.current !== request) return;
            if (!result?.ok) throw new Error(result?.message || 'Kesami did not save the review. Retry.');
            const memory = result.meeting.metadata.meetingCommitments;
            setData({ ...memory, current: true });
        } catch (cause) { if (requestRef.current === request) setError(cause.message); }
        finally { setBusy(false); }
    };
    const items = data?.current ? data.candidates || [] : [];
    const primary = items.filter(actionable);
    const other = items.filter(item => !actionable(item));
    return (
        <div className="ks-detail-scroll">
            <section className="ks-commitments">
                <header><div><h2>Meeting commitments</h2><p>Review who promised what, then confirm an action item.</p></div><button type="button" className="ks-button" disabled={loading || busy || disabled || !isConnected || !meeting.transcript?.length} onClick={() => mutate()}>{busy ? 'Saving…' : data?.current ? 'Detect again' : 'Detect commitments'}</button></header>
                <p className="ks-chat-note">Detection runs locally with conservative English cues. Confidence describes the wording; speaker labels need review. Dates stay as spoken in this meeting. Actions are saved locally after confirmation.</p>
                {!isConnected && <p role="status" className="ks-chat-note">Reconnect to load or save your review.</p>}
                {disabled && <p role="status" className="ks-chat-note">Wait for meeting processing to finish before reviewing.</p>}
                {loading && <p role="status">Loading commitments…</p>}
                {error && <div role="alert"><p>{error}</p><button type="button" className="ks-text-button" disabled={busy || loading} onClick={() => setAttempt(value => value + 1)}>Retry loading</button></div>}
                {!loading && !error && !data?.current && <p className="ks-commitment-empty">{meeting.transcript?.length ? 'Detect commitments from this transcript. If speakers changed, detect again to review the updated sources.' : 'No transcript is available yet.'}</p>}
                {!loading && data?.current && !primary.length && <p className="ks-commitment-empty">No clear commitments or suggestions detected. Future-looking speech alone is not a promise.</p>}
                {data?.coverage === 'partial' && <p role="status" className="ks-chat-note">Detection covered part of this transcript. Long passages or remaining statements may need manual review.</p>}
                {primary.map(item => <ReviewCard key={`${item.id}-${item.status}`} item={item} revision={data.transcriptRevision} busy={busy} disabled={loading || disabled || !isConnected} onReview={mutate} onSource={onSource} />)}
                {other.length > 0 && <details className="ks-commitment-other"><summary>Discussion & unclear statements ({other.length})</summary>{other.map(item => <ReviewCard key={`${item.id}-${item.status}`} item={item} revision={data.transcriptRevision} busy={busy} disabled={loading || disabled || !isConnected} onReview={mutate} onSource={onSource} />)}</details>}
            </section>
        </div>
    );
}
