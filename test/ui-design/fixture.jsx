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
    summarySections: [
        { heading: 'Product direction', bullets: [
            { text: 'Ship AI search by October 15, with a scope freeze this week.', sourceTurnIds: ['turn-1'] },
            { text: 'Move the onboarding redesign to Q1 to leave time for research.', sourceTurnIds: ['turn-5'] },
        ] },
        { heading: 'Design & collaboration', bullets: [
            { text: 'Run another round of filter usability testing before finalizing the experience.', sourceTurnIds: ['turn-2'] },
            { text: 'Bring the data team into the Friday review.', sourceTurnIds: ['turn-3'] },
        ] },
    ],
    actionItems: [{ id: 'task1', task: 'Schedule filter UX test — Friday', owner: 'Alex Rivera', deadline: 'Sep 12', completed: false }],
    keyDecisions: ['Ship AI search by Oct 15.'],
    metadata: { collectionId: 'product', tags: ['roadmap', 'ai'], noiseLevel: 'low' },
    recording: { videoPath: 'fixture.webm', durationMs: 25000, startedAtMs: today.getTime(), mode: 'screen' },
};
window.fixtureCalls = [];
const commitmentCandidates = [
    { id: 'promise', classification: 'explicit_commitment', person: 'Alex Rivera', speaker: 'Alex Rivera', targetAction: 'Send a calendar invite', commitment: "I'll send a cal invite after this.", dueDate: '', sourceTurnIds: ['turn-4'], startMs: 16000, confidence: 'high', confidenceReason: 'Explicit promise; review the speaker label.', status: 'pending', references: [] },
    { id: 'suggestion', classification: 'suggested_action', person: '', speaker: 'Maya Chen', targetAction: 'Schedule a Friday session', commitment: "Let's schedule a Friday session.", dueDate: 'Friday', sourceTurnIds: ['turn-3'], startMs: 12000, confidence: 'medium', confidenceReason: 'A suggestion has no accepted owner yet.', status: 'pending', references: [] },
    { id: 'unclear', classification: 'unclear', person: '', speaker: 'Sam Park', targetAction: 'Review the filter UX', commitment: "I'd push back on the filter UX — it needs one more round of testing.", dueDate: '', sourceTurnIds: ['turn-2'], startMs: 8000, confidence: 'low', confidenceReason: 'No unambiguous promise.', status: 'pending', references: [] },
];
let commitments = null;
const actionSuggestions = [
    ['local', 'action_item', 'Review API design', 'local_task'],
    ['promise-action', 'commitment', 'Check with engineering', 'local_task'],
    ['followup-action', 'follow_up', 'Follow up with the data team', 'local_task'],
    ['calendar-action', 'calendar', 'Schedule follow-up next Tuesday', 'google_calendar'],
    ['email-action', 'email', 'Send proposal to Acme', 'local_draft'],
    ['jira-action', 'jira', 'Create Jira ticket', 'jira'],
].map(([id, kind, title, destination]) => ({ id, kind, title, destination, person: 'Alex Rivera', dueDate: kind === 'calendar' ? 'next Tuesday' : '', classification: kind === 'commitment' ? 'explicit_commitment' : 'suggested_action', sourceTurnIds: ['turn-4'], excerpt: transcript[4].text, startMs: 16000, revision: 'fixture-action-source', body: kind === 'email' ? 'Please review the proposal.' : '' }));
const actionProviders = { google_calendar: { connected: true, account: 'alex@example.com', revision: 'fixture-google-target' }, jira: { connected: true, account: 'alex@example.com', siteUrl: 'https://example.atlassian.net', projectKey: 'API', issueType: 'Task', revision: 'fixture-jira-target' } };
for (const destination of ['slack', 'jira']) actionSuggestions.push({ id: `summary-${destination}`, kind: `summary_${destination}`, title: base.title, destination, person: '', dueDate: '', classification: 'generated_summary', sourceTurnIds: [], excerpt: '', startMs: null, revision: 'fixture-summary-source', body: `Meeting: ${base.title}\nDate: 2026-10-06 (UTC)\n\nReviewed meeting recap.` });
actionProviders.slack = { connected: true, channelLabel: '#meeting-recaps', revision: 'fixture-slack-target', autoPush: false };
let actionHistory = [];

