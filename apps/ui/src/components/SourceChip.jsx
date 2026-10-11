import React from 'react';
import { Quote } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { citationTime, citationDate, readableExcerpt } from '@/lib/chat';

export function SourceChip({ citation, onOpen }) {
    const time = citationTime(citation.startMs);
    const unavailable = citation.available === false;
    const excerpt = readableExcerpt(citation.excerpt);
    const when = [citationDate(citation.startedAt), time && `Transcript ${time}`].filter(Boolean).join(' · ');
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
                {when && <span className="ks-source-preview-time">{when}</span>}
                <p>{excerpt.text || 'Open the supporting passage'}</p>
                {excerpt.details.length > 0 && (
                    <dl className="ks-source-preview-details">
                        {excerpt.details.map(([label, value]) => (
                            <div key={label}>
                                <dt>{label}</dt>
                                <dd>{value}</dd>
                            </div>
                        ))}
                    </dl>
                )}
            </TooltipContent>
        </Tooltip>
    );
}
