import type { Metadata } from 'next';
import { LegalPage } from '@/components/LegalPage';

export const metadata: Metadata = {
    title: 'Terms of service',
    description: 'Terms for using the Kesami website and desktop meeting assistant.',
    alternates: { canonical: '/terms' },
    openGraph: {
        title: 'Terms of service — Kesami',
        description: 'Terms for using the Kesami website and desktop meeting assistant.',
        type: 'website',
        url: '/terms',
        siteName: 'Kesami',
        locale: 'en_US',
    },
};

export default function TermsOfService() {
    return (
        <LegalPage
            title="Terms of service"
            intro="These terms apply to the Kesami website and desktop meeting assistant. By using Kesami, you agree to these terms."
        >
            <section>
                <h2>Using Kesami</h2>
                <p>
                    Kesami helps you record meetings, produce transcripts and summaries, and ask questions about meeting content. Use it only where
                    you have permission to do so and in compliance with applicable laws and your organization’s policies. You are responsible for
                    informing participants and obtaining any required consent before recording.
                </p>
            </section>
            <section>
                <h2>Your account and connected services</h2>
                <p>
                    Keep your account and computer secure. You are responsible for actions you authorize through your account, including recording,
                    exporting content and creating calendar events. Google, authentication, AI and payment services may have their own terms. You can
                    revoke Google permissions through your Google Account.
                </p>
            </section>
            <section>
                <h2>Your content</h2>
                <p>
                    You retain your rights in content you record or provide. You give Kesami permission to process that content as needed to deliver
                    features you request, including cloud transcription and AI processing. You must have the rights and permissions needed to provide
                    and share that content. The{' '}
                    <a className="link" href="/privacy">
                        Privacy policy
                    </a>{' '}
                    describes these data flows.
                </p>
            </section>
            <section>
                <h2>AI output and availability</h2>
                <p>
                    Transcripts, speaker labels, summaries and AI answers can contain mistakes or omissions. Review them before relying on them or
                    sharing them. Kesami does not guarantee uninterrupted availability or error-free results. Keep backups of important recordings and
                    documents.
                </p>
            </section>
            <section>
                <h2>Plans and payments</h2>
                <p>
                    Free and paid features are subject to the limits and prices displayed in the app and at checkout. Review the billing period,
                    renewal, cancellation and payment conditions shown before completing a purchase. Applicable consumer rights continue to apply.
                </p>
            </section>
            <section>
                <h2>Acceptable use</h2>
                <p>
                    Do not use Kesami for unlawful recording, infringement, harassment or unauthorized access to another person’s information. Do not
                    bypass access controls or service limits, interfere with the service or misuse connected accounts. Access to hosted features may
                    be restricted when necessary to address abuse or security threats.
                </p>
            </section>
            <section>
                <h2>Ending use and changes</h2>
                <p>
                    You may stop using Kesami, sign out and revoke connected permissions at any time. Uninstalling the app does not necessarily remove
                    meeting files, cancel a paid subscription or delete hosted account records. Manage each of those separately.
                </p>
                <p>
                    Features and these terms may change. Updated terms will be published here with a revised date. For questions about
                    Google-connected account access, use the developer contact email displayed on Kesami’s Google consent screen.
                </p>
            </section>
        </LegalPage>
    );
}
