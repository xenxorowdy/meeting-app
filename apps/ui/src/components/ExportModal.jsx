import React, { useState } from 'react';
import { Download, Copy, Check, FileText, MessageSquare, Printer, Type } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { SegmentedControl, SegmentedItem } from '@/components/ui/segmented-control';

/**
 * Format timestamp in ms to MM:SS
 */
function formatMs(ms = 0) {
    const totalSeconds = Math.floor(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
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
    const [copied, setCopied] = useState(false);

    if (!meeting) return null;

    const formattedDate = new Date(meeting.startedAt || Date.now()).toLocaleString();
    const durationMin = Math.round((meeting.durationSeconds || 0) / 60);

    // 1. Build Markdown Content
    const buildMarkdown = () => {
        let md = `# ${meeting.title}\n\n`;
        md += `**Date:** ${formattedDate}  \n`;
        md += `**Duration:** ${durationMin} minutes  \n`;
        md += `**Participants:** ${(meeting.participants || ['You']).join(', ')}\n\n`;

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
        let slack = `*${meeting.title}*\n`;
        slack += `_${formattedDate} • ${durationMin} mins • Attendees: ${(meeting.participants || []).join(', ')}_\n\n`;

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
                    slack += `• [${item.completed ? 'x' : ' '}] *${item.task}* (@${item.owner} - Due: ${item.deadline})\n`;
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

    // Handle Clipboard Copy
    const handleCopy = () => {
        navigator.clipboard.writeText(getExportContent());
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    };

    // Handle File Download (.md / .txt)
    const handleDownload = () => {
        const content = getExportContent();
        const extension = activeFormat === 'slack' || activeFormat === 'text' ? 'txt' : 'md';
        const filename = `${meeting.title.replace(/[^a-z0-9]/gi, '_').toLowerCase()}_notes.${extension}`;
        const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = filename;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
    };

    // Handle PDF Print Preview
    const handlePrintPDF = () => {
        const printWindow = window.open('', '_blank');
        if (!printWindow) return;

        printWindow.document.write(`
      <html>
        <head>
          <title>${meeting.title}</title>
          <style>
            body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; line-height: 1.6; color: #1e293b; padding: 40px; max-width: 800px; margin: auto; }
            h1 { font-size: 24px; border-bottom: 2px solid #e2e8f0; padding-bottom: 8px; }
            h2 { font-size: 18px; color: #4338ca; margin-top: 24px; border-bottom: 1px solid #e2e8f0; padding-bottom: 4px; }
            .meta { color: #64748b; font-size: 13px; margin-bottom: 20px; }
            ul { padding-left: 20px; }
            li { margin-bottom: 6px; }
            pre { background: #f8fafc; border: 1px solid #e2e8f0; padding: 12px; border-radius: 6px; font-size: 12px; }
            .transcript-turn { margin-bottom: 12px; }
            .speaker { font-weight: 600; color: #0f172a; }
            .time { color: #94a3b8; font-size: 11px; }
          </style>
        </head>
        <body>
          <h1>${meeting.title}</h1>
          <div class="meta">
            <strong>Date:</strong> ${formattedDate} |
            <strong>Duration:</strong> ${durationMin} mins |
            <strong>Attendees:</strong> ${(meeting.participants || []).join(', ')}
          </div>
          <h2>Executive Summary</h2>
          <p>${(meeting.summaryMarkdown || '').replace(/\n\n/g, '<br/><br/>')}</p>
          <h2>Key Decisions</h2>
          <ul>${(meeting.keyDecisions || []).map(d => `<li>${d}</li>`).join('')}</ul>
          <h2>Action Items</h2>
          <ul>${(meeting.actionItems || []).map(a => (typeof a === 'string' ? `<li>${a}</li>` : `<li>[${a.completed ? '✓' : ' '}] <strong>${a.task}</strong> (${a.owner} - Due: ${a.deadline})</li>`)).join('')}</ul>
          ${includeEmailDraft && meeting.emailDraft ? `<h2>Follow-up Email</h2><pre>${meeting.emailDraft}</pre>` : ''}
          ${includeTranscript && meeting.transcript ? `<h2>Transcript</h2>${meeting.transcript.map(t => `<div class="transcript-turn"><span class="speaker">${t.speaker}</span> <span class="time">[${formatMs(t.startMs)}]</span>: ${t.text}</div>`).join('')}` : ''}
        </body>
      </html>
    `);
        printWindow.document.close();
        printWindow.focus();
        setTimeout(() => {
            printWindow.print();
        }, 400);
    };

    return (
        <Dialog open={isOpen} onOpenChange={open => !open && onClose()}>
            <DialogContent className="flex max-h-[86vh] flex-col gap-0 p-0 sm:max-w-2xl">
                <DialogHeader className="space-y-1 p-5 pb-4 pr-12 text-left hairline-bottom">
                    <DialogTitle className="text-title2 font-semibold">Export notes</DialogTitle>
                    <DialogDescription className="text-callout text-muted-foreground">
                        Copy the notes for “{meeting.title}” or save them as a file.
                    </DialogDescription>
                </DialogHeader>

                <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-5">
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
                        <div className="flex items-center gap-2.5 px-3 py-2.5">
                            <Checkbox id="include-transcript" checked={includeTranscript} onCheckedChange={setIncludeTranscript} />
                            <Label htmlFor="include-transcript" className="cursor-pointer text-body font-normal">
                                Include the full transcript
                            </Label>
                        </div>
                        <div className="flex items-center gap-2.5 px-3 py-2.5">
                            <Checkbox id="include-email" checked={includeEmailDraft} onCheckedChange={setIncludeEmailDraft} />
                            <Label htmlFor="include-email" className="cursor-pointer text-body font-normal">
                                Include the follow-up email
                            </Label>
                        </div>
                    </div>

                    <div className="space-y-2">
                        <Label className="text-body font-medium">Preview</Label>
                        <div className="h-44 select-text overflow-y-auto whitespace-pre-wrap rounded-lg border bg-muted p-3 font-mono text-footnote text-muted-foreground">
                            {getExportContent()}
                        </div>
                    </div>
                </div>

                <DialogFooter className="flex-row items-center justify-end gap-2 p-5 pt-4 hairline-top">
                    <Button variant="outline" onClick={handleCopy}>
                        {copied ? <Check className="text-success" aria-hidden="true" /> : <Copy aria-hidden="true" />}
                        {copied ? 'Copied' : 'Copy'}
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
