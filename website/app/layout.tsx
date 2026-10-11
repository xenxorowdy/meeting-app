import type { Metadata, Viewport } from 'next';
import { Inter } from 'next/font/google';
import './globals.css';
import '../tokens.css';
import { Analytics } from '@vercel/analytics/next';

// next/font downloads Inter at build time and serves it from this site, so a visitor's browser never
// calls Google Fonts.
const inter = Inter({ subsets: ['latin'], axes: ['opsz'], variable: '--font-sans', display: 'swap' });

export const metadata: Metadata = {
    metadataBase: new URL(process.env.SITE_URL ?? 'https://kesami.online'),
    title: {
        default: 'Kesami — Your meetings, remembered and followed through',
        template: '%s — Kesami',
    },
    description:
        'Kesami records meetings without a bot and remembers every decision, action item and follow-up, with answers that cite the moment it was said. macOS and Windows.',
    applicationName: 'Kesami',
    alternates: { canonical: '/' },
    openGraph: {
        title: 'Kesami — Your meetings shouldn’t disappear when the call ends',
        description: 'Meeting memory for macOS and Windows: decisions, action items and follow-ups from every meeting, and answers with sources.',
        type: 'website',
        url: '/',
        siteName: 'Kesami',
        locale: 'en_US',
    },
    twitter: {
        card: 'summary_large_image',
    },
};

export const viewport: Viewport = {
    themeColor: '#f5f5f0',
};

// Runs before first paint, so the page never renders one state and then swaps to another:
// - .js turns on scroll reveals only when a script will also turn them off again;
// - data-currency picks INR for visitors on Indian time, USD otherwise, unless they chose before;
// - data-os marks the visitor's platform so the download section can fill that platform's button.
//   iPads report a Mac platform, so a touch screen counts as mobile first.
// Every variant is in the server HTML and CSS picks one, so there is no hydration mismatch to patch.
const PRE_PAINT = `(function(){var d=document.documentElement;d.classList.add('js');try{var n=navigator,p=((n.userAgentData&&n.userAgentData.platform)||n.platform||'')+' '+n.userAgent;d.dataset.os=/Android|iPhone|iPad|iPod/i.test(p)||(/Mac/i.test(p)&&n.maxTouchPoints>1)?'mobile':/Win/i.test(p)?'windows':/Mac/i.test(p)?'mac':'other'}catch(e){}try{var c=localStorage.getItem('kesami-currency');if(c!=='usd'&&c!=='inr'){var z=Intl.DateTimeFormat().resolvedOptions().timeZone;c=z==='Asia/Kolkata'||z==='Asia/Calcutta'?'inr':'usd'}d.dataset.currency=c}catch(e){}})()`;

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
    return (
        <html lang="en" className={inter.variable} suppressHydrationWarning>
            <head>
                <script dangerouslySetInnerHTML={{ __html: PRE_PAINT }} />
            </head>
            <body>
                <a className="skip" href="#main">
                    Skip to content
                </a>
                {children}
                <Analytics />
            </body>
        </html>
    );
}
