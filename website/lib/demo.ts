// The one fictional account every mock on the page follows — the hero brief, the memory chain, the
// commitments, Ask and the follow-through tour — so they agree to the word. Shapes copy the app's own:
// a brief has sections with source timestamps, decisions, and next steps with an owner and a due date
// (apps/core-backend/src/summarizer.rs); an Ask answer cites meeting, timestamp, date and quote
// (apps/ui/src/components/MeetingChatPanel.jsx).

export type Tone = 'you' | 'speaker-1' | 'speaker-2' | 'speaker-3';

export const FOLDER = 'Acme';

export const MEETINGS = {
    discovery: { title: 'Acme — discovery call', short: 'Discovery call', date: 'Jul 14', folder: FOLDER, minutes: 44 },
    technical: { title: 'Acme — technical review', short: 'Technical review', date: 'Aug 21', folder: FOLDER, minutes: 52 },
    pricingSync: { title: 'Weekly pricing sync', short: 'Pricing sync', date: 'Sep 24', folder: 'Pricing', minutes: 27 },
    customer: { title: 'Customer discussion — Acme', short: 'Customer discussion', date: 'Sep 29', folder: FOLDER, minutes: 38 },
    northwind: { title: 'Northwind — renewal call', short: 'Renewal call', date: 'Sep 17', folder: 'Northwind', minutes: 31 },
    globex: { title: 'Globex — onboarding', short: 'Onboarding', date: 'Sep 9', folder: 'Globex', minutes: 46 },
} as const;

export type MeetingId = keyof typeof MEETINGS;

// The Sep 29 call, as the transcript shows it.
export const CALL = [
    { t: '31:48', who: 'Priya', tone: 'speaker-1', text: 'Before we sign, we need the annual pricing in writing.' },
    { t: '32:10', who: 'You', tone: 'you', text: 'I’ll send you the pricing proposal by Friday.' },
    { t: '32:31', who: 'Priya', tone: 'speaker-1', text: 'Friday works. Does that include SSO?' },
    { t: '33:40', who: 'You', tone: 'you', text: 'It will. SSO goes in the proposal, not as an add-on.' },
    { t: '34:12', who: 'John', tone: 'speaker-2', text: 'The rate-limit question is still open on our side.' },
    { t: '34:30', who: 'Kabir', tone: 'speaker-3', text: 'I’ll send Priya the pilot timeline tomorrow.' },
] as const satisfies readonly { t: string; who: string; tone: Tone; text: string }[];

export const PEOPLE = [
    { name: 'Priya', tone: 'speaker-1' },
    { name: 'John', tone: 'speaker-2' },
    { name: 'Kabir', tone: 'speaker-3' },
    { name: 'You', tone: 'you' },
] as const satisfies readonly { name: string; tone: Tone }[];

export const SUMMARY =
    'Acme is ready to sign once the annual pricing is in writing. You’ll send the proposal by Friday, with SSO included rather than sold as an add-on. John’s rate-limit question is still open.';

export const DECISIONS = ['SSO is included in Acme’s proposal, not sold as an add-on', 'Acme moves to an annual plan once the proposal is agreed'];

// The meeting's next steps exactly as the app lists them: owner, due date (free text), done or not.
export const NEXT_STEPS = [
    { task: 'Send Acme the pricing proposal', owner: 'You', due: 'Due Friday', done: false },
    { task: 'Send Priya the pilot timeline', owner: 'Kabir', due: 'Due tomorrow', done: true },
    { task: 'Confirm rate limits for the nightly sync', owner: 'John', due: 'No due date', done: false },
] as const;

export const EMAIL = {
    subject: 'Your pricing proposal — next steps',
    body: [
        'Hi Priya,',
        'Thanks for the time today. As promised, the annual pricing proposal will be with you by Friday, with SSO included.',
        'Kabir is sending the pilot timeline separately, and we’ll close out the rate-limit question with John.',
    ],
};

export type Source = { id: MeetingId; t: string; who: string; quote: string };

export type Answer = { label: string; q: string; scope: string; coverage: string; parts: (string | number)[]; sources: Source[] };

// Numbers in `parts` are citations, 1-based into `sources`, as the app numbers them.
export const ANSWERS: Answer[] = [
    {
        label: 'Promises to Acme',
        q: 'What have I promised Acme?',
        scope: FOLDER,
        coverage: 'Evidence from 3 of 3 meetings',
        parts: [
            'Three things. A sandbox account before their pilot',
            1,
            ', the API rate-limit doc for John',
            2,
            ', and the pricing proposal, which you told Priya she’d have by Friday',
            3,
            '.',
        ],
        sources: [
            { id: 'discovery', t: '41:05', who: 'You', quote: 'We’ll have a sandbox account ready before your pilot starts.' },
            { id: 'technical', t: '18:42', who: 'You', quote: 'I’ll share our rate-limit doc with John this week.' },
            { id: 'customer', t: '32:10', who: 'You', quote: 'I’ll send you the pricing proposal by Friday.' },
        ],
    },
    {
        label: 'Pricing decisions',
        q: 'What did we decide about pricing?',
        scope: 'All meetings',
        coverage: 'Evidence from 2 of 6 meetings',
        parts: [
            'Annual plans get 15% off; Aditi called it final in the pricing sync',
            1,
            '. For Acme, SSO goes into the proposal instead of being sold as an add-on',
            2,
            '.',
        ],
        sources: [
            { id: 'pricingSync', t: '12:20', who: 'Aditi', quote: 'Fifteen percent off for annual. Let’s call that final.' },
            { id: 'customer', t: '33:40', who: 'You', quote: 'SSO goes in the proposal, not as an add-on.' },
        ],
    },
    {
        label: 'John’s API feedback',
        q: 'What did John say about the API?',
        scope: FOLDER,
        coverage: 'Evidence from 2 of 3 meetings',
        parts: [
            'Their nightly sync needs more than 100 requests a minute',
            1,
            ', and he asked for webhooks so they can stop polling',
            2,
            '. On Sep 29 he said the rate-limit question was still open',
            3,
            '.',
        ],
        sources: [
            { id: 'technical', t: '16:05', who: 'John', quote: 'Our nightly sync will blow through a hundred requests a minute.' },
            { id: 'technical', t: '21:30', who: 'John', quote: 'Webhooks would save us polling every five minutes.' },
            { id: 'customer', t: '34:12', who: 'John', quote: 'The rate-limit question is still open on our side.' },
        ],
    },
    {
        label: 'Recurring customer issues',
        q: 'Which customer issues keep coming up?',
        scope: 'All meetings',
        coverage: 'Evidence from 4 of 6 meetings',
        parts: [
            'SSO setup, in three customer calls: Globex',
            1,
            ', Northwind',
            2,
            ' and Acme',
            3,
            '. API rate limits, in both of Acme’s technical conversations',
            4,
            '.',
        ],
        sources: [
            { id: 'globex', t: '09:14', who: 'Dana', quote: 'Our IT team won’t roll it out without SSO.' },
            { id: 'northwind', t: '22:47', who: 'Leo', quote: 'SSO is the one thing blocking the renewal.' },
            { id: 'customer', t: '32:31', who: 'Priya', quote: 'Friday works. Does that include SSO?' },
            { id: 'technical', t: '16:05', who: 'John', quote: 'Our nightly sync will blow through a hundred requests a minute.' },
        ],
    },
];
