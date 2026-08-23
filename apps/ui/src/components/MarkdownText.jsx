import React from 'react';
import { cn } from '@/utils/cn';

const HEADING_STYLES = {
    1: 'text-title3 font-semibold',
    2: 'text-headline font-semibold',
    3: 'text-headline font-semibold',
    4: 'text-body font-semibold',
};

function renderInline(text, keyPrefix) {
    const segments = text.split(/(\*\*[^*]+\*\*|`[^`]+`|_[^_]+_)/g).filter(Boolean);

    return segments.map((segment, index) => {
        const key = `${keyPrefix}-${index}`;

        if (segment.startsWith('**') && segment.endsWith('**')) {
            return (
                <strong key={key} className="font-semibold">
                    {segment.slice(2, -2)}
                </strong>
            );
        }

        if (segment.startsWith('`') && segment.endsWith('`')) {
            return (
                <code key={key} className="rounded bg-muted px-1 py-[1px] font-mono text-callout">
                    {segment.slice(1, -1)}
                </code>
            );
        }

        if (segment.startsWith('_') && segment.endsWith('_') && segment.length > 2) {
            return (
                <em key={key} className="italic">
                    {segment.slice(1, -1)}
                </em>
            );
        }

        return <React.Fragment key={key}>{segment}</React.Fragment>;
    });
}

function parseBlocks(markdown) {
    const blocks = [];
    let paragraph = [];
    let list = null;
    let table = null;

    const flushParagraph = () => {
        if (paragraph.length > 0) {
            blocks.push({ type: 'paragraph', lines: paragraph });
            paragraph = [];
        }
    };

    const flushList = () => {
        if (list) {
            blocks.push({ type: 'list', items: list });
            list = null;
        }
    };

    const flushTable = () => {
        if (table) {
            const rows = table.filter(row => !/^[\s|:-]+$/.test(row));
            if (rows.length > 0) blocks.push({ type: 'table', rows });
            table = null;
        }
    };

    const flushAll = () => {
        flushParagraph();
        flushList();
        flushTable();
    };

    markdown.split('\n').forEach(rawLine => {
        const line = rawLine.trimEnd();

        if (line.trim() === '') {
            flushAll();
            return;
        }

        const heading = line.match(/^(#{1,4})\s+(.*)$/);
        if (heading) {
            flushAll();
            blocks.push({ type: 'heading', level: heading[1].length, text: heading[2] });
            return;
        }

        const bullet = line.match(/^\s*[-*•]\s+(.*)$/);
        if (bullet) {
            flushParagraph();
            flushTable();
            list = list || [];
            list.push(bullet[1]);
            return;
        }

        if (line.trimStart().startsWith('|')) {
            flushParagraph();
            flushList();
            table = table || [];
            table.push(line.trim());
            return;
        }

        flushList();
        flushTable();
        paragraph.push(line);
    });

    flushAll();
    return blocks;
}

function splitRow(row) {
    return row
        .replace(/^\||\|$/g, '')
        .split('|')
        .map(cell => cell.trim());
}

export function MarkdownText({ markdown, className }) {
    if (!markdown || !markdown.trim()) return null;

    const blocks = parseBlocks(markdown);

    return (
        <div className={cn('space-y-4 text-body', className)}>
            {blocks.map((block, index) => {
                if (block.type === 'heading') {
                    const Tag = block.level <= 2 ? 'h5' : 'h6';
                    return (
                        <Tag key={index} className={cn('pt-1', HEADING_STYLES[block.level] || HEADING_STYLES[4])}>
                            {renderInline(block.text, `h-${index}`)}
                        </Tag>
                    );
                }

                if (block.type === 'list') {
                    return (
                        <ul key={index} className="space-y-1">
                            {block.items.map((item, itemIndex) => (
                                <li key={itemIndex} className="flex gap-2">
                                    <span className="mt-[7px] size-1 shrink-0 rounded-full bg-muted-foreground" aria-hidden="true" />
                                    <span>{renderInline(item, `li-${index}-${itemIndex}`)}</span>
                                </li>
                            ))}
                        </ul>
                    );
                }

                if (block.type === 'table') {
                    const [headerRow, ...bodyRows] = block.rows;
                    const headers = splitRow(headerRow);

                    return (
                        <div key={index} className="overflow-x-auto rounded-lg border">
                            <table className="w-full border-collapse text-left">
                                <thead>
                                    <tr className="bg-muted text-footnote text-muted-foreground">
                                        {headers.map((header, headerIndex) => (
                                            <th key={headerIndex} scope="col" className="px-2 py-2 font-medium">
                                                {header}
                                            </th>
                                        ))}
                                    </tr>
                                </thead>
                                <tbody className="divide-y divide-border text-callout">
                                    {bodyRows.map((row, rowIndex) => (
                                        <tr key={rowIndex}>
                                            {splitRow(row).map((cell, cellIndex) => (
                                                <td key={cellIndex} className="px-2 py-2">
                                                    {renderInline(cell, `td-${index}-${rowIndex}-${cellIndex}`)}
                                                </td>
                                            ))}
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    );
                }

                return <p key={index}>{renderInline(block.lines.join(' '), `p-${index}`)}</p>;
            })}
        </div>
    );
}
