import type { Metadata } from 'next';
import { LegalPage } from '@/components/LegalPage';

export const metadata: Metadata = {
    title: 'Privacy policy',
    description: 'How Kesami accesses, uses, stores and shares meeting data and Google account information.',
    alternates: { canonical: '/privacy' },
    openGraph: {
        title: 'Privacy policy — Kesami',
        description: 'How Kesami accesses, uses, stores and shares meeting data and Google account information.',
        type: 'website',
        url: '/privacy',
        siteName: 'Kesami',
        locale: 'en_US',
    },
};

// Data flows: docs/HOW-KESAMI-WORKS.md, apps/desktop/googleSignIn.js,
// apps/core-backend/src/calendar.rs, app/layout.tsx.
export default function PrivacyPolicy() {
    return (
        <LegalPage
            title="Privacy policy"
            intro="This policy explains how Kesami handles information when you visit this website or use the Kesami desktop meeting assistant."
        >
            <section>
                <h2>Meeting recordings and your library</h2>
                <p>
                    Kesami captures microphone and system audio when you start recording. Screen recordings are captured when you choose that feature.
                    Recordings, transcripts and summaries are saved on your computer, normally in Documents / Kesami Meetings. Local databases also
                    support features such as meeting search and chat history. Signing in does not automatically sync your meeting library to the
                    cloud.
                </p>
                <p>
                    You control what you record. Obtain the permissions and participant consent required for your meeting before recording or sharing
                    it. People using the same Kesami workspace on a computer may have access to the same meeting library.
                </p>
            </section>
            <section>
                <h2>Cloud transcription and AI</h2>
                <p>
                    Local storage does not mean all processing happens on your computer. During live transcription, audio is sent through Kesami’s
                    cloud relay to Sarvam for speech recognition. When a summary is generated (automatically when a recording ends, unless you turn
                    that off in settings) or you ask an AI question, the meeting transcript or the relevant excerpts and your request are sent for AI
                    processing, including to Google Gemini and, as a fallback, OpenAI. Provider configuration can differ in development builds.
                </p>
                <p>
                    These services receive the content needed to fulfil the requested feature. Their processing and retention are also governed by
                    their applicable service terms and privacy policies. This policy does not promise that external providers never retain data.
                </p>
            </section>
            <section>
                <h2>Google sign-in</h2>
                <p>
                    When you choose Continue with Google, Kesami requests basic account information through the openid, email and profile permissions.
                    This can include your Google account identifier, email address, name and profile picture. Release builds use Supabase
                    Authentication to manage sign-in and sessions. Account and session information is used to identify you, authenticate requests and
                    provide access to hosted features.
                </p>
                <p>
                    Authentication services store account records and session information. The desktop app retains session credentials so you can stay
                    signed in. Signing in alone does not grant access to your Gmail, Google Drive files or Calendar events.
                </p>
            </section>
            <section>
                <h2>Google Calendar permissions</h2>
                <p>
                    If you connect Google Calendar, Kesami requests Calendar event permissions separately. The integration accesses event details such
                    as titles, times, descriptions, attendees and meeting links to display your schedule and help you join meetings. It can also
                    create an event when you use the event creation feature. OAuth credentials are used to make these authorized requests and renew
                    access where supported.
                </p>
                <p>
                    Calendar information is used for the connected calendar features. Kesami’s use and transfer of information received from Google
                    APIs will adhere to the{' '}
                    <a className="link" href="https://developers.google.com/terms/api-services-user-data-policy">
                        Google API Services User Data Policy
                    </a>
                    , including its Limited Use requirements. Google user data is not sold or used for advertising or to train general-purpose AI
                    models.
                </p>
            </section>
            <section>
                <h2>Subscriptions and payments</h2>
                <p>
                    If you purchase a plan, payment providers process your payment information. Kesami uses account identifiers, subscription status
                    and payment references to verify access to paid features. Billing records may be stored locally and in hosted services. Payment
                    providers handle the payment details submitted to their checkout.
                </p>
            </section>
            <section>
                <h2>Website analytics and preferences</h2>
                <p>
                    This website uses Vercel hosting and Vercel Web Analytics to understand website visits, including pages visited and general device
                    and browser information. See{' '}
                    <a className="link" href="https://vercel.com/docs/analytics/privacy-policy">
                        Vercel’s analytics privacy documentation
                    </a>
                    . The website stores your currency preference in your browser’s local storage. Visiting the website does not upload your desktop
                    meeting library.
                </p>
            </section>
            <section>
                <h2>Sharing, security and retention</h2>
                <p>
                    Information is shared with services needed to operate the features you use, including authentication, transcription, AI, hosting
                    and payments. Information may also need to be disclosed to comply with applicable law or address security incidents. Hosted
                    features use encrypted HTTPS or secure WebSocket connections. Local files remain subject to your computer’s permissions, backups
                    and security settings.
                </p>
                <p>
                    Local meeting files remain until you delete them. Backups and exported copies must be managed separately. Account, operational and
                    billing records may remain while needed to provide the service, address security issues or meet legal obligations. Revoking Google
                    access does not itself delete existing local files or hosted account and billing records.
                </p>
            </section>
            <section>
                <h2>Your controls and privacy requests</h2>
                <p>
                    You can stop recording, delete meeting files you control, sign out and revoke Kesami’s Google access through{' '}
                    <a className="link" href="https://myaccount.google.com/connections">
                        your Google Account connections
                    </a>
                    . You can remove microphone and screen recording permissions in your operating system’s privacy settings.
                </p>
                <p>
                    For questions about Google account data or requests to delete hosted account information, use the developer contact email
                    displayed on Kesami’s Google consent screen. Do not send recordings, access tokens or other sensitive information in an initial
                    request.
                </p>
            </section>
            <section>
                <h2>Changes to this policy</h2>
                <p>
                    Updates will be published on this page with a revised date. If Google data is to be used for a new purpose, the relevant
                    disclosures and consent will be updated before that use begins.
                </p>
                <p>
                    Read the{' '}
                    <a className="link" href="/terms">
                        Terms of service
                    </a>{' '}
                    for the conditions of using Kesami.
                </p>
            </section>
        </LegalPage>
    );
}
