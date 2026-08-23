/**
 * Multi-format Meeting Export Utilities (Markdown, JSON, Plain Text, SRT, VTT, Slack).
 */

function formatTimestampMs(ms) {
    const totalSecs = Math.floor(Math.max(0, ms) / 1000);
    const hours = Math.floor(totalSecs / 3600);
    const minutes = Math.floor((totalSecs % 3600) / 60);
    const seconds = totalSecs % 60;

    if (hours > 0) {
        return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
    }
    return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function formatSrtTimestamp(ms) {
    const totalMs = Math.max(0, ms);
    const hours = Math.floor(totalMs / 3600000);
    const minutes = Math.floor((totalMs % 3600000) / 60000);
    const seconds = Math.floor((totalMs % 60000) / 1000);
    const millis = totalMs % 1000;

    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')},${String(millis).padStart(3, '0')}`;
}

function formatVttTimestamp(ms) {
    const totalMs = Math.max(0, ms);
    const hours = Math.floor(totalMs / 3600000);
    const minutes = Math.floor((totalMs % 3600000) / 60000);
    const seconds = Math.floor((totalMs % 60000) / 1000);
    const millis = totalMs % 1000;

    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(millis).padStart(3, '0')}`;
}

/**
 * Export meeting to Publication-Ready Markdown.
 */
function exportToMarkdown(meeting = {}, transcriptTurns = [], actionItems = [], keyDecisions = []) {
    const title = meeting.title || 'Untitled Meeting';
    const dateStr = meeting.startedAt ? new Date(meeting.startedAt).toLocaleString() : 'N/A';
    const durationMin = meeting.durationSeconds ? `${Math.round(meeting.durationSeconds / 60)} min` : 'N/A';

    let md = `# ${title}\n\n`;
    md += `**Date:** ${dateStr}  \n`;
    md += `**Duration:** ${durationMin}  \n\n`;
    md += `---\n\n`;

    if (meeting.summaryMarkdown) {
        md += `${meeting.summaryMarkdown.trim()}\n\n`;
    } else {
        if (keyDecisions && keyDecisions.length > 0) {
            md += `## 🎯 Key Decisions\n\n`;
            for (const dec of keyDecisions) {
                md += `- ${dec}\n`;
            }
            md += `\n`;
        }

        if (actionItems && actionItems.length > 0) {
            md += `## ✅ Action Items\n\n`;
            md += `| Task | Owner | Deadline | Status |\n`;
            md += `| :--- | :--- | :--- | :--- |\n`;
            for (const it of actionItems) {
                md += `| ${it.task || it.text || ''} | **${it.owner || 'Unassigned'}** | ${it.deadline || '-'} | ${it.status || 'pending'} |\n`;
            }
            md += `\n`;
        }
    }

    if (transcriptTurns && transcriptTurns.length > 0) {
        md += `## 📝 Transcript\n\n`;
        for (const turn of transcriptTurns) {
            const timeTag = formatTimestampMs(turn.startMs);
            const speakerTag = turn.speaker === 'You' ? '**You**' : `**${turn.speaker}**`;
            md += `> \`[${timeTag}]\` ${speakerTag}: ${turn.text}\n\n`;
        }
    }

    return md.trim();
}

/**
 * Export meeting to Structured JSON.
 */
function exportToJSON(meeting = {}, transcriptTurns = [], actionItems = [], keyDecisions = []) {
    return JSON.stringify({
        id: meeting.id,
        title: meeting.title,
        startedAt: meeting.startedAt,
        endedAt: meeting.endedAt,
        durationSeconds: meeting.durationSeconds,
        summaryMarkdown: meeting.summaryMarkdown,
        keyDecisions: keyDecisions.length > 0 ? keyDecisions : meeting.keyDecisions || [],
        actionItems: actionItems.length > 0 ? actionItems : meeting.actionItems || [],
        metadata: meeting.metadata || {},
        transcript: transcriptTurns.map(t => ({
            id: t.id,
            channel: t.channel,
            speaker: t.speaker,
            startMs: t.startMs,
            endMs: t.endMs,
            text: t.text,
            confidence: t.confidence,
        })),
        exportedAt: new Date().toISOString(),
    }, null, 2);
}

/**
 * Export transcript to Plain Text.
 */
function exportToPlainText(meeting = {}, transcriptTurns = []) {
    const title = meeting.title || 'Meeting Transcript';
    const dateStr = meeting.startedAt ? new Date(meeting.startedAt).toLocaleString() : '';

    let txt = `${title}\n${dateStr}\n${'='.repeat(title.length)}\n\n`;

    for (const turn of transcriptTurns) {
        const timeTag = formatTimestampMs(turn.startMs);
        txt += `[${timeTag}] [${turn.speaker}]: ${turn.text}\n\n`;
    }

    return txt.trim();
}

/**
 * Export transcript to SubRip (.srt) caption file.
 */
function exportToSRT(transcriptTurns = []) {
    let srt = '';
    let index = 1;

    for (const turn of transcriptTurns) {
        const start = formatSrtTimestamp(turn.startMs);
        const end = formatSrtTimestamp(turn.endMs || (turn.startMs + 3000));
        const text = `[${turn.speaker}] ${turn.text}`;

        srt += `${index}\n`;
        srt += `${start} --> ${end}\n`;
        srt += `${text}\n\n`;
        index++;
    }

    return srt.trim();
}

/**
 * Export transcript to WebVTT (.vtt) caption file.
 */
function exportToVTT(transcriptTurns = []) {
    let vtt = 'WEBVTT\n\n';

    for (const turn of transcriptTurns) {
        const start = formatVttTimestamp(turn.startMs);
        const end = formatVttTimestamp(turn.endMs || (turn.startMs + 3000));
        const text = `<v ${turn.speaker}>${turn.text}`;

        vtt += `${start} --> ${end}\n`;
        vtt += `${text}\n\n`;
    }

    return vtt.trim();
}

/**
 * Export meeting summary and action items in Slack Markdown format.
 */
function exportToSlackMarkdown(meeting = {}, summaryText = '', actionItems = []) {
    const title = meeting.title || 'Meeting Summary';

    let slack = `*📋 ${title}*\n`;
    if (meeting.startedAt) {
        slack += `_${new Date(meeting.startedAt).toLocaleString()} • ${Math.round((meeting.durationSeconds || 0) / 60)} min_\n\n`;
    }

    if (summaryText) {
        slack += `*Executive Summary*\n>${summaryText.replace(/\n/g, '\n>')}\n\n`;
    }

    if (actionItems && actionItems.length > 0) {
        slack += `*Action Items*\n`;
        for (const it of actionItems) {
            const owner = it.owner ? ` (@${it.owner})` : '';
            const deadline = it.deadline ? ` [due: ${it.deadline}]` : '';
            slack += `• [ ] *${it.task || it.text}*${owner}${deadline}\n`;
        }
    }

    return slack.trim();
}

module.exports = {
    exportToMarkdown,
    exportToJSON,
    exportToPlainText,
    exportToSRT,
    exportToVTT,
    exportToSlackMarkdown,
    formatTimestampMs,
};
