import React from 'react';
import { Quote } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { citationTime, citationDate } from '@/lib/chat';

export function SourceChip({ citation, onOpen }) {
    const time = citationTime(citation.startMs);
    const unavailable = citation.available === false;
    return (
        <Tooltip>
            <TooltipTrigger asChild>
                <button
                    type="button"
                    className="ks-chat-citation"
                    disabled={unavailable}
                    aria-label={`Open source: ${citation.title}${time ? ` at ${time}` : ''}`}
                    title={unavailable ? citation.unavailableReason || 'Source unavailable' : undefined}
                    onClick={() => onOpen(citation)}
                >
                    <Quote size={11} aria-hidden="true" />
                    <span>{unavailable ? 'Unavailable' : time || citation.title || 'Source'}</span>
                </button>
            </TooltipTrigger>
            <TooltipContent className="ks-source-preview" side="top">
                <strong>{citation.title}</strong>
                {citationDate(citation.startedAt) && <span className="ks-source-preview-time">{citationDate(citation.startedAt)}</span>}
                {time && <span className="ks-source-preview-time">Transcript · {time}</span>}
                <p>{citation.excerpt || 'Open the supporting passage'}</p>
            </TooltipContent>
        </Tooltip>
    );
}
