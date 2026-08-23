import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
    ArrowLeft,
    AudioLines,
    Camera,
    Check,
    ChevronDown,
    ChevronUp,
    CircleAlert,
    Download,
    FileAudio,
    Film,
    Link,
    LoaderCircle,
    Mic,
    Monitor,
    Music,
    Pause,
    Play,
    Plus,
    Podcast,
    Radio,
    RefreshCw,
    Rss,
    Scissors,
    Settings2,
    Sparkles,
    Square,
    Trash2,
    Redo2,
    Undo2,
    Upload,
    WandSparkles,
    Youtube,
} from 'lucide-react';
import { cn } from '@/utils/cn';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { usePodcastStudio } from '@/hooks/usePodcastStudio';
import { listSources } from '@/lib/screenRecorder';
import { isPodcastCaptureSupported, listPodcastDevices, requestPodcastPermissions, startPodcastCapture } from '@/lib/podcastCapture';

const VOICES = ['Kore', 'Puck', 'Charon', 'Fenrir', 'Aoede', 'Leda', 'Orus', 'Zephyr'];
const LANGUAGES = [
    ['auto', 'Detect from source'], ['en', 'English'], ['hi', 'Hindi'], ['mr', 'Marathi'], ['bn', 'Bengali'],
    ['gu', 'Gujarati'], ['pa', 'Punjabi'], ['ta', 'Tamil'], ['te', 'Telugu'], ['ur', 'Urdu'], ['es', 'Spanish'], ['fr', 'French'],
];