const chatThread = { id: 'fixture-chat', title: 'Roadmap decisions', scope: { type: 'all' } };
const chatAnswer = {
    requestId: 'fixture-request', role: 'assistant',
    content: '**Ship AI search by Oct 15 [1].**\n\n- Alex will schedule the review _[1]_.\n- Older source [2]; unknown reference [99].\n\nLiteral code: `[1]`',
    citations: [
        { number: 1, title: base.title, startedAt: base.startedAt, meetingId: base.id, sourceRevision: 'fixture-revision', turnIds: ['turn-1'], startMs: 4000, excerpt: transcript[1].text },
        { number: 2, title: 'Removed meeting', available: false, unavailableReason: 'Source unavailable' },
    ],
};
Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
    writeText: async text => {
        if (window.fixtureCopyFails) throw new Error('Clipboard denied');
        window.fixtureCopiedText = text;
    },
} });
const execCommand = document.execCommand.bind(document);
document.execCommand = (command, ...rest) => (command === 'copy' && window.fixtureCopyFails ? false : execCommand(command, ...rest));
window.fetch = async (url, options = {}) => {
    const path = new URL(url).pathname;
    const body = options.body ? JSON.parse(options.body) : null;
    window.fixtureCalls.push({ path, method: options.method || 'GET', body });
    if (path.startsWith(`/api/meetings/${base.id}/commitments`)) {
        if (window.fixtureCommitmentsFails) return new Response(JSON.stringify({ error: 'Synthetic commitment service unavailable' }), { status: 503 });
        if (!body) return new Response(JSON.stringify(commitments ? { ...commitments, current: true } : { current: false, candidates: [] }));
        if ((options.method || 'GET') === 'POST') {
            commitments ||= { version: 1, transcriptRevision: 'fixture-transcript', coverage: 'complete', candidates: commitmentCandidates.map(item => ({ ...item })) };
        } else {
            const item = commitments.candidates.find(candidate => candidate.id === path.split('/').at(-1));
            item.status = body.status;
            if (body.status === 'confirmed') {
                item.reviewedPerson = body.person;
                item.reviewedAction = body.targetAction;
                item.actionItemId = item.id;
                window.fixtureMeeting.actionItems = [...window.fixtureMeeting.actionItems, { id: item.id, task: body.targetAction, owner: body.person, deadline: item.dueDate, completed: false }];
            }
        }
        return new Response(JSON.stringify({ meeting: { ...window.fixtureMeeting, metadata: { ...window.fixtureMeeting.metadata, meetingCommitments: commitments } } }));
    }
    if (path.startsWith(`/api/meetings/${base.id}/actions`)) {
        if (window.fixtureActionsFails) return new Response(JSON.stringify({ error: 'Synthetic actions unavailable' }), { status: 503 });
        if (!body) return new Response(JSON.stringify({ suggestions: window.fixtureActionsEmpty ? [] : window.fixtureActionSourceChanged ? actionSuggestions.map(s => ({ ...s, revision: 'edited-source', excerpt: 'Edited transcript statement' })) : actionSuggestions, history: actionHistory, providers: { ...actionProviders, slack: { ...actionProviders.slack, connected: !window.fixtureSlackDisconnected, revision: window.fixtureSlackTargetRevision || actionProviders.slack.revision } } }));
        const id = path.split('/').at(-1), source = actionSuggestions.find(s => s.id === id);
        if (!body.confirmed) return new Response(JSON.stringify({ error: 'Confirmation is required' }), { status: 400 });
        let record = actionHistory.find(r => r.id === id);
        if (!record) { record = { id, source, review: body, attempts: 0 }; actionHistory.push(record); }
        if (record.status === 'succeeded') return new Response(JSON.stringify({ meeting: window.fixtureMeeting }));
        record.attempts++; record.review = body;
        const failed = window.fixtureActionPermission && ['jira', 'google_calendar', 'slack'].includes(body.destination);
        record.status = failed ? 'failed' : window.fixtureActionUnknown && body.destination === 'jira' ? 'unknown' : 'succeeded';
        if (failed) record.error = { code: 'permission_required', message: 'Connect this provider in Settings, then review and confirm again.', retryable: true };
        else if (record.status === 'unknown') record.error = { code: 'outcome_unknown', message: 'The provider may have created this action. Check the provider; Kesami will not resend it.', retryable: false };
        else { delete record.error; record.result = body.destination === 'local_draft' ? { local: true, sent: false, draft: { subject: body.title, body: body.body, recipients: body.recipients } } : { id: 'fixture-created' }; }
        const updated = { ...window.fixtureMeeting, metadata: { ...window.fixtureMeeting.metadata, postMeetingActions: { version: 1, items: actionHistory } } };
        if (!failed && record.status === 'succeeded' && body.destination === 'local_task' && !updated.actionItems.some(t => t.workflowActionId === id)) updated.actionItems = [...updated.actionItems, { id: `task-${id}`, task: body.title, owner: body.person, deadline: body.dueDate, completed: false, workflowActionId: id }];
        return new Response(JSON.stringify({ meeting: updated }));
    }
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
    if (path === '/api/auth/config') {
        if (window.fixtureAuthOffline) throw new Error('Engine unavailable');
        return new Response(JSON.stringify(window.fixtureCloud
            ? { registrationAllowed: true, cloudManaged: true, googleAuth: { provider: 'supabase', configured: window.fixtureGoogleConfigured !== false, url: 'https://project.supabase.co' } }
            : { registrationAllowed: true, googleClientId: window.fixtureGoogleConfigured === false ? '' : 'fixture.apps.googleusercontent.com' }));
    }
    if (path === '/api/auth/supabase/google' || path === '/api/auth/google') {
        return new Response(JSON.stringify({ token: 'fixture-google-session', account: { id: 'fixture-google', name: 'Asha Verma', email: 'asha@work.com', authProvider: 'google' } }));
    }
    if (path === '/api/billing/subscription') return new Response(JSON.stringify({
        tier: 'free', subscription: null, billing: { billingEnabled: false },
        usage: { minutesUsed: 0, freeMonthlyMinutes: 120, canRecord: true },
    }));
    if (path === '/api/plans') return new Response(JSON.stringify({ billingEnabled: false, billing: { razorpay: false, stripe: false }, plans: [
        { id: 'free', name: 'Free', status: 'available', requiresAccount: false, prices: [{ amountMinor: 0, currency: 'USD', interval: null }], description: 'Your meetings, on your device.', features: ['2 hours of meeting recording per month', '3 shared AI summaries or chat replies per month', 'Keep and export your meeting library'], note: 'Sign in with Google to transcribe meetings and use meeting AI. Your library stays on this computer.' },
        { id: 'pro', name: 'Pro', status: 'available', requiresAccount: true, prices: [{ amountMinor: 49900, currency: 'INR', interval: 'month', provider: 'razorpay' }, { amountMinor: 1000, currency: 'USD', interval: 'month', provider: 'stripe' }], description: 'Unlimited recording and AI summaries, per user.', features: ['Unlimited meeting recording', 'AI meeting summaries and action items', 'AI chat over your meetings'], note: 'Billed per user.' },
        { id: 'enterprise', name: 'Enterprise', status: 'contact', requiresAccount: true, prices: [], description: 'Custom pricing for teams and organizations.', features: ['Volume and multi-workspace licensing'], note: 'Team plans are coming later.' },
    ] }));
    if (path === '/api/auth/password') return new Response(JSON.stringify({ token: 'fixture-rotated-session', account: { id: 'fixture-account', name: 'Asha Verma', email: 'asha@work.com' } }));
    if (path === '/api/chat/index/status') return new Response(JSON.stringify({ mode: 'hybrid', pendingChunks: 0 }));
    return new Response('{}');
};

