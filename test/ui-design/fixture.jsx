// Isolated visual fixtures. Never imported by the application or its build.
import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { DesignWorkspace } from '../../apps/ui/src/components/design/DesignWorkspace';
import { SignInView } from '../../apps/ui/src/components/design/SignInView';
import { TooltipProvider } from '../../apps/ui/src/components/ui/tooltip';
import '../../apps/ui/src/design.css';

const noop = () => {};
const today = new Date();
today.setHours(10, 0, 0, 0);
const folders = [
    { id: 'product', name: 'Product' },
    { id: 'design', name: 'Design Sync' },
    { id: 'engineering', name: 'Engineering' },
    { id: 'ones', name: '1:1s' },
    { id: 'investors', name: 'Investors' },
];
const transcript = [
    ['Maya Chen', "Okay, let's kick off — we have a packed agenda. First item: AI search timeline."],
    ['Alex Rivera', "We're on track for Oct 15 if we freeze scope this week. The indexing pipeline is solid."],
    ['Sam Park', "Design-wise we're good. I'd push back on the filter UX — it needs one more round of testing."],
    ['Maya Chen', "Agreed. Let's schedule a Friday session. Alex, can you loop in the data team?"],
    ['Alex Rivera', "Done. I'll send a cal invite after this."],
    ['Jo Nguyen', 'On the onboarding side — I think pushing to Q1 is the right call. We need the research first.'],
].map(([speaker, text], index) => ({ id: `turn-${index}`, speaker, text, startMs: index * 4000, endMs: index * 4000 + 3500 }));
const base = {
    id: 'fixture-roadmap',
    title: 'Q4 Product Roadmap Review',
    startedAt: today.getTime(),
    endedAt: today.getTime() + 3120000,
    durationSeconds: 3120,
    transcript,
    participants: ['Maya Chen', 'Alex Rivera', 'Sam Park', 'Jo Nguyen'],
    summaryMarkdown:
        'Team aligned on shipping the AI search feature by Oct 15. Pushed onboarding redesign to Q1. Budget approved for 2 additional engineers.',
    actionItems: [{ id: 'task1', task: 'Schedule filter UX test — Friday', owner: 'Alex Rivera', deadline: 'Sep 12', completed: false }],
    keyDecisions: ['Ship AI search by Oct 15.'],
    metadata: { collectionId: 'product', tags: ['roadmap', 'ai'], noiseLevel: 'low' },
    recording: { videoPath: 'fixture.webm', durationMs: 25000, startedAtMs: today.getTime(), mode: 'screen' },
};
window.fixtureCalls = [];
const chatThread = { id: 'fixture-chat', title: 'Roadmap decisions', scope: { type: 'all' } };
const chatAnswer = {
    requestId: 'fixture-request', role: 'assistant',
    content: '**Ship AI search by Oct 15 [1].**\n\n- Alex will schedule the review _[1]_.\n- Older source [2]; unknown reference [99].\n\nLiteral code: `[1]`',
    citations: [
        { number: 1, title: base.title, meetingId: base.id, sourceRevision: 'fixture-revision', turnIds: ['turn-1'], startMs: 4000, excerpt: transcript[1].text },
        { number: 2, title: 'Removed meeting', available: false, unavailableReason: 'Source unavailable' },
    ],
};
Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
    writeText: async text => {
        if (window.fixtureCopyFails) throw new Error('Clipboard denied');
        window.fixtureCopiedText = text;
    },
} });
window.fetch = async (url, options = {}) => {
    const path = new URL(url).pathname;
    const body = options.body ? JSON.parse(options.body) : null;
    window.fixtureCalls.push({ path, method: options.method || 'GET', body });
    if (path === '/api/folders') {
        if (body) folders.push({ id: 'new-folder', name: body.name });
        return new Response(JSON.stringify({ folders }));
    }
    if (path === '/api/chat/threads') return new Response(JSON.stringify(body ? { id: 'fixture-live-chat', scope: body.scope } : { threads: [chatThread] }));
    if (path === '/api/chat/threads/fixture-live-chat/messages') {
        return new Response(JSON.stringify({ answer: 'So far, AI search is planned for Oct 15 [1].', citations: chatAnswer.citations,
            coverage: { live: true, capturedThroughMs: 23500, eligibleMeetings: 1, retrievedMeetings: 1 } }));
    }
    if (path === '/api/chat/threads/fixture-chat/messages') {
        if (body) return new Response(JSON.stringify({ answer: 'The target is Oct 15 [1].', citations: chatAnswer.citations }));
        return new Response(JSON.stringify({ messages: [
            { role: 'user', requestId: 'fixture-request', content: 'What decisions did we make?' }, chatAnswer,
        ] }));
    }
    if (path === `/api/chat/sources/${base.id}`) return new Response(JSON.stringify({ meeting: base }));
    if (path === '/api/chat/index/status') return new Response(JSON.stringify({ mode: 'hybrid', pendingChunks: 0 }));
    return new Response('{}');
};