function formatDuration(seconds = 0) {
    const total = Math.max(0, Math.round(Number(seconds) || 0));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const rest = total % 60;
    return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}` : `${minutes}:${String(rest).padStart(2, '0')}`;
}

function kindIcon(kind) {
    if (kind === 'video') return Film;
    if (kind === 'caption') return FileAudio;
    return AudioLines;
}

function EmptyDesktop() {
    return (
        <section className="flex h-full flex-col items-center justify-center rounded-xl border bg-card p-8 text-center">
            <Podcast className="size-10 text-primary" aria-hidden="true" />
            <h2 className="mt-4 text-title2 font-semibold">Podcast Studio needs the desktop app</h2>
            <p className="mt-2 max-w-lg text-callout text-muted-foreground">
                Capture, local media processing, secure YouTube sign-in, and high-quality rendering use Alpha’s Electron media services.
            </p>
        </section>
    );
}

function StudioHome({ studio, meetings }) {
    const [meetingId, setMeetingId] = useState(meetings[0]?.id || '');
    useEffect(() => { if (!meetingId && meetings[0]?.id) setMeetingId(meetings[0].id); }, [meetingId, meetings]);
    const selectedMeeting = meetings.find(meeting => meeting.id === meetingId);

    const createFromMeeting = async () => {
        if (!selectedMeeting) return;
        await studio.createProject({ title: selectedMeeting.title, source: { kind: 'meeting', meetingId: selectedMeeting.id } });
    };

    return (
        <div className="flex h-full flex-col gap-4 overflow-y-auto">
            <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                    <div className="flex items-center gap-2">
                        <Podcast className="size-6 text-primary" aria-hidden="true" />
                        <h1 className="text-title1 font-semibold">Podcast Studio</h1>
                    </div>
                    <p className="mt-1 text-callout text-muted-foreground">Turn a meeting into a polished episode, or start from your own media.</p>
                </div>
                <Badge variant="tinted">Desktop production</Badge>
            </div>

            <section className="rounded-xl border bg-card p-4 sm:p-6">
                <div className="flex items-center gap-2">
                    <Sparkles className="size-5 text-primary" aria-hidden="true" />
                    <h2 className="text-title3 font-semibold">Turn a meeting into an episode</h2>
                </div>
                <p className="mt-1 text-callout text-muted-foreground">Generate a source-grounded two-host script and editable voice tracks.</p>
                <div className="mt-4 flex flex-col gap-2 sm:flex-row">
                    <Select value={meetingId} onValueChange={setMeetingId}>
                        <SelectTrigger className="min-w-0 flex-1"><SelectValue placeholder="Choose a completed meeting" /></SelectTrigger>
                        <SelectContent>
                            {meetings.map(meeting => <SelectItem key={meeting.id} value={meeting.id}>{meeting.title}</SelectItem>)}
                        </SelectContent>
                    </Select>
                    <Button onClick={createFromMeeting} disabled={!selectedMeeting || studio.isBusy}>
                        <WandSparkles aria-hidden="true" /> Create from meeting
                    </Button>
                </div>
                {!meetings.length && <p className="mt-3 text-footnote text-muted-foreground">Complete a meeting first, or use one of the production sources below.</p>}
            </section>

            <div className="grid gap-3 md:grid-cols-3">
                {[
                    { icon: Mic, title: 'Record', text: 'Choose mic, camera, and screen before each take.', source: { kind: 'recording' } },
                    { icon: FileAudio, title: 'Import media', text: 'Edit owned audio or video without changing the original.', source: { kind: 'file' } },
                    { icon: Rss, title: 'Import RSS / YouTube', text: 'Bring in an RSS enclosure or captions from an owned video.', source: { kind: 'import' } },
                ].map(item => (
                    <button key={item.title} type="button" onClick={() => studio.createProject({ title: `New ${item.title.toLowerCase()} project`, source: item.source })} className="rounded-xl border bg-card p-4 text-left transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                        <item.icon className="size-5 text-primary" aria-hidden="true" />
                        <h3 className="mt-3 text-headline font-semibold">{item.title}</h3>
                        <p className="mt-1 text-callout text-muted-foreground">{item.text}</p>
                    </button>
                ))}
            </div>

            <section>
                <div className="mb-2 flex items-center justify-between">
                    <h2 className="text-headline font-semibold">Recent projects</h2>
                    <Button variant="ghost" size="xs" onClick={studio.reload}><RefreshCw aria-hidden="true" /> Refresh</Button>
                </div>
                <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
                    {studio.projects.map(project => (
                        <button key={project.id} type="button" onClick={() => studio.openProject(project)} className="rounded-xl border bg-card p-4 text-left hover:bg-accent">
                            <div className="flex items-center justify-between gap-3">
                                <span className="truncate text-headline font-medium">{project.title}</span>
                                <Badge variant={project.script?.status === 'voiced' ? 'success' : 'secondary'}>{project.script?.status || 'draft'}</Badge>
                            </div>
                            <p className="mt-2 text-footnote text-muted-foreground">{project.source?.kind || 'project'} · {formatDuration((project.timeline?.durationMs || 0) / 1000)}</p>
                        </button>
                    ))}
                    {!studio.projects.length && <p className="rounded-xl border border-dashed p-6 text-callout text-muted-foreground">No podcast projects yet.</p>}
                </div>
            </section>
        </div>
    );
}

function ScriptPanel({ project, sourceMeeting, studio, updateProject }) {
    const script = project.script || {};
    const hosts = script.hosts || [];

    const updateHost = (index, patch) => {
        const next = hosts.map((host, i) => i === index ? { ...host, ...patch } : host);
        updateProject({ ...project, script: { ...script, hosts: next } });
    };

    const updateTurn = (index, patch) => {
        const turns = (script.turns || []).map((turn, i) => i === index ? { ...turn, ...patch } : turn);
        updateProject({ ...project, script: { ...script, turns } });
    };

    const removeTurn = index => {
        const turns = (script.turns || []).filter((_, i) => i !== index);
        updateProject({ ...project, script: { ...script, turns } });
    };

    const addTurn = () => {
        const turns = [...(script.turns || []), { speakerId: hosts[0]?.id || 'host-a', text: '', sourceTurnIds: [] }];
        updateProject({ ...project, script: { ...script, turns } });
    };

    return (
        <div className="space-y-4">
            <section className="rounded-xl border bg-card p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                        <h3 className="text-headline font-semibold">Two-host direction</h3>
                        <p className="text-footnote text-muted-foreground">Language defaults to the source. Voices can be changed before regenerating audio.</p>
                    </div>
                    <Select value={project.language || 'auto'} onValueChange={language => updateProject({ ...project, language })}>
                        <SelectTrigger className="w-48"><SelectValue /></SelectTrigger>
                        <SelectContent>{LANGUAGES.map(([value, label]) => <SelectItem key={value} value={value}>{label}</SelectItem>)}</SelectContent>
                    </Select>
                </div>
                <div className="mt-4 grid gap-3 sm:grid-cols-2">
                    {hosts.slice(0, 2).map((host, index) => (
                        <div key={host.id} className="rounded-lg bg-muted p-3">
                            <Label htmlFor={`host-${host.id}`}>Host {index + 1}</Label>
                            <Input id={`host-${host.id}`} className="mt-2" value={host.name} onChange={event => updateHost(index, { name: event.target.value })} />
                            <Select value={host.voice} onValueChange={voice => updateHost(index, { voice })}>
                                <SelectTrigger className="mt-2 w-full"><SelectValue /></SelectTrigger>
                                <SelectContent>{VOICES.map(voice => <SelectItem key={voice} value={voice}>{voice}</SelectItem>)}</SelectContent>
                            </Select>
                        </div>
                    ))}
                </div>
                <div className="mt-4 flex flex-wrap gap-2">
                    <Button onClick={() => studio.generateScript(project, sourceMeeting)} disabled={studio.isBusy || (!sourceMeeting && !(project.transcript || []).length)}>
                        {studio.isBusy ? <LoaderCircle className="animate-spin" aria-hidden="true" /> : <Sparkles aria-hidden="true" />}
                        {script.turns?.length ? 'Regenerate script' : 'Generate script'}
                    </Button>
                    <Button variant="outline" onClick={() => studio.generateVoice(project)} disabled={studio.isBusy || !(script.turns || []).some(turn => turn.text.trim())}>
                        <AudioLines aria-hidden="true" /> Generate voices
                    </Button>
                    {script.estimatedDurationSeconds > 0 && <Badge variant="secondary">Estimated {formatDuration(script.estimatedDurationSeconds)}</Badge>}
                </div>
                <p className="mt-3 flex gap-2 text-footnote text-muted-foreground"><CircleAlert className="size-4 shrink-0" /> Generation sends transcript/script text to Gemini. Source media stays local. Review facts before publishing.</p>
            </section>

            <section className="space-y-2">
                <div className="flex items-center justify-between"><h3 className="text-headline font-semibold">Editable dialogue</h3><Button variant="outline" size="xs" onClick={addTurn}><Plus /> Add turn</Button></div>
                {(script.turns || []).map((turn, index) => {
                    const host = hosts.find(item => item.id === turn.speakerId) || hosts[0];
                    return (
                        <div key={`${turn.speakerId}-${index}`} className="rounded-xl border bg-card p-3">
                            <div className="flex items-center gap-2">
                                <Select value={turn.speakerId} onValueChange={speakerId => updateTurn(index, { speakerId })}>
                                    <SelectTrigger className="h-8 w-36"><SelectValue /></SelectTrigger>
                                    <SelectContent>{hosts.map(item => <SelectItem key={item.id} value={item.id}>{item.name}</SelectItem>)}</SelectContent>
                                </Select>
                                <Badge variant="secondary">{host?.voice}</Badge>
                                <span className="flex-1 truncate text-footnote text-muted-foreground">Sources: {(turn.sourceTurnIds || []).join(', ') || 'manual'}</span>
                                <Button variant="ghost" size="iconXs" onClick={() => removeTurn(index)} aria-label="Delete dialogue turn"><Trash2 /></Button>
                            </div>
                            <Textarea className="mt-2 min-h-20" value={turn.text} onChange={event => updateTurn(index, { text: event.target.value })} />
                        </div>
                    );
                })}
                {!script.turns?.length && <div className="rounded-xl border border-dashed p-8 text-center text-callout text-muted-foreground">Generate a grounded script or add dialogue manually.</div>}
            </section>
        </div>
    );
}

function ClipEditor({ project, track, clip, clipIndex, studio, commitTimeline }) {
    const asset = project.assets.find(item => item.id === clip.assetId);
    const sourceDuration = Math.max(0, Number(asset?.durationMs) || 0);
    const sourceIn = Math.max(0, Math.min(sourceDuration, Number(clip.sourceStartMs) || 0));
    const sourceOut = Math.max(sourceIn, Math.min(sourceDuration || Number(clip.sourceEndMs) || 0, Number(clip.sourceEndMs) || sourceIn + (Number(clip.durationMs) || 0)));
    const replaceTrack = clips => commitTimeline({ ...project.timeline, tracks: project.timeline.tracks.map(item => item.id === track.id ? { ...item, clips } : item) });
    const patchClip = patch => {
        replaceTrack(track.clips.map(value => value.id === clip.id ? { ...value, ...patch } : value));
    };
    const move = direction => {
        const target = clipIndex + direction;
        if (target < 0 || target >= track.clips.length) return;
        const clips = track.clips.map(value => ({ ...value }));
        const start = clips[clipIndex].timelineStartMs;
        clips[clipIndex].timelineStartMs = clips[target].timelineStartMs;
        clips[target].timelineStartMs = start;
        [clips[clipIndex], clips[target]] = [clips[target], clips[clipIndex]];
        replaceTrack(clips);
    };
    const split = () => {
        const duration = Math.max(0, Number(clip.durationMs) || 0);
        if (duration < 2) return;
        const firstDuration = Math.floor(duration / 2);
        const secondDuration = duration - firstDuration;
        const first = { ...clip, durationMs: firstDuration, sourceEndMs: (clip.sourceStartMs || 0) + firstDuration };
        const second = { ...clip, id: globalThis.crypto?.randomUUID?.() || `clip-${Date.now()}`, sourceStartMs: (clip.sourceStartMs || 0) + firstDuration, sourceEndMs: (clip.sourceStartMs || 0) + duration, timelineStartMs: (clip.timelineStartMs || 0) + firstDuration, durationMs: secondDuration };
        const clips = [...track.clips];
        clips.splice(clipIndex, 1, first, second);
        replaceTrack(clips);
    };
    const trim = (nextIn, nextOut) => {
        const maximum = sourceDuration || Math.max(nextOut, 1);
        const start = Math.max(0, Math.min(maximum - 1, Math.round(Number(nextIn) || 0)));
        const end = Math.max(start + 1, Math.min(maximum, Math.round(Number(nextOut) || maximum)));
        patchClip({ sourceStartMs: start, sourceEndMs: end, durationMs: end - start });
    };
    return (
        <div className="rounded-lg border bg-background p-3">
            <div className="flex items-center gap-2">
                <Badge variant="secondary">{asset?.hasVideo ? 'Video' : track.kind === 'caption' ? 'Captions' : 'Audio'}</Badge>
                <span className="min-w-0 flex-1 truncate text-callout font-medium">{asset?.name || 'Missing asset'}</span>
                <span className="tnum text-footnote text-muted-foreground">{formatDuration((clip.durationMs || 0) / 1000)}</span>
                <Button variant="ghost" size="iconXs" onClick={() => move(-1)} disabled={clipIndex === 0} aria-label="Move clip earlier"><ChevronUp /></Button>
                <Button variant="ghost" size="iconXs" onClick={() => move(1)} disabled={clipIndex === track.clips.length - 1} aria-label="Move clip later"><ChevronDown /></Button>
                <Button variant="ghost" size="iconXs" onClick={() => replaceTrack(track.clips.filter(value => value.id !== clip.id))} aria-label="Remove clip"><Trash2 /></Button>
            </div>
            {sourceDuration > 1 && (
                <div className="mt-3 rounded-lg bg-muted/60 p-3">
                    <div className="flex items-center justify-between gap-3"><span className="text-footnote font-medium">Trim source</span><span className="tnum text-footnote text-muted-foreground">{formatDuration(sourceIn / 1000)} → {formatDuration(sourceOut / 1000)}</span></div>
                    <label className="mt-2 block text-footnote text-muted-foreground">In point
                        <input aria-label="Clip source in point" type="range" min="0" max={Math.max(1, sourceOut - 1)} step="10" value={sourceIn} onChange={event => trim(event.target.value, sourceOut)} className="mt-1 block w-full accent-primary" />
                    </label>
                    <label className="mt-2 block text-footnote text-muted-foreground">Out point
                        <input aria-label="Clip source out point" type="range" min={Math.min(sourceDuration, sourceIn + 1)} max={sourceDuration} step="10" value={sourceOut} onChange={event => trim(sourceIn, event.target.value)} className="mt-1 block w-full accent-primary" />
                    </label>
                </div>
            )}
            <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-5">
                {[
                    ['timelineStartMs', 'Timeline start ms'], ['gainDb', 'Gain dB'], ['fadeInMs', 'Fade in ms'], ['fadeOutMs', 'Fade out ms'],
                ].map(([field, label]) => (
                    <label key={field} className="text-footnote text-muted-foreground">{label}<Input type="number" className="mt-1 h-7 px-2" value={clip[field] || 0} onChange={event => patchClip({ [field]: Number(event.target.value) })} /></label>
                ))}
                <label className="text-footnote text-muted-foreground">Duration ms<Input readOnly className="mt-1 h-7 px-2" value={clip.durationMs || 0} /></label>
            </div>
            {asset?.hasVideo && <div className="mt-3 grid grid-cols-2 gap-2"><label className="text-footnote text-muted-foreground">Video fit<Select value={clip.fit || 'contain'} onValueChange={fit => patchClip({ fit })}><SelectTrigger className="mt-1 h-8 w-full"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="contain">Fit</SelectItem><SelectItem value="cover">Fill</SelectItem></SelectContent></Select></label><label className="text-footnote text-muted-foreground">Opacity {Math.round((clip.opacity ?? 1) * 100)}%<input aria-label="Video opacity" type="range" min="0" max="1" step="0.05" value={clip.opacity ?? 1} onChange={event => patchClip({ opacity: Number(event.target.value) })} className="mt-2 block w-full accent-primary" /></label></div>}
            <div className="mt-2 flex flex-wrap gap-2"><Button variant="ghost" size="xs" onClick={split} disabled={(clip.durationMs || 0) < 2}><Scissors /> Split halfway</Button>{asset?.hasAudio && <><Button variant="ghost" size="xs" onClick={() => studio.callBridge('cleanSpeech', project.id, asset.id)}><WandSparkles /> Clean speech</Button><Button variant="ghost" size="xs" onClick={() => studio.transcribe(project.id, asset.relativePath)}><FileAudio /> Transcribe</Button></>}</div>
        </div>
    );
}

function ExportOptions({ project, studio }) {
    const options = [
        { format: 'wav', title: 'WAV master', detail: '48 kHz · 24-bit', icon: AudioLines },
        { format: 'mp3', title: 'MP3 episode', detail: '320 kbps · −16 LUFS', icon: Download },
        { format: 'mp4', title: 'Video episode', detail: '1080p · H.264', icon: Film },
    ];
    return (
        <section className="rounded-xl border bg-card p-4">
            <div><h3 className="text-headline font-semibold">Export episode</h3><p className="text-footnote text-muted-foreground">Choose a destination when Alpha finishes the local render.</p></div>
            <div className="mt-3 grid gap-2 sm:grid-cols-3">
                {options.map(option => <Button key={option.format} variant={option.format === 'mp4' ? 'default' : 'outline'} className="h-auto justify-start px-3 py-3 text-left" onClick={() => studio.callBridge('render', project.id, option.format)} disabled={studio.isBusy}><option.icon className="size-4" /><span><span className="block text-callout font-medium">{option.title}</span><span className="block text-footnote font-normal opacity-70">{option.detail}</span></span></Button>)}
            </div>
            {!!project.exports?.length && <div className="mt-3 space-y-1 border-t pt-3">{project.exports.slice(-3).reverse().map(item => <div key={item.id} className="flex items-center gap-2 text-footnote"><Badge variant="secondary">{item.format.toUpperCase()}</Badge><span className="min-w-0 flex-1 truncate text-muted-foreground">{item.externalPath || item.relativePath}</span><span className="text-muted-foreground">{formatDuration((item.durationMs || 0) / 1000)}</span></div>)}</div>}
        </section>
    );
}

function TimelinePanel({ project, studio, updateProject }) {
    const [selectedAsset, setSelectedAsset] = useState(null);
    const [history, setHistory] = useState({ undo: [], redo: [] });
    const media = project.assets.find(item => item.id === selectedAsset);
    const mediaUrl = media ? globalThis.alphaPodcast.mediaUrl(project.id, media.relativePath) : null;

    useEffect(() => setHistory({ undo: [], redo: [] }), [project.id]);

    const applyTimeline = timeline => updateProject({ ...project, timeline: { ...timeline, revision: (project.timeline.revision || 0) + 1 } });
    const commitTimeline = timeline => {
        const durationMs = Math.max(0, ...(timeline.tracks || []).flatMap(track => (track.clips || []).map(clip => (Number(clip.timelineStartMs) || 0) + (Number(clip.durationMs) || 0))));
        setHistory(current => ({ undo: [...current.undo, structuredClone(project.timeline)].slice(-50), redo: [] }));
        applyTimeline({ ...timeline, durationMs });
    };
    const undo = () => {
        const previous = history.undo.at(-1);
        if (!previous) return;
        setHistory(current => ({ undo: current.undo.slice(0, -1), redo: [...current.redo, structuredClone(project.timeline)].slice(-50) }));
        applyTimeline(previous);
    };
    const redo = () => {
        const next = history.redo.at(-1);
        if (!next) return;
        setHistory(current => ({ undo: [...current.undo, structuredClone(project.timeline)].slice(-50), redo: current.redo.slice(0, -1) }));
        applyTimeline(next);
    };

    const patchTrack = (trackId, patch) => {
        const tracks = project.timeline.tracks.map(track => track.id === trackId ? { ...track, ...patch } : track);
        commitTimeline({ ...project.timeline, tracks });
    };
    const addSelectedAsset = trackId => studio.callBridge('addAsset', project.id, media.id, { trackId });

    return (
        <div className="grid gap-4 xl:grid-cols-12">
            <aside className="space-y-3 xl:col-span-4">
                <div className="flex flex-wrap gap-2">
                    <Button size="sm" onClick={() => studio.callBridge('importFile', project.id)} disabled={studio.isBusy}><Plus /> Import media</Button>
                    <Button size="sm" variant="outline" onClick={() => studio.callBridge('waveform', project.id, selectedAsset)} disabled={!media?.hasAudio}><AudioLines /> Waveform</Button>
                </div>
                <div className="space-y-1 rounded-xl border bg-card p-2">
                    {project.assets.map(asset => {
                        const Icon = kindIcon(asset.kind);
                        return <button type="button" key={asset.id} onClick={() => setSelectedAsset(asset.id)} className={cn('flex w-full items-center gap-2 rounded-lg p-2 text-left', selectedAsset === asset.id ? 'bg-accent' : 'hover:bg-muted')}><Icon className="size-4" /><span className="min-w-0 flex-1 truncate text-callout">{asset.name}</span><span className="text-footnote text-muted-foreground">{formatDuration((asset.durationMs || 0) / 1000)}</span></button>;
                    })}
                    {!project.assets.length && <p className="p-4 text-callout text-muted-foreground">Import, record, or generate media to start editing.</p>}
                </div>
                {mediaUrl && media?.kind !== 'caption' && (media.hasVideo ? <video controls className="w-full rounded-xl border bg-black" src={mediaUrl} /> : <audio controls className="w-full" src={mediaUrl} />)}
                {media && <div className="rounded-xl border bg-card p-3"><p className="text-footnote font-medium">Add selected asset</p><div className="mt-2 flex flex-wrap gap-2">{media.hasVideo && <Button size="sm" onClick={() => addSelectedAsset('video')} disabled={studio.isBusy}><Film /> Add to video</Button>}{media.hasAudio && <><Button size="sm" onClick={() => addSelectedAsset('speech')} disabled={studio.isBusy}><Mic /> Add to speech</Button><Button size="sm" variant="outline" onClick={() => addSelectedAsset('music')} disabled={studio.isBusy}><Music /> Add to music</Button></>}{media.kind === 'caption' && <Button size="sm" onClick={() => addSelectedAsset('captions')} disabled={studio.isBusy}><FileAudio /> Add captions</Button>}</div><p className="mt-2 text-footnote text-muted-foreground">The clip is appended to that track. Use Timeline start to position it.</p></div>}
            </aside>
            <section className="space-y-3 xl:col-span-8">
                <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border bg-card p-3">
                    <div><h3 className="text-headline font-semibold">Non-destructive timeline</h3><p className="text-footnote text-muted-foreground">All edits reference copied assets; originals are never changed.</p></div>
                    <div className="flex gap-2"><Button variant="ghost" size="iconSm" onClick={undo} disabled={!history.undo.length} aria-label="Undo timeline edit"><Undo2 /></Button><Button variant="ghost" size="iconSm" onClick={redo} disabled={!history.redo.length} aria-label="Redo timeline edit"><Redo2 /></Button></div>
                </div>
                {(project.timeline.tracks || []).map(track => (
                    <div key={track.id} className="rounded-xl border bg-card p-3">
                        <div className="flex items-center gap-2">
                            {track.kind === 'video' ? <Film className="size-4" /> : track.kind === 'caption' ? <FileAudio className="size-4" /> : <Music className="size-4" />}
                            <span className="flex-1 text-callout font-semibold">{track.name}</span>
                            <Button variant={track.solo ? 'secondary' : 'ghost'} size="xs" onClick={() => patchTrack(track.id, { solo: !track.solo })}>Solo</Button>
                            <Button variant={track.muted ? 'secondary' : 'ghost'} size="xs" onClick={() => patchTrack(track.id, { muted: !track.muted })}>{track.muted ? 'Muted' : 'Mute'}</Button>
                        </div>
                        <div className="mt-2 space-y-2">{(track.clips || []).map((clip, clipIndex) => <ClipEditor key={clip.id} project={project} track={track} clip={clip} clipIndex={clipIndex} studio={studio} commitTimeline={commitTimeline} />)}{!track.clips?.length && <div className="rounded-lg border border-dashed p-3 text-footnote text-muted-foreground">No clips</div>}</div>
                    </div>
                ))}
                <ExportOptions project={project} studio={studio} />
            </section>
        </div>
    );
}

function RecordPanel({ project, studio }) {
    const [devices, setDevices] = useState({ microphones: [], cameras: [] });
    const [sources, setSources] = useState([]);
    const [micId, setMicId] = useState('');
    const [cameraId, setCameraId] = useState('');
    const [screenId, setScreenId] = useState('');
    const [includeMic, setIncludeMic] = useState(true);
    const [includeCamera, setIncludeCamera] = useState(true);
    const [includeScreen, setIncludeScreen] = useState(false);
    const [capture, setCapture] = useState(null);
    const [preview, setPreview] = useState(null);
    const videoRef = useRef(null);

    useEffect(() => {
        Promise.all([listPodcastDevices(), listSources()]).then(([found, screenSources]) => {
            setDevices(found); setSources(screenSources);
            setMicId(found.microphones[0]?.id || ''); setCameraId(found.cameras[0]?.id || ''); setScreenId(screenSources[0]?.id || '');
        }).catch(() => {});
    }, []);

    useEffect(() => () => preview?.getTracks().forEach(track => track.stop()), [preview]);

    useEffect(() => { if (videoRef.current) videoRef.current.srcObject = preview || capture?.streams?.find(stream => stream.getVideoTracks().length) || null; }, [preview, capture]);

    const grant = async () => {
        const found = await requestPodcastPermissions(); setDevices(found); setMicId(found.microphones[0]?.id || ''); setCameraId(found.cameras[0]?.id || '');
    };
    const previewCamera = async () => {
        preview?.getTracks().forEach(track => track.stop());
        const stream = await navigator.mediaDevices.getUserMedia({ video: { deviceId: cameraId ? { exact: cameraId } : undefined, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
        setPreview(stream);
    };
    const start = async () => {
        preview?.getTracks().forEach(track => track.stop()); setPreview(null);
        try {
            const next = await startPodcastCapture({
                projectId: project.id, microphoneId: micId, cameraId, screenSourceId: screenId,
                includeMic, includeCamera, includeScreen, timelineStartMs: project.timeline?.durationMs || 0,
                onEnded: async cause => {
                    setCapture(null);
                    if (cause) studio.setError(cause.message);
                    await studio.refreshActive();
                },
            });
            if (!next.isStopped()) setCapture(next);
        } catch (cause) { studio.setError(cause.message); }
    };
    const stop = async () => {
        try {
            await capture.stop();
        } catch (cause) {
            studio.setError(cause.message);
        } finally {
            setCapture(null);
            await studio.refreshActive();
        }
    };

    return (
        <div className="grid gap-4 lg:grid-cols-2">
            <section className="rounded-xl border bg-card p-4">
                <h3 className="text-headline font-semibold">Capture sources</h3>
                <p className="mt-1 text-footnote text-muted-foreground">Sources are fixed for a take so every track remains synchronized and recoverable.</p>
                <div className="mt-4 space-y-4">
                    <div><div className="flex items-center justify-between"><Label>Microphone</Label><Switch checked={includeMic} onCheckedChange={setIncludeMic} /></div><Select value={micId} onValueChange={setMicId} disabled={!includeMic}><SelectTrigger className="mt-2 w-full"><SelectValue placeholder="Choose microphone" /></SelectTrigger><SelectContent>{devices.microphones.map(item => <SelectItem key={item.id} value={item.id}>{item.label}</SelectItem>)}</SelectContent></Select></div>
                    <div><div className="flex items-center justify-between"><Label>Camera</Label><Switch checked={includeCamera} onCheckedChange={setIncludeCamera} /></div><Select value={cameraId} onValueChange={setCameraId} disabled={!includeCamera}><SelectTrigger className="mt-2 w-full"><SelectValue placeholder="Choose camera" /></SelectTrigger><SelectContent>{devices.cameras.map(item => <SelectItem key={item.id} value={item.id}>{item.label}</SelectItem>)}</SelectContent></Select></div>
                    <div><div className="flex items-center justify-between"><Label>Screen or window</Label><Switch checked={includeScreen} onCheckedChange={setIncludeScreen} /></div><Select value={screenId} onValueChange={setScreenId} disabled={!includeScreen}><SelectTrigger className="mt-2 w-full"><SelectValue placeholder="Choose screen" /></SelectTrigger><SelectContent>{sources.map(item => <SelectItem key={item.id} value={item.id}>{item.name}</SelectItem>)}</SelectContent></Select></div>
                </div>
                <div className="mt-4 flex flex-wrap gap-2"><Button variant="outline" onClick={grant}>Grant access</Button><Button variant="outline" onClick={previewCamera} disabled={!includeCamera || !cameraId || capture}>Preview</Button>{capture ? <Button variant="destructive" onClick={stop}><Square /> Stop take</Button> : <Button onClick={start} disabled={!isPodcastCaptureSupported() || (!includeMic && !includeCamera && !includeScreen)}><Radio /> Record take</Button>}</div>
            </section>
            <section className="relative flex min-h-80 items-center justify-center overflow-hidden rounded-xl border bg-black">
                <video ref={videoRef} autoPlay muted playsInline className="max-h-full w-full object-contain" />
                {!preview && !capture && <div className="absolute text-center text-white/70"><Camera className="mx-auto size-8" /><p className="mt-2 text-callout">Camera preview</p></div>}
            </section>
        </div>
    );
}

function ImportDialog({ open, onClose, project, studio }) {
    const [tab, setTab] = useState('rss');
    const [rssUrl, setRssUrl] = useState('');
    const [feed, setFeed] = useState(null);
    const [youtube, setYoutube] = useState(null);
    const inspect = async () => { const value = await studio.callBridge('inspectRss', rssUrl); if (value) setFeed(value); };
    const loadYouTube = async () => { const value = await studio.callBridge('listYouTube'); if (value) setYoutube(value); };
    return (
        <Dialog open={open} onOpenChange={value => !value && onClose()}>
            <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
                <DialogHeader><DialogTitle>Import podcast source</DialogTitle><DialogDescription>RSS downloads declared enclosures. YouTube imports metadata and captions only.</DialogDescription></DialogHeader>
                <Tabs value={tab} onValueChange={setTab}>
                    <TabsList className="w-full"><TabsTrigger value="rss" className="flex-1">RSS</TabsTrigger><TabsTrigger value="youtube" className="flex-1">Owned YouTube</TabsTrigger></TabsList>
                    <TabsContent value="rss" className="space-y-3"><div className="flex gap-2"><Input value={rssUrl} onChange={event => setRssUrl(event.target.value)} placeholder="https://example.com/feed.xml" /><Button onClick={inspect} disabled={!rssUrl || studio.isBusy}>Load</Button></div>{feed && <div><h3 className="font-semibold">{feed.title}</h3><div className="mt-2 space-y-2">{feed.episodes.map(episode => <div key={episode.id} className="flex items-center gap-3 rounded-lg border p-3"><div className="min-w-0 flex-1"><p className="truncate text-callout font-medium">{episode.title}</p><p className="truncate text-footnote text-muted-foreground">{episode.publishedAt}</p></div><Button size="sm" onClick={async () => { await studio.callBridge('importRss', project.id, feed, episode); onClose(); }}>Import</Button></div>)}</div></div>}</TabsContent>
                    <TabsContent value="youtube" className="space-y-3">{!studio.settings.youtubeConnected ? <p className="text-callout text-muted-foreground">Connect YouTube in the Publish tab first.</p> : <Button onClick={loadYouTube}><Youtube /> Load my videos</Button>}{youtube && <div className="space-y-2">{youtube.videos.map(video => <div key={video.id} className="flex items-center gap-3 rounded-lg border p-3"><div className="min-w-0 flex-1"><p className="truncate text-callout font-medium">{video.snippet?.title}</p><p className="text-footnote text-muted-foreground">Captions require edit permission; source video is not downloaded.</p></div><Button size="sm" onClick={async () => { await studio.callBridge('importYouTube', project.id, video); onClose(); }}>Import captions</Button></div>)}</div>}</TabsContent>
                </Tabs>
            </DialogContent>
        </Dialog>
    );
}

function PublishPanel({ project, studio }) {
    const [clientId, setClientId] = useState(studio.settings.youtubeClientId || '');
    const mp4s = project.exports.filter(item => item.format === 'mp4');
    const latest = mp4s.at(-1);
    return (
        <div className="grid gap-4 lg:grid-cols-2">
            <section className="rounded-xl border bg-card p-4">
                <div className="flex items-center gap-2"><Youtube className="size-5 text-destructive" /><h3 className="text-headline font-semibold">YouTube / YouTube Music</h3></div>
                <p className="mt-2 text-callout text-muted-foreground">Uploads are private and open in YouTube Studio for final review. Google Podcasts has been replaced by YouTube’s podcast experience.</p>
                <Label htmlFor="youtube-client" className="mt-4 block">Google OAuth client ID</Label>
                <Input id="youtube-client" className="mt-2" value={clientId} onChange={event => setClientId(event.target.value)} placeholder="Configured by the packaged app, or paste your own" />
                <div className="mt-3 flex flex-wrap gap-2"><Button variant="outline" onClick={() => studio.callBridge('saveSettings', { youtubeClientId: clientId })}><Settings2 /> Save client ID</Button>{studio.settings.youtubeConnected ? <Button variant="outline" onClick={() => studio.callBridge('disconnectYouTube')}><Check /> Connected</Button> : <Button onClick={() => studio.callBridge('connectYouTube')}><Link /> Connect YouTube</Button>}</div>
            </section>
            <section className="rounded-xl border bg-card p-4">
                <h3 className="text-headline font-semibold">Private publishing review</h3>
                <ul className="mt-3 space-y-2 text-callout text-muted-foreground"><li>• 1080p MP4 rendered locally</li><li>• AI voice disclosure included</li><li>• Private visibility enforced</li><li>• Added to a podcast playlist</li></ul>
                <div className="mt-4 flex flex-wrap gap-2"><Button variant="outline" onClick={() => studio.callBridge('render', project.id, 'mp4')}><Film /> Render MP4</Button><Button onClick={() => studio.callBridge('publishYouTube', project.id, latest?.id)} disabled={!studio.settings.youtubeConnected || !latest || studio.isBusy}><Upload /> Upload private & open Studio</Button></div>
                {latest && <p className="mt-3 text-footnote text-muted-foreground">Ready: {latest.externalPath || latest.relativePath}</p>}
                {project.publication?.studioUrl && <Button variant="link" className="mt-2 px-0" onClick={() => globalThis.open(project.publication.studioUrl, '_blank')}>Open published episode</Button>}
            </section>
        </div>
    );
}

function ProjectEditor({ studio, meetings }) {
    const project = studio.activeProject;
    const [activeTab, setActiveTab] = useState('script');
    const [importOpen, setImportOpen] = useState(false);
    const sourceMeeting = meetings.find(meeting => meeting.id === project.source?.meetingId) || null;
    const updateProject = next => studio.queueSave({ ...next, updatedAt: Date.now() });

    return (
        <div className="flex h-full flex-col gap-3 overflow-hidden">
            <div className="flex flex-wrap items-center gap-2">
                <Button variant="ghost" size="iconSm" onClick={() => studio.setActiveProject(null)} aria-label="Back to podcast projects"><ArrowLeft /></Button>
                <Input className="h-9 min-w-52 flex-1 border-0 bg-transparent px-1 text-title2 font-semibold shadow-none focus-visible:ring-0" value={project.title} onChange={event => updateProject({ ...project, title: event.target.value })} />
                <Badge variant="secondary">{project.source?.kind}</Badge>
                <Button variant="outline" size="sm" onClick={() => setImportOpen(true)}><Plus /> Import</Button>
                <Button variant="ghost" size="iconSm" className="text-destructive" onClick={async () => { if (confirm(`Delete “${project.title}” and its local media?`)) { await studio.callBridge('remove', project.id); studio.setActiveProject(null); } }} aria-label="Delete project"><Trash2 /></Button>
            </div>
            {studio.error && <div role="alert" className="flex items-center gap-2 rounded-lg bg-destructive/10 px-3 py-2 text-callout text-destructive"><CircleAlert className="size-4" /><span className="flex-1">{studio.error}</span><Button variant="ghost" size="xs" onClick={() => studio.setError(null)}>Dismiss</Button></div>}
            {studio.jobProgress?.projectId === project.id && studio.jobProgress.status === 'running' && <div role="status" className="flex items-center gap-2 rounded-lg bg-primary/10 px-3 py-2 text-callout text-primary"><LoaderCircle className="size-4 animate-spin" /><span className="capitalize">{studio.jobProgress.job}</span><div className="h-1.5 flex-1 overflow-hidden rounded-full bg-primary/20"><div className="h-full bg-primary transition-[width]" style={{ width: `${Math.round((studio.jobProgress.progress || 0) * 100)}%` }} /></div><span className="tnum text-footnote">{Math.round((studio.jobProgress.progress || 0) * 100)}%</span></div>}
            <Tabs value={activeTab} onValueChange={setActiveTab} className="flex min-h-0 flex-1 flex-col">
                <TabsList className="w-full shrink-0"><TabsTrigger value="script" className="flex-1"><Sparkles /> Script</TabsTrigger><TabsTrigger value="timeline" className="flex-1"><Scissors /> Timeline</TabsTrigger><TabsTrigger value="record" className="flex-1"><Mic /> Record</TabsTrigger><TabsTrigger value="publish" className="flex-1"><Upload /> Publish</TabsTrigger></TabsList>
                <div className="min-h-0 flex-1 overflow-y-auto pt-3"><TabsContent value="script"><ScriptPanel project={project} sourceMeeting={sourceMeeting} studio={studio} updateProject={updateProject} /></TabsContent><TabsContent value="timeline"><TimelinePanel project={project} studio={studio} updateProject={updateProject} /></TabsContent><TabsContent value="record"><RecordPanel project={project} studio={studio} /></TabsContent><TabsContent value="publish"><PublishPanel project={project} studio={studio} /></TabsContent></div>
            </Tabs>
            <ImportDialog open={importOpen} onClose={() => setImportOpen(false)} project={project} studio={studio} />
        </div>
    );
}

export function PodcastStudio({ meetings = [], activeMeeting = null }) {
    const studio = usePodcastStudio();
    const availableMeetings = useMemo(() => {
        const map = new Map(meetings.map(meeting => [meeting.id, meeting]));
        if (activeMeeting?.id) map.set(activeMeeting.id, activeMeeting);
        return Array.from(map.values()).filter(meeting => (meeting.transcript || []).length > 0);
    }, [meetings, activeMeeting]);
    if (!studio.isDesktop) return <EmptyDesktop />;
    return studio.activeProject ? <ProjectEditor studio={studio} meetings={availableMeetings} /> : <StudioHome studio={studio} meetings={availableMeetings} />;
}
