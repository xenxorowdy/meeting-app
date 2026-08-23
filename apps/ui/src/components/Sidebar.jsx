import React from 'react';
import { cn } from '@/utils/cn';

export function Sidebar({ views, activeTab, onSelect, licenseTier, isRecording, isPaused, needsTitlebarInset }) {
    return (
        <nav aria-label="Views" className="drag-region flex w-55 shrink-0 flex-col border-r bg-card">
            <div className={cn('shrink-0', needsTitlebarInset ? 'h-13' : 'h-8')} />

            <div className="no-drag flex flex-col gap-1 px-2">
                {views.map(view => {
                    const Icon = view.icon;
                    const isActive = activeTab === view.value;
                    const showDot = view.value === 'live' && (isRecording || isPaused);
                    return (
                        <button
                            key={view.value}
                            type="button"
                            onClick={() => onSelect(view.value)}
                            aria-current={isActive ? 'page' : undefined}
                            className={cn(
                                'flex items-center gap-2 rounded-lg px-2 py-2 text-left text-callout transition-colors duration-200 ease-out',
                                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                                isActive ? 'bg-accent font-medium text-foreground' : 'text-muted-foreground hover:text-foreground'
                            )}
                        >
                            {showDot ? (
                                <span
                                    role="img"
                                    aria-label={isRecording ? 'Recording' : 'Paused'}
                                    className={cn(
                                        'size-4 shrink-0 scale-50 rounded-full',
                                        isRecording ? 'animate-breathe bg-destructive' : 'bg-warning'
                                    )}
                                />
                            ) : (
                                <Icon className="size-4 shrink-0" aria-hidden="true" />
                            )}
                            <span className="min-w-0 flex-1 truncate">{view.label}</span>
                            <span className="shrink-0 text-footnote text-muted-foreground">{view.shortcut}</span>
                        </button>
                    );
                })}
            </div>

            <div className="flex-1" />

            <div className="no-drag px-4 py-4 text-footnote text-muted-foreground">Alpha{licenseTier ? ` · ${licenseTier}` : ''}</div>
        </nav>
    );
}
