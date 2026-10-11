import type { MetadataRoute } from 'next';

export default function sitemap(): MetadataRoute.Sitemap {
    const origin = process.env.SITE_URL ?? 'https://kesami.online';
    const pages: { path: string; changeFrequency: 'weekly' | 'yearly'; priority: number }[] = [
        { path: '/', changeFrequency: 'weekly', priority: 1 },
        { path: '/privacy', changeFrequency: 'yearly', priority: 0.3 },
        { path: '/terms', changeFrequency: 'yearly', priority: 0.3 },
    ];

    return pages.map(({ path, changeFrequency, priority }) => ({
        url: new URL(path, origin).href,
        changeFrequency,
        priority,
    }));
}