function Fixture({ theme }) {
    const [view, setView] = useState('home');
    const [empty, setEmpty] = useState(false);
    window.fixtureSetEmpty = setEmpty;
    const [noise, setNoise] = useState(true);
    const [account, setAccount] = useState(null);
    window.fixtureSetAccount = setAccount;
    const [entered, setEntered] = useState(false);
    window.fixtureEnterWorkspace = () => setEntered(true);
    window.fixtureSignOut = () => setEntered(false);
    const [meeting, setMeeting] = useState(base);
    window.fixtureMeeting = meeting;
    window.fixtureBase = base;
    window.fixturePatchMeeting = updates => setMeeting(value => ({ ...value, ...updates }));
    window.fixtureSpeakerEdits = window.fixtureSpeakerEdits || [];
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
            window.kesamiRecorder = { mediaUrl: () => url };
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
    if (!entered) {
        return (
            <SignInView
                theme={theme}
                onToggleTheme={window.fixtureSetTheme}
                onAuthenticated={value => {
                    window.fixtureAuthenticated = value;
                    setAccount(value);
                    setEntered(true);
                }}
            />
        );
    }
    return (
        <DesignWorkspace
            theme={theme}
            onToggleTheme={() => window.fixtureSetTheme(theme === 'dark' ? 'light' : 'dark')}
            onNewMeeting={() => { window.fixtureScheduleOpened = true; }}
            noiseSuppression={noise}
            onUpdateSettings={async settings => { setNoise(settings.noiseSuppression); return { ok: true, persisted: true }; }}
            activeTab={view}
            setActiveTab={setView}
            meeting={meeting}
            turns={meeting.transcript}
            interimTurns={recording && !paused ? [{ id: 'interim-system', speaker: 'Sam Park', stream: 'system', text: 'One more thing before we', interim: true }] : []}
            history={{
                meetings: empty ? [] : [
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
                events: empty ? [] : ['Q4 Product Roadmap', 'Design System Weekly', '1:1 with Alex'].map((title, i) => ({
                    id: i,
                    title,
                    start: new Date(today.getTime() + i * 14400000).toISOString(),
                    end: new Date(today.getTime() + (i * 14400 + 3600) * 1000).toISOString(),
                })),
                providers: [{ provider: 'google', label: 'Google Calendar', connected: true, configured: true }],
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
            onSettings={tab => {
                window.settingsOpened = true;
                window.settingsTabOpened = tab;
            }}
            onSelectMeeting={(selected, target) => { window.fixtureSourceTarget = target; setView('live'); }}
            onUpdate={updates => setMeeting(value => ({ ...value, ...updates }))}
            onUpdateCommitments={async (id, body = {}) => {
                const response = await window.fetch(`http://127.0.0.1:48900/api/meetings/${base.id}/commitments${id ? `/${id}` : ''}`, { method: id ? 'PATCH' : 'POST', body: JSON.stringify(body) });
                const data = await response.json();
                if (!response.ok) return { ok: false, message: data.error };
                setMeeting(data.meeting);
                return { ok: true, meeting: data.meeting };
            }}
            onUpdatePostMeetingAction={async (id, body) => {
                const response = await window.fetch(`http://127.0.0.1:48900/api/meetings/${base.id}/actions/${id}`, { method: 'POST', body: JSON.stringify(body) });
                const data = await response.json();
                if (!response.ok) return { ok: false, message: data.error };
                setMeeting(data.meeting); return { ok: true, meeting: data.meeting };
            }}
            onRenameSpeaker={async (from, to) => {
                window.fixtureSpeakerEdits.push(['all', from, to]);
                setMeeting(value => ({ ...value, transcript: value.transcript.map(turn => (turn.speaker === from ? { ...turn, speaker: to, speakerEdited: true } : turn)) }));
                return { ok: true };
            }}
            onChangeTurnSpeaker={async (turnId, to) => {
                window.fixtureSpeakerEdits.push(['line', turnId, to]);
                setMeeting(value => ({ ...value, transcript: value.transcript.map(turn => (turn.id === turnId ? { ...turn, speaker: to, speakerEdited: true } : turn)) }));
                return { ok: true };
            }}
            onAddNote={async () => ({ ok: true })}
            onDeleteNote={noop}
            onExport={noop}
            onRetry={noop}
            onDismiss={noop}
            account={account}
            onAccountChange={setAccount}
            onSignOut={() => setEntered(false)}
            license={{ tier: 'free' }}
        />
    );
}

const root = createRoot(document.getElementById('root'));

function paint(theme) {
    document.documentElement.classList.toggle('dark', theme === 'dark');
    root.render(
        <TooltipProvider delayDuration={400} skipDelayDuration={200}>
            <div className="ks-app" data-theme={theme}>
                <Fixture theme={theme} />
            </div>
        </TooltipProvider>
    );
}

window.fixtureSetTheme = paint;
paint('dark');
