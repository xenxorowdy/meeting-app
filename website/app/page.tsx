import { Ask } from '@/components/Ask';
import { Closing } from '@/components/Closing';
import { Commitments } from '@/components/Commitments';
import { Desktop } from '@/components/Desktop';
import { Faq } from '@/components/Faq';
import { Footer } from '@/components/Footer';
import { Hero } from '@/components/Hero';
import { Memory } from '@/components/Memory';
import { Nav } from '@/components/Nav';
import { Pricing } from '@/components/Pricing';
import { Privacy } from '@/components/Privacy';
import { Problem } from '@/components/Problem';
import { Story } from '@/components/Story';
import { StructuredData } from '@/components/StructuredData';

// The story runs problem → memory → commitments → answers → action, then trust, then the download.
// Canvas and white sections alternate so each one starts on a visible edge instead of a ruled line.
export default function Home() {
    return (
        <>
            <StructuredData />
            <Nav />
            <main id="main">
                <Hero />
                <Problem />
                <Memory />
                <Commitments />
                <Ask />
                <Story />
                <Privacy />
                <Desktop />
                <Pricing />
                <Faq />
                <Closing />
            </main>
            <Footer />
        </>
    );
}
