import React, { useState } from 'react';
import { FieldSelect } from '@/components/ui/field-select';
import { memoryScope } from '@/lib/chat';

const EMPTY = { kind: 'person', name: '', from: '', to: '' };

const ENTITY_KINDS = [{ value: 'person', label: 'Person' }, { value: 'company', label: 'Company' }, { value: 'topic', label: 'Topic' }, { value: 'project', label: 'Project' }];

export function MemoryFilters({ onApply, disabled }) {
    const [draft, setDraft] = useState(EMPTY);
    const [applied, setApplied] = useState(false);
    const [error, setError] = useState('');
    const change = (key, value) => setDraft(current => ({ ...current, [key]: value }));
    const apply = event => {
        event.preventDefault();
        try {
            memoryScope({ type: 'all' }, draft);
            onApply(draft);
            setApplied(Boolean(draft.name.trim() || draft.from || draft.to));
            setError('');
        } catch (cause) { setError(cause.message); }
    };
    return (
        <details className="ks-memory-filters">
            <summary>Filter meetings{applied ? ' · active' : ''}</summary>
            <form onSubmit={apply}>
                <label>Entity type<FieldSelect label="Memory entity type" value={draft.kind} disabled={disabled} onChange={value => change('kind', value)} options={ENTITY_KINDS} /></label>
                <label>Name<input aria-label="Memory entity name" placeholder="Exact name, e.g. Acme" maxLength={300} value={draft.name} disabled={disabled} onChange={event => change('name', event.target.value)} /></label>
                <label>From<input aria-label="Memory start date" type="date" value={draft.from} disabled={disabled} onChange={event => change('from', event.target.value)} /></label>
                <label>To<input aria-label="Memory end date" type="date" value={draft.to} disabled={disabled} onChange={event => change('to', event.target.value)} /></label>
                <button className="ks-text-button" type="submit" disabled={disabled}>Apply filters</button>
                <button className="ks-text-button" type="button" disabled={disabled} onClick={() => { setDraft(EMPTY); onApply(EMPTY); setApplied(false); setError(''); }}>Clear filters</button>
                <p>People come from transcript speaker labels. Other entities come from summaries; older transcripts remain searchable by question.</p>
                {error && <p role="alert">{error}</p>}
            </form>
        </details>
    );
}