function Fixture() {
    const [view, setView] = useState('home');
    const [entered, setEntered] = useState(false);
    const [meeting, setMeeting] = useState(base);
    const [recording, setRecording] = useState(false);
    const [paused, setPaused] = useState(false);
    useEffect(() => {
        const canvas = document.createElement('canvas');
        canvas.width = 1280;
        canvas.height = 720;
        const context = canvas.getContext('2d');
        context.fillStyle = '#0e0e0f';
        context.fillRect(0, 0, 1280, 720);
        context.fillStyle = '#e8e8ea';
        context.font = '32px sans-serif';
        context.fillText('Q4 Product Roadmap', 48, 76);
        for (let i = 0; i < 3; i++) {
            context.fillStyle = i ? '#1e1e21' : '#ff7a1a22';
            context.fillRect(48, 150 + i * 75, 700, 54);
            context.fillStyle = i ? '#6b6b74' : '#ff7a1a';
            context.font = '20px sans-serif';
            context.fillText(['AI Search · Oct 15', 'Onboarding Redesign · Q1 2027', 'Mobile App · Q2 2027'][i], 72, 184 + i * 75);
        }
        const stream = canvas.captureStream(1);
        const recorder = new MediaRecorder(stream, { mimeType: 'video/webm' });
        const chunks = [];
        recorder.ondataavailable = event => chunks.push(event.data);
        recorder.onstop = () => {
            const url = URL.createObjectURL(new Blob(chunks, { type: 'video/webm' }));
            window.alphaRecorder = { mediaUrl: () => url };
            stream.getTracks().forEach(track => track.stop());
            window.fixtureReady = true;
        };
        recorder.start();
        const timer = setTimeout(() => recorder.stop(), 1100);
        return () => {
            clearTimeout(timer);
            stream.getTracks().forEach(track => track.stop());
        };
    }, []);
    if (!entered) return <SignInView onContinue={() => setEntered(true)} />;
    return (
        <DesignWorkspace
            activeTab={view}
            setActiveTab={setView}
            meeting={meeting}
            turns={meeting.transcript}
            interimTurns={recording && !paused ? [{ id: 'interim-system', speaker: 'Sam Park', stream: 'system', text: 'One more thing before we', interim: true }] : []}
            history={{
                meetings: [
                    meeting,
                    {
                        ...base,
                        id: 'fixture-design',
                        title: 'Design System Weekly',
                        metadata: { collectionId: 'design', noiseLevel: 'medium', tags: ['tokens', 'components'] },
                        summaryMarkdown: 'Agreed on new token naming convention. Component library migration plan finalized for October.',
                        participants: ['Sam Park', 'Leila Moss'],
                        durationSeconds: 2280,
                    },
                    {
                        ...base,
                        id: 'fixture-engineering',
                        title: 'Engineering All-Hands',
                        metadata: { collectionId: 'engineering', noiseLevel: 'high', tags: ['infra', 'performance'] },
                        summaryMarkdown:
                            'Infrastructure migration to Kubernetes complete. On-call rotation updated. Performance budget set at 200ms p95.',
                        durationSeconds: 4320,
                    },
                ],
                reload: noop,
                deleteMeeting: async () => true,
            }}
            calendar={{
                events: ['Q4 Product Roadmap', 'Design System Weekly', '1:1 with Alex'].map((title, i) => ({
                    id: i,
                    title,
                    start: new Date(today.getTime() + i * 14400000).toISOString(),
                    end: new Date(today.getTime() + (i * 14400 + 3600) * 1000).toISOString(),
                })),
                providers: [{ connected: true }],
            }}
            session={{
                isRecording: recording && !paused,
                isPaused: paused,
                isProcessing: false,
                durationSeconds: 14,
                audioLevels: { mic: 72, system: 48 },
                onStart: () => {
                    setMeeting(value => ({ ...value, endedAt: null }));
                    setRecording(true);
                    setView('live');
                },
                onStop: () => {
                    setMeeting(value => ({ ...value, endedAt: base.endedAt }));
                    setRecording(false);
                    setPaused(false);
                },
                onPause: () => setPaused(true),
                onResume: () => setPaused(false),
                onToggleMic: noop,
                onToggleSystem: noop,
            }}
            isConnected
            connection="online"
            onSettings={() => {
                window.settingsOpened = true;
            }}
            onSelectMeeting={(selected, target) => { window.fixtureSourceTarget = target; setView('live'); }}
            onUpdate={updates => setMeeting(value => ({ ...value, ...updates }))}
            onRenameSpeaker={async () => ({ ok: true })}
            onAddNote={async () => ({ ok: true })}
            onDeleteNote={noop}
            onExport={noop}
            onRetry={noop}
            onDismiss={noop}
            onSignOut={() => setEntered(false)}
            license={{ tier: 'pro' }}
        />
    );
}

createRoot(document.getElementById('root')).render(
    <TooltipProvider>
        <div className="ks-app">
            <Fixture />
        </div>
    </TooltipProvider>
);
