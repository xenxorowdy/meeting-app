import { LANGUAGES, LATEST_URL, PLANS, PLATFORMS } from '@/lib/site';
import { QUESTIONS } from './Faq';

export function StructuredData() {
    const origin = process.env.SITE_URL ?? 'https://kesami.online';
    const url = new URL('/', origin).href;
    const monthly = (price: number, priceCurrency: string) => ({
        '@type': 'Offer',
        name: PLANS.pro.name,
        price: String(price),
        priceCurrency,
        priceSpecification: { '@type': 'UnitPriceSpecification', price: String(price), priceCurrency, unitCode: 'MON' },
    });

    const data = {
        '@context': 'https://schema.org',
        '@graph': [
            {
                '@type': 'Organization',
                '@id': `${url}#organization`,
                name: 'Kesami',
                url,
                logo: new URL('/apple-icon.png', origin).href,
            },
            {
                '@type': 'WebSite',
                '@id': `${url}#website`,
                name: 'Kesami',
                url,
                inLanguage: 'en',
                publisher: { '@id': `${url}#organization` },
            },
            {
                '@type': 'SoftwareApplication',
                '@id': `${url}#app`,
                name: 'Kesami',
                url,
                description:
                    'Meeting memory for macOS and Windows. Kesami records meetings without a bot and remembers every decision, action item and follow-up, with answers that cite the moment it was said.',
                applicationCategory: 'BusinessApplication',
                operatingSystem: 'macOS 13 or later, Windows 10, Windows 11',
                softwareRequirements: `${PLATFORMS.mac.requires}; ${PLATFORMS.windows.requires}`,
                downloadUrl: LATEST_URL,
                inLanguage: LANGUAGES.map(language => language.lang),
                publisher: { '@id': `${url}#organization` },
                offers: [
                    { '@type': 'Offer', name: PLANS.free.name, price: '0', priceCurrency: 'USD' },
                    monthly(PLANS.pro.usd, 'USD'),
                    monthly(PLANS.pro.inr, 'INR'),
                ],
            },
            {
                '@type': 'FAQPage',
                '@id': `${url}#faq`,
                mainEntity: QUESTIONS.map(item => ({
                    '@type': 'Question',
                    name: item.q,
                    acceptedAnswer: { '@type': 'Answer', text: item.a },
                })),
            },
        ],
    };

    return <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(data).replace(/</g, '\\u003c') }} />;
}
