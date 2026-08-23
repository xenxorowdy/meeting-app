import React, { useState } from 'react';
import { Sparkles, ListChecks, Mail, Copy, Check, Plus, Trash2, RotateCw, Award, CircleAlert, User, Calendar } from 'lucide-react';
import { cn } from '@/utils/cn';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { MarkdownText } from '@/components/MarkdownText';

function PanelHeading({ children, trailing }) {
    return (
        <div className="flex items-center justify-between gap-3">
            <h4 className="text-headline font-semibold">{children}</h4>
            {trailing}
        </div>
    );
}

export function SummaryEditor({ meeting, onUpdateMeeting, onRegenerateSummary, isGenerating = false }) {
    const [activeTab, setActiveTab] = useState('summary');
    const [isEditingSummary, setIsEditingSummary] = useState(false);
    const [summaryDraft, setSummaryDraft] = useState(meeting?.summaryMarkdown || '');

    const [newDecision, setNewDecision] = useState('');

    const [newActionTask, setNewActionTask] = useState('');
    const [newActionOwner, setNewActionOwner] = useState('You');
    const [newActionDeadline, setNewActionDeadline] = useState('Next week');

    const [emailCopied, setEmailCopied] = useState(false);
    const [allCopied, setAllCopied] = useState(false);

    if (!meeting) {
        return (
            <section className="flex h-full min-h-[300px] flex-col items-center justify-center rounded-xl border bg-card p-6 text-center shadow-card">
                <div className="mb-3 flex size-11 items-center justify-center rounded-xl bg-primary/[0.14] text-primary">
                    <Sparkles className="size-5" aria-hidden="true" />
                </div>
                <h3 className="text-title3 font-semibold">No notes yet</h3>
                <p className="mt-1 max-w-xs text-callout text-muted-foreground">
                    Record a meeting, or pick one from History, to see its summary, decisions, and action items here.
                </p>
            </section>
        );
    }

    const handleSaveSummary = () => {
        if (onUpdateMeeting) {
            onUpdateMeeting({ summaryMarkdown: summaryDraft });
        }
        setIsEditingSummary(false);
    };

    const handleAddDecision = event => {
        event.preventDefault();
        if (!newDecision.trim()) return;
        const current = meeting.keyDecisions || [];
        const updated = [...current, newDecision.trim()];
        if (onUpdateMeeting) onUpdateMeeting({ keyDecisions: updated });
        setNewDecision('');
    };

    const handleRemoveDecision = index => {
        const current = meeting.keyDecisions || [];
        const updated = current.filter((_, i) => i !== index);
        if (onUpdateMeeting) onUpdateMeeting({ keyDecisions: updated });
    };

    const handleToggleAction = actionId => {
        const current = meeting.actionItems || [];
        const updated = current.map((item, idx) => {
            const id = typeof item === 'object' ? item.id || `act-${idx}` : `act-${idx}`;
            if (id === actionId) {
                if (typeof item === 'object') {
                    return { ...item, completed: !item.completed };
                }
                return { task: item, owner: 'You', completed: true };
            }
            return item;
        });
        if (onUpdateMeeting) onUpdateMeeting({ actionItems: updated });
    };

    const handleAddAction = event => {
        event.preventDefault();
        if (!newActionTask.trim()) return;
        const current = meeting.actionItems || [];
        const newItem = {
            id: `act-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
            task: newActionTask.trim(),
            owner: newActionOwner.trim() || 'You',
            deadline: newActionDeadline.trim() || 'TBD',
            completed: false,
        };
        if (onUpdateMeeting) onUpdateMeeting({ actionItems: [...current, newItem] });
        setNewActionTask('');
    };

    const handleRemoveAction = actionId => {
        const current = meeting.actionItems || [];
        const updated = current.filter((item, idx) => {
            const id = typeof item === 'object' ? item.id || `act-${idx}` : `act-${idx}`;
            return id !== actionId;
        });
        if (onUpdateMeeting) onUpdateMeeting({ actionItems: updated });
    };

    const handleCopyEmail = () => {
        if (!meeting.emailDraft) return;
        navigator.clipboard.writeText(meeting.emailDraft);
        setEmailCopied(true);
        setTimeout(() => setEmailCopied(false), 2000);
    };

    const handleCopyAllNotes = () => {
        const decisionsMd = (meeting.keyDecisions || []).map(d => `- ${d}`).join('\n');
        const actionsMd = (meeting.actionItems || [])
            .map(a => {
                if (typeof a === 'string') return `- [ ] ${a}`;
                return `- [${a.completed ? 'x' : ' '}] ${a.task} (**${a.owner}**, Due: ${a.deadline})`;
            })
            .join('\n');

        const fullDoc = `# ${meeting.title}\n\n## Executive Summary\n${meeting.summaryMarkdown}\n\n## Key Decisions\n${decisionsMd}\n\n## Action Items\n${actionsMd}\n\n## Follow-up Email\n${meeting.emailDraft}`;
        navigator.clipboard.writeText(fullDoc);
        setAllCopied(true);
        setTimeout(() => setAllCopied(false), 2000);
    };

    const decisions = meeting.keyDecisions || [];
    const actionItems = meeting.actionItems || [];
    const actionCount = actionItems.length;
    const completedActionCount = actionItems.filter(a => typeof a === 'object' && a.completed).length;

    return (
        <Tabs value={activeTab} onValueChange={setActiveTab} asChild>
            <section aria-label="Meeting notes" className="flex h-full flex-col overflow-hidden rounded-xl border bg-card shadow-card">
                <div className="flex flex-col gap-3 p-3 hairline-bottom sm:p-4">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                        <div className="flex items-center gap-2.5">
                            <div className="flex size-8 items-center justify-center rounded-lg bg-primary/[0.14] text-primary">
                                <Sparkles className="size-4" aria-hidden="true" />
                            </div>
                            <div>
                                <h3 className="text-headline font-semibold">Meeting notes</h3>
                                <p className="text-footnote text-muted-foreground">Generated by the core backend from the transcript</p>
                            </div>
                        </div>

                        <div className="flex items-center gap-1.5">
                            {onRegenerateSummary && (
                                <Button variant="outline" size="xs" onClick={onRegenerateSummary} disabled={isGenerating}>
                                    <RotateCw className={cn(isGenerating && 'animate-spin')} aria-hidden="true" />
                                    {isGenerating ? 'Summarizing' : 'Regenerate'}
                                </Button>
                            )}

                            <Button variant="outline" size="xs" onClick={handleCopyAllNotes}>
                                {allCopied ? <Check className="text-success" aria-hidden="true" /> : <Copy aria-hidden="true" />}
                                {allCopied ? 'Copied' : 'Copy all'}
                            </Button>
                        </div>
                    </div>

                    <p className="flex items-start gap-1.5 text-footnote text-muted-foreground">
                        <CircleAlert className="mt-[1px] size-3 shrink-0" aria-hidden="true" />
                        <span>Generated automatically from the transcript. Check the details before you share them.</span>
                    </p>

                    <TabsList className="w-full">
                        <TabsTrigger value="summary" className="flex-1">
                            <Sparkles aria-hidden="true" />
                            Summary
                        </TabsTrigger>
                        <TabsTrigger value="decisions" className="flex-1">
                            <Award aria-hidden="true" />
                            Decisions
                            <span className="tnum text-muted-foreground">{decisions.length}</span>
                        </TabsTrigger>
                        <TabsTrigger value="actions" className="flex-1">
                            <ListChecks aria-hidden="true" />
                            Actions
                            <span className="tnum text-muted-foreground">
                                {completedActionCount}/{actionCount}
                            </span>
                        </TabsTrigger>
                        <TabsTrigger value="email" className="flex-1">
                            <Mail aria-hidden="true" />
                            Email
                        </TabsTrigger>
                    </TabsList>
                </div>

                <div className="flex-1 overflow-y-auto p-3 sm:p-4">
                    <TabsContent value="summary" className="space-y-3">
                        <PanelHeading
                            trailing={
                                <Button
                                    variant="plain"
                                    size="xs"
                                    onClick={() => {
                                        if (isEditingSummary) {
                                            handleSaveSummary();
                                        } else {
                                            setSummaryDraft(meeting.summaryMarkdown || '');
                                            setIsEditingSummary(true);
                                        }
                                    }}
                                >
                                    {isEditingSummary ? 'Done' : 'Edit'}
                                </Button>
                            }
                        >
                            Summary
                        </PanelHeading>

                        {isEditingSummary ? (
                            <div className="space-y-2">
                                <Textarea
                                    value={summaryDraft}
                                    onChange={event => setSummaryDraft(event.target.value)}
                                    rows={12}
                                    aria-label="Summary markdown"
                                    placeholder="Write the summary in Markdown"
                                    className="font-mono text-callout"
                                />
                                <div className="flex justify-end gap-2">
                                    <Button variant="ghost" size="sm" onClick={() => setIsEditingSummary(false)}>
                                        Cancel
                                    </Button>
                                    <Button size="sm" onClick={handleSaveSummary}>
                                        Save
                                    </Button>
                                </div>
                            </div>
                        ) : (
                            <div className="space-y-3 text-body">
                                {meeting.summaryMarkdown ? (
                                    <MarkdownText markdown={meeting.summaryMarkdown} />
                                ) : (
                                    <p className="text-muted-foreground">No summary yet. End a recording to generate one.</p>
                                )}
                            </div>
                        )}
                    </TabsContent>

                    <TabsContent value="decisions" className="space-y-3">
                        <PanelHeading trailing={<span className="text-footnote text-muted-foreground">{decisions.length} recorded</span>}>
                            Decisions
                        </PanelHeading>

                        <ul className="space-y-1.5">
                            {decisions.length === 0 ? (
                                <li className="rounded-lg bg-muted px-3 py-2.5 text-callout text-muted-foreground">
                                    No decisions recorded. Add the first one below.
                                </li>
                            ) : (
                                decisions.map((decision, idx) => (
                                    <li key={idx} className="group flex items-start justify-between gap-3 rounded-lg bg-muted px-3 py-2.5">
                                        <div className="flex items-start gap-2.5">
                                            <Check className="mt-[2px] size-3.5 shrink-0 text-success" aria-hidden="true" />
                                            <p className="text-body">{decision}</p>
                                        </div>
                                        <Button
                                            variant="ghost"
                                            size="iconXs"
                                            onClick={() => handleRemoveDecision(idx)}
                                            aria-label={`Delete decision: ${decision}`}
                                            className="shrink-0 text-muted-foreground opacity-0 transition-opacity hover:text-destructive focus-visible:opacity-100 group-hover:opacity-100"
                                        >
                                            <Trash2 aria-hidden="true" />
                                        </Button>
                                    </li>
                                ))
                            )}
                        </ul>

                        <form onSubmit={handleAddDecision} className="flex gap-2">
                            <Input
                                value={newDecision}
                                onChange={event => setNewDecision(event.target.value)}
                                placeholder="Add a decision"
                                aria-label="New decision"
                                className="h-8 text-callout"
                            />
                            <Button type="submit" size="sm" disabled={!newDecision.trim()}>
                                <Plus aria-hidden="true" />
                                Add
                            </Button>
                        </form>
                    </TabsContent>

                    <TabsContent value="actions" className="space-y-3">
                        <PanelHeading
                            trailing={
                                <span className="tnum text-footnote text-muted-foreground">
                                    {completedActionCount} of {actionCount} done
                                </span>
                            }
                        >
                            Action items
                        </PanelHeading>

                        <ul className="space-y-1.5">
                            {actionItems.length === 0 ? (
                                <li className="rounded-lg bg-muted px-3 py-2.5 text-callout text-muted-foreground">No action items yet.</li>
                            ) : (
                                actionItems.map((item, idx) => {
                                    const id = typeof item === 'object' ? item.id || `act-${idx}` : `act-${idx}`;
                                    const task = typeof item === 'object' ? item.task : item;
                                    const owner = typeof item === 'object' ? item.owner || 'You' : 'You';
                                    const deadline = typeof item === 'object' ? item.deadline || 'TBD' : 'TBD';
                                    const completed = typeof item === 'object' ? Boolean(item.completed) : false;

                                    return (
                                        <li key={id} className="group flex items-start justify-between gap-3 rounded-lg bg-muted px-3 py-2.5">
                                            <div className="flex min-w-0 flex-1 items-start gap-2.5">
                                                <Checkbox
                                                    id={`action-${id}`}
                                                    checked={completed}
                                                    onCheckedChange={() => handleToggleAction(id)}
                                                    className="mt-[2px]"
                                                />
                                                <div className="min-w-0 flex-1">
                                                    <label
                                                        htmlFor={`action-${id}`}
                                                        className={cn(
                                                            'block cursor-pointer break-words text-body',
                                                            completed && 'text-muted-foreground line-through'
                                                        )}
                                                    >
                                                        {task}
                                                    </label>

                                                    <div className="mt-1.5 flex flex-wrap items-center gap-3 text-footnote text-muted-foreground">
                                                        <span className="flex items-center gap-1">
                                                            <User className="size-3" aria-hidden="true" />
                                                            {owner}
                                                        </span>
                                                        <span className="flex items-center gap-1">
                                                            <Calendar className="size-3" aria-hidden="true" />
                                                            Due {deadline}
                                                        </span>
                                                    </div>
                                                </div>
                                            </div>

                                            <Button
                                                variant="ghost"
                                                size="iconXs"
                                                onClick={() => handleRemoveAction(id)}
                                                aria-label={`Delete task: ${task}`}
                                                className="shrink-0 text-muted-foreground opacity-0 transition-opacity hover:text-destructive focus-visible:opacity-100 group-hover:opacity-100"
                                            >
                                                <Trash2 aria-hidden="true" />
                                            </Button>
                                        </li>
                                    );
                                })
                            )}
                        </ul>

                        <form onSubmit={handleAddAction} className="flex flex-col gap-2 rounded-lg bg-muted p-2.5 sm:flex-row">
                            <Input
                                value={newActionTask}
                                onChange={event => setNewActionTask(event.target.value)}
                                placeholder="What needs doing?"
                                aria-label="New task"
                                className="h-8 flex-1 text-callout"
                            />
                            <Input
                                value={newActionOwner}
                                onChange={event => setNewActionOwner(event.target.value)}
                                placeholder="Owner"
                                aria-label="Task owner"
                                className="h-8 text-callout sm:w-28"
                            />
                            <Input
                                value={newActionDeadline}
                                onChange={event => setNewActionDeadline(event.target.value)}
                                placeholder="Due"
                                aria-label="Task due date"
                                className="h-8 text-callout sm:w-28"
                            />
                            <Button type="submit" size="sm" disabled={!newActionTask.trim()}>
                                <Plus aria-hidden="true" />
                                Add
                            </Button>
                        </form>
                    </TabsContent>

                    <TabsContent value="email" className="space-y-3">
                        <PanelHeading
                            trailing={
                                <Button variant="outline" size="xs" onClick={handleCopyEmail} disabled={!meeting.emailDraft}>
                                    {emailCopied ? <Check className="text-success" aria-hidden="true" /> : <Copy aria-hidden="true" />}
                                    {emailCopied ? 'Copied' : 'Copy'}
                                </Button>
                            }
                        >
                            Follow-up email
                        </PanelHeading>

                        <div className="rounded-lg bg-muted p-3">
                            <pre className="select-text whitespace-pre-wrap font-mono text-callout text-foreground">
                                {meeting.emailDraft || 'No draft yet. End a recording to generate one.'}
                            </pre>
                        </div>
                    </TabsContent>
                </div>
            </section>
        </Tabs>
    );
}
