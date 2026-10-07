import React, { useState } from 'react';
import { Download, Copy, Check, ExternalLink, FileText, MessageSquare, Printer, Send, Type } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { SegmentedControl, SegmentedItem } from '@/components/ui/segmented-control';
import { useConnectors } from '@/hooks/useConnectors';
import { escapeHtml, markdownToPrintHtml, printHtml } from '@/lib/printDocument';
import { copyToClipboard } from '@/lib/clipboard';

function deliveryText(delivery) {
    if (!delivery) return null;
    if (!delivery.ok) return delivery.error || 'Sending failed.';
    const when = new Date(delivery.at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
    const count = delivery.items?.length;
    return count > 1 ? `Created ${count} tasks · ${when}` : `Sent · ${when}`;
}

function SendToSection({ meeting, isOpen }) {
    const connectors = useConnectors({ enabled: isOpen });
    const [local, setLocal] = useState({});
    const [busy, setBusy] = useState(null);
    const connected = connectors.providers.filter(connector => connector.connected);
    const deliveries = { ...(meeting.metadata?.connectorDeliveries || {}), ...local };

    const send = async provider => {
        setBusy(provider);
        const previous = deliveries[provider];
        try {
            const delivery = await connectors.send(provider, meeting.id, { force: Boolean(previous?.ok || previous?.alreadySent) });
            setLocal(current => ({ ...current, [provider]: delivery }));
        } catch (cause) {
            const alreadySent = cause.status === 409;
            setLocal(current => ({ ...current, [provider]: { ok: false, alreadySent, error: cause.message, at: Date.now() } }));
        } finally {
            setBusy(null);
        }
    };

    return (
        <div className="space-y-2">
            <Label className="text-body font-medium">Send to</Label>
            {connected.length === 0 ? (
                <p className="rounded-lg border bg-muted px-4 py-2 text-footnote text-muted-foreground">
                    {connectors.loading ? 'Loading connectors…' : 'Connect Slack, Notion, Google Docs, Linear, Jira, Asana or ClickUp in Settings → Connectors to send notes and tasks in one click.'}
                </p>
            ) : (
                <div className="divide-y divide-border overflow-hidden rounded-lg border bg-muted">
                    {connected.map(connector => {
                        const delivery = deliveries[connector.provider];
                        const links = (delivery?.items || []).filter(item => item.url);
                        return (
                            <div key={connector.provider} className="flex items-center justify-between gap-4 px-4 py-2">
                                <div className="min-w-0">
                                    <p className="text-body">{connector.label}</p>
                                    {delivery && (
                                        <p
                                            className={
                                                delivery.ok || delivery.alreadySent
                                                    ? 'text-footnote text-muted-foreground'
                                                    : 'text-footnote text-destructive'
                                            }
                                        >
                                            {deliveryText(delivery)}
                                            {links.slice(0, 3).map(item => (
                                                <a
                                                    key={item.url}
                                                    href={item.url}
                                                    target="_blank"
                                                    rel="noreferrer"
                                                    className="ml-2 inline-flex items-center gap-1 text-primary hover:underline"
                                                >
                                                    {item.key || 'Open'}
                                                    <ExternalLink className="size-3" aria-hidden="true" />
                                                </a>
                                            ))}
                                        </p>
                                    )}
                                </div>
                                <Button
                                    size="sm"
                                    variant={delivery?.ok || delivery?.alreadySent ? 'secondary' : 'default'}
                                    disabled={busy !== null}
                                    onClick={() => send(connector.provider)}
                                >
                                    <Send aria-hidden="true" />
                                    {busy === connector.provider
                                        ? 'Sending…'
                                        : delivery?.ok || delivery?.alreadySent
                                          ? 'Send again'
                                          : connector.kind === 'tasks'
                                            ? 'Create tasks'
                                            : 'Send'}
                                </Button>
                            </div>
                        );
                    })}
                </div>
            )}
        </div>
    );
}

/**
 * Format timestamp in ms to MM:SS
 */
function formatMs(ms = 0) {
    const totalSeconds = Math.floor(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
}

function exportFilename(title, extension) {
    const base = String(title || '')
        .normalize('NFKD')
        .replace(/[^\p{L}\p{N}]+/gu, '_')
        .replace(/^_+|_+$/g, '')
        .toLowerCase()
        .slice(0, 80);
    return `${base || 'meeting'}_notes.${extension}`;
}

function taskParts(item) {
    if (typeof item === 'string') return { task: item, completed: false, details: [] };
    const details = [];
    if (item?.owner) details.push(item.owner);
    if (item?.deadline) details.push(`Due: ${item.deadline}`);
    return { task: item?.task || '', completed: Boolean(item?.completed), details };
}

const FORMATS = [
    { value: 'markdown', label: 'Markdown', icon: FileText },
    { value: 'pdf', label: 'PDF', icon: Printer },
    { value: 'slack', label: 'Slack', icon: MessageSquare },
    { value: 'text', label: 'Plain text', icon: Type },
];

export function ExportModal({ isOpen, onClose, meeting }) {
    const [activeFormat, setActiveFormat] = useState('markdown');
    const [includeTranscript, setIncludeTranscript] = useState(true);
    const [includeEmailDraft, setIncludeEmailDraft] = useState(true);
    const [copyState, setCopyState] = useState('idle');

    if (!meeting) return null;

    const meetingTitle = meeting.title || 'Untitled meeting';
    const participants = meeting.participants || [];
    const formattedDate = new Date(meeting.startedAt || Date.now()).toLocaleString();
    const durationMin = Math.round((meeting.durationSeconds || 0) / 60);

    // 1. Build Markdown Content
    const buildMarkdown = () => {
        let md = `# ${meetingTitle}\n\n`;
        md += `**Date:** ${formattedDate}  \n`;
        md += `**Duration:** ${durationMin} minutes  \n`;
        md += `**Participants:** ${(participants.length ? participants : ['You']).join(', ')}\n\n`;

        if (meeting.summaryMarkdown) {
            md += `## Executive Summary\n\n${meeting.summaryMarkdown}\n\n`;
        }

        if (meeting.keyDecisions && meeting.keyDecisions.length > 0) {
            md += `## Key Decisions\n\n`;
            meeting.keyDecisions.forEach(d => {
                md += `- ${d}\n`;
            });
            md += '\n';
        }

        if (meeting.actionItems && meeting.actionItems.length > 0) {
            md += `## Action Items\n\n`;
            meeting.actionItems.forEach(item => {
                if (typeof item === 'string') {
                    md += `- [ ] ${item}\n`;
                } else {
                    const owner = item.owner ? ` (**${item.owner}**)` : '';
                    const deadline = item.deadline ? ` _(Due: ${item.deadline})_` : '';
                    md += `- [${item.completed ? 'x' : ' '}] ${item.task}${owner}${deadline}\n`;
                }
            });
            md += '\n';
        }

        if (includeEmailDraft && meeting.emailDraft) {
            md += `## Follow-Up Email\n\n\`\`\`\n${meeting.emailDraft}\n\`\`\`\n\n`;
        }

        if (includeTranscript && meeting.transcript && meeting.transcript.length > 0) {
            md += `## Chronological Transcript\n\n`;
            meeting.transcript.forEach(t => {
                md += `**${t.speaker}** _[${formatMs(t.startMs)}]_: ${t.text}\n\n`;
            });
        }

        return md;
    };

    // 2. Build Slack Block Format
    const buildSlack = () => {
        let slack = `*${meetingTitle}*\n`;
        slack += `_${formattedDate} • ${durationMin} mins${participants.length ? ` • Attendees: ${participants.join(', ')}` : ''}_\n\n`;

        if (meeting.summaryMarkdown) {
            slack += `*Executive Summary:*\n>${meeting.summaryMarkdown.replace(/\n\n/g, '\n>')}\n\n`;
        }

        if (meeting.keyDecisions && meeting.keyDecisions.length > 0) {
            slack += `*Key Decisions:*\n`;
            meeting.keyDecisions.forEach(d => {
                slack += `• ${d}\n`;
            });
            slack += '\n';
        }

        if (meeting.actionItems && meeting.actionItems.length > 0) {
            slack += `*Action Items:*\n`;
            meeting.actionItems.forEach(item => {
                if (typeof item === 'string') {
                    slack += `• [ ] ${item}\n`;
                } else {
                    const task = taskParts(item);
                    slack += `• [${task.completed ? 'x' : ' '}] *${task.task}*${task.details.length ? ` (${task.details.join(', ')})` : ''}\n`;
                }
            });
        }

        return slack;
    };

    // 3. Build Plain Text
    const buildPlainText = () => {
        return buildMarkdown()
            .replace(/[#*`_]/g, '')
            .replace(/\[ \]/g, '[ ]')
            .replace(/\[x\]/g, '[✓]');
    };

    // Export string generator
    const getExportContent = () => {
        switch (activeFormat) {
            case 'markdown':
                return buildMarkdown();
            case 'slack':
                return buildSlack();
            case 'text':
                return buildPlainText();
            case 'pdf':
                return buildMarkdown();
            default:
                return buildMarkdown();
        }
    };

    const handleCopy = async () => {
        try {
            await copyToClipboard(getExportContent());
            setCopyState('copied');
        } catch {
            setCopyState('failed');
        }
        setTimeout(() => setCopyState('idle'), 2500);
    };

    const handleDownload = () => {
        const content = getExportContent();
        const extension = activeFormat === 'slack' || activeFormat === 'text' ? 'txt' : 'md';
        const blob = new Blob([content], { type: extension === 'md' ? 'text/markdown;charset=utf-8' : 'text/plain;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = exportFilename(meeting.title, extension);
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    };

    const handlePrintPDF = () => {
        const decisions = meeting.keyDecisions || [];
        const actions = meeting.actionItems || [];
        const transcript = includeTranscript ? meeting.transcript || [] : [];
        printHtml(`
            <div class="print-brand">
                <svg viewBox="0 0 32 32" role="img" aria-label="Kesami logo" xmlns="http://www.w3.org/2000/svg">
                    <rect width="32" height="32" rx="9" fill="#EC3013"/>
                    <rect x="6.4" y="11" width="3.6" height="10" rx="1.8" fill="#fff"/>
                    <rect x="11.6" y="7" width="3.6" height="18" rx="1.8" fill="#fff"/>
                    <rect x="16.8" y="9.5" width="3.6" height="13" rx="1.8" fill="#fff"/>
                    <rect x="22" y="6" width="3.6" height="20" rx="1.8" fill="#fff"/>
                </svg>
                <span>KESAMI</span>
            </div>
            <h1>${escapeHtml(meetingTitle)}</h1>
            <div class="print-meta">
                <strong>Date:</strong> ${escapeHtml(formattedDate)} ·
                <strong>Duration:</strong> ${durationMin} min${participants.length ? ` · <strong>Attendees:</strong> ${escapeHtml(participants.join(', '))}` : ''}
            </div>
            ${meeting.summaryMarkdown ? `<h2>Summary</h2>${markdownToPrintHtml(meeting.summaryMarkdown)}` : ''}
            ${decisions.length ? `<h2>Key decisions</h2><ul>${decisions.map(decision => `<li>${escapeHtml(decision)}</li>`).join('')}</ul>` : ''}
            ${actions.length ? `<h2>Action items</h2><ul>${actions.map(item => {
                const task = taskParts(item);
                return `<li>[${task.completed ? '✓' : ' '}] <strong>${escapeHtml(task.task)}</strong>${task.details.length ? ` (${escapeHtml(task.details.join(', '))})` : ''}</li>`;
            }).join('')}</ul>` : ''}
            ${includeEmailDraft && meeting.emailDraft ? `<h2>Follow-up email</h2><pre>${escapeHtml(meeting.emailDraft)}</pre>` : ''}
            ${transcript.length ? `<h2>Transcript</h2>${transcript.map(turn => `<div class="print-turn"><span class="print-speaker">${escapeHtml(turn.speaker)}</span> <span class="print-time">[${formatMs(turn.startMs)}]</span>: ${escapeHtml(turn.text)}</div>`).join('')}` : ''}
        `);
    };

    return (
        <Dialog open={isOpen} onOpenChange={open => !open && onClose()}>
            <DialogContent className="flex max-h-[86vh] flex-col gap-0 p-0 sm:max-w-2xl">
                <DialogHeader className="space-y-1 p-4 pb-4 pr-12 text-left hairline-bottom">
                    <DialogTitle className="text-title2 font-semibold">Export notes</DialogTitle>
                    <DialogDescription className="text-callout text-muted-foreground">
                        Copy the notes for “{meetingTitle}”, save them as a file, or send them to your tools.
                    </DialogDescription>
                </DialogHeader>

                <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
                    <div className="space-y-2">
                        <Label className="text-body font-medium">Format</Label>
                        <SegmentedControl value={activeFormat} onValueChange={setActiveFormat} aria-label="Export format" className="w-full">
                            {FORMATS.map(format => {
                                const Icon = format.icon;
                                return (
                                    <SegmentedItem key={format.value} value={format.value}>
                                        <Icon aria-hidden="true" />
                                        {format.label}
                                    </SegmentedItem>
                                );
                            })}
                        </SegmentedControl>
                    </div>

                    <div className="divide-y divide-border overflow-hidden rounded-lg border bg-muted">
                        <div className="flex items-center gap-2 px-4 py-2">
                            <Checkbox id="include-transcript" checked={includeTranscript} onCheckedChange={setIncludeTranscript} />
                            <Label htmlFor="include-transcript" className="cursor-pointer text-body font-normal">
                                Include the full transcript
                            </Label>
                        </div>
                        <div className="flex items-center gap-2 px-4 py-2">
                            <Checkbox id="include-email" checked={includeEmailDraft} onCheckedChange={setIncludeEmailDraft} />
                            <Label htmlFor="include-email" className="cursor-pointer text-body font-normal">
                                Include the follow-up email
                            </Label>
                        </div>
                    </div>

                    <SendToSection meeting={meeting} isOpen={isOpen} />

                    <div className="space-y-2">
                        <Label className="text-body font-medium">Preview</Label>
                        <div className="h-44 select-text overflow-y-auto whitespace-pre-wrap rounded-lg border bg-muted p-4 font-mono text-footnote text-muted-foreground">
                            {getExportContent()}
                        </div>
                    </div>
                </div>

                <DialogFooter className="flex-row items-center justify-end gap-2 p-4 pt-4 hairline-top">
                    {copyState === 'failed' && (
                        <span className="mr-auto text-footnote text-destructive" role="status">
                            Couldn’t copy. Select the preview text instead.
                        </span>
                    )}
                    <Button variant="outline" onClick={handleCopy}>
                        {copyState === 'copied' ? <Check className="text-success" aria-hidden="true" /> : <Copy aria-hidden="true" />}
                        {copyState === 'copied' ? 'Copied' : 'Copy'}
                    </Button>

                    {activeFormat === 'pdf' ? (
                        <Button onClick={handlePrintPDF}>
                            <Printer aria-hidden="true" />
                            Print or save PDF
                        </Button>
                    ) : (
                        <Button onClick={handleDownload}>
                            <Download aria-hidden="true" />
                            Save file
                        </Button>
                    )}
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
