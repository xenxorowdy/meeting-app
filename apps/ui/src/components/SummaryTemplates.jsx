import React, { useEffect, useState } from 'react';
import { Check, ChevronDown, Plus, Search, Sparkles } from 'lucide-react';
import { MarkdownText } from './MarkdownText';

const STORAGE_KEY = 'kesami.summary-templates.v1';
const SECTIONS = { summary: 'Summary', decisions: 'Decisions', actions: 'Action items' };
const BUILT_INS = [
    { id: 'enhanced', name: 'Enhanced notes', sections: ['summary'] },
    { id: 'weekly', name: 'Weekly Team Meeting', sections: ['summary', 'actions', 'decisions'] },
    { id: 'one-to-one', name: '1 to 1', sections: ['summary', 'actions'] },
    { id: 'hiring', name: 'Hiring', sections: ['summary', 'decisions', 'actions'] },
    { id: 'pitch', name: 'VC: Pitch', sections: ['summary', 'decisions'] },
];
function readCustom() {
    try {
        const value = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
        return Array.isArray(value) ? value.filter(item => typeof item.id === 'string' && typeof item.name === 'string' && Array.isArray(item.sections) && item.sections.length && item.sections.every(section => SECTIONS[section])) : [];
    } catch { return []; }
}

export function useSummaryTemplate(meeting) {
    const [custom, setCustom] = useState(readCustom);
    const templates = [...BUILT_INS, ...custom];
    const key = `kesami.summary-template.${meeting?.id || 'none'}`;
    const [selectedId, setSelectedId] = useState(() => { try { return localStorage.getItem(key) || 'enhanced'; } catch { return 'enhanced'; } });
    useEffect(() => {
        const sync = () => { setCustom(readCustom()); try { setSelectedId(localStorage.getItem(key) || 'enhanced'); } catch { setSelectedId('enhanced'); } };
        sync(); window.addEventListener('kesami-summary-template-change', sync);
        return () => window.removeEventListener('kesami-summary-template-change', sync);
    }, [key]);
    const selected = templates.find(item => item.id === selectedId) || BUILT_INS[0];
    return { templates, selected, select: item => {
        localStorage.setItem(key, item.id);
        setSelectedId(item.id);
        window.dispatchEvent(new Event('kesami-summary-template-change'));
    }, add: item => {
        const next = [...custom, item];
        localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
        setCustom(next);
    } };
}

export function SummaryTemplatePicker({ model, disabled }) {
    const [query, setQuery] = useState('');
    const [creating, setCreating] = useState(false);
    const [name, setName] = useState('');
    const [sections, setSections] = useState(['summary', 'decisions', 'actions']);
    const [error, setError] = useState('');
    const [pending, setPending] = useState(false);
    const select = async (item, root) => {
        if (pending || disabled) return;
        setPending(true); setError('');
        try {
            model.select(item);
            root?.removeAttribute('open');
        } catch (cause) { setError(cause.message || 'Could not save template. Try again.'); }
        finally { setPending(false); }
    };
    return <details className="ks-template-picker" onKeyDown={event => { if (event.key === 'Escape') event.currentTarget.removeAttribute('open'); }}>
        <summary><Sparkles aria-hidden="true" />{model.selected.name}<ChevronDown aria-hidden="true" /></summary>
        <div className="ks-template-menu">
            {/* <p>Layouts for existing notes · saved on this computer</p>*/}
            <label className="ks-template-search"><Search aria-hidden="true" /><input aria-label="Search templates" placeholder="Templates" value={query} onChange={event => setQuery(event.target.value)} /></label>
            {model.templates.filter(item => item.name.toLowerCase().includes(query.toLowerCase())).map(item => <button type="button" key={item.id} disabled={disabled || pending} aria-pressed={model.selected.id === item.id} onClick={event => void select(item, event.currentTarget.closest('details'))}><span>{item.name}</span>{model.selected.id === item.id && <Check aria-hidden="true" />}</button>)}
            {!model.templates.some(item => item.name.toLowerCase().includes(query.toLowerCase())) && <p>No matching templates.</p>}
            <button type="button" disabled={disabled || pending} onClick={() => setCreating(value => !value)}><Plus aria-hidden="true" />New template</button>
            {creating && <form onSubmit={async event => {
                event.preventDefault(); const root = event.currentTarget.closest('details');
                if (!name.trim() || !sections.length || pending) return;
                try {
                    const item = { id: crypto.randomUUID(), name: name.trim(), sections };
                    model.add(item); await select(item, root); setCreating(false); setName('');
                } catch { setError('Could not store template on this computer.'); }
            }}>
                <input aria-label="Template name" maxLength={80} placeholder="Template name" value={name} onChange={event => setName(event.target.value)} required />
                {Object.entries(SECTIONS).map(([key, label]) => <label key={key}><input type="checkbox" checked={sections.includes(key)} onChange={event => setSections(current => event.target.checked ? [...current, key] : current.filter(item => item !== key))} />{label}</label>)}
                <button type="submit" disabled={!name.trim() || !sections.length || pending || disabled}>{pending ? 'Saving…' : 'Save template'}</button>
            </form>}
            {pending && <p role="status">Saving template…</p>}
            {error && <p role="alert">{error}</p>}
        </div>
    </details>;
}

export function SummaryTemplateContent({ template, meeting }) {
    return <div className="ks-template-content">{template.sections.map(section => <section key={section}>
        {template.id !== 'enhanced' && <h4>{SECTIONS[section]}</h4>}
        {section === 'summary' ? <MarkdownText className="ks-notes-prose" markdown={meeting.summaryMarkdown} /> : section === 'decisions' ? (meeting.keyDecisions?.length ? <ul>{meeting.keyDecisions.map((item, index) => <li key={index}>{item}</li>)}</ul> : <p>No decisions recorded.</p>) : (meeting.actionItems?.length ? <ul>{meeting.actionItems.map((item, index) => <li key={item.id || index}>{typeof item === 'string' ? item : <>{item.completed ? <><Check aria-hidden="true" /><span className="sr-only">Completed: </span></> : null}{item.task}{item.owner ? ` — ${item.owner}` : ''}{item.deadline ? ` · ${item.deadline}` : ''}</>}</li>)}</ul> : <p>No action items recorded.</p>)}
    </section>)}</div>;
}
