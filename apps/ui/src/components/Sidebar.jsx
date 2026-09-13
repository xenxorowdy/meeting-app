import React from 'react';
import { Settings, Sparkles, Volume2 } from 'lucide-react';
import { cn } from '@/utils/cn';

export function Sidebar({ views, activeTab, onSelect, licenseTier, isRecording, isPaused, needsTitlebarInset, canRecord, onStartRecording, onOpenSettings }) {
    return (
        <aside aria-label="Views" className="drag-region flex w-52 shrink-0 flex-col border-r border-[#2a2a2e] bg-[#0e0e0f]">
            <div className={cn('shrink-0', needsTitlebarInset ? 'h-11' : 'h-6')} />
            <div className="no-drag px-3 pb-3">
                <button type="button" onClick={() => onStartRecording?.()} disabled={!canRecord && !isRecording && !isPaused}
                    className={cn('flex w-full items-center justify-center gap-2 rounded-lg border py-2 text-xs font-medium transition-all disabled:cursor-not-allowed disabled:opacity-40', isRecording || isPaused ? 'border-[#ff5f5744] bg-[#ff5f5722] text-[#ff5f57]' : 'border-[#ff7a1a44] bg-[#ff7a1a22] text-[#ff7a1a] hover:bg-[#ff7a1a2e]')}>
                    <span className={cn('size-2 rounded-full', isRecording ? 'animate-breathe bg-[#ff5f57]' : isPaused ? 'bg-[#ffbd2e]' : 'bg-[#ff7a1a]')} />
                    {isRecording ? 'Recording…' : isPaused ? 'Recording paused' : 'New Meeting'}
                </button>
            </div>
            <nav className="no-drag min-h-0 flex-1 overflow-y-auto px-2">
                <p className="px-2 pb-1 pt-1 font-mono text-[10px] tracking-wider text-[#4f4f57]">WORKSPACE</p>
                <div className="space-y-0.5">
                    {views.map(view => {
                        const Icon = view.icon;
                        const isActive = activeTab === view.value;
                        const showDot = view.value === 'live' && (isRecording || isPaused);
                        return <button key={view.value} type="button" onClick={() => onSelect(view.value)} aria-current={isActive ? 'page' : undefined}
                            className={cn('flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors', isActive ? 'bg-[#1e1e21] text-[#e8e8ea]' : 'text-[#6b6b74] hover:bg-[#161618] hover:text-[#a0a0aa]')}>
                            {showDot ? <span className={cn('size-2 shrink-0 rounded-full', isRecording ? 'animate-breathe bg-[#ff5f57]' : 'bg-[#ffbd2e]')} /> : <Icon className={cn('size-3.5 shrink-0', isActive && 'text-[#ff7a1a]')} aria-hidden="true" />}
                            <span className="min-w-0 flex-1 truncate">{view.label}</span><span className="font-mono text-[9px] text-[#38383e]">{view.shortcut}</span>
                        </button>;
                    })}
                </div>
            </nav>
            <div className="no-drag border-t border-[#2a2a2e] p-3">
                <div className="mb-2 flex items-center gap-2 px-2 py-1.5 text-xs text-[#6b6b74]"><Volume2 className="size-3" /><span className="flex-1">Noise cancel</span><span className="relative h-4 w-7 rounded-full bg-[#ff7a1a44]"><span className="absolute right-0.5 top-0.5 size-3 rounded-full bg-[#ff7a1a]" /></span></div>
                <button type="button" onClick={onOpenSettings} className="mb-2 flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-xs text-[#6b6b74] transition-colors hover:bg-[#1e1e21] hover:text-[#e8e8ea]"><Settings className="size-3.5" /><span className="flex-1 text-left">Settings</span><span className="font-mono text-[9px] text-[#38383e]">⌘,</span></button>
                <div className="flex items-center gap-2 rounded-md px-2 py-1.5"><span className="flex size-6 items-center justify-center rounded-full bg-[#ff7a1a22] text-[10px] font-medium text-[#ff7a1a]">A</span><div className="min-w-0 flex-1"><p className="truncate text-xs text-[#e8e8ea]">Alpha</p><p className="font-mono text-[9px] text-[#6b6b74]">{licenseTier ? `${licenseTier} plan` : 'Local workspace'}</p></div><Sparkles className="size-3 text-[#ff7a1a]" /></div>
            </div>
        </aside>
    );
}
