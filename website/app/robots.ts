import type { MetadataRoute } from 'next';

export default function robots(): MetadataRoute.Robots {
    const origin = process.env.SITE_URL ?? 'https://kesami.online';

    return {
        rules: { userAgent: '*', allow: '/' },
        sitemap: new URL('/sitemap.xml', origin).href,
        host: origin,
    };
}
