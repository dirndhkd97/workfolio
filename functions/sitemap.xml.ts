import { SITE_ORIGIN } from '../src/lib/community/seo';
import { REAL_POSTS, SITEMAP_SIZE, escapeMarkup, readOnly, xmlFailure, xmlResponse, type CommunitySeoEnv } from './_lib/community-seo';

export const onRequest: PagesFunction<CommunitySeoEnv> = ({ request, env }) => readOnly(request, async () => {
  try {
    const row = await env.DB.prepare(`SELECT COUNT(*) AS count FROM community_posts WHERE ${REAL_POSTS}`).first<{ count: number }>();
    const pages = Math.ceil((row?.count ?? 0) / SITEMAP_SIZE);
    const locations = [SITE_ORIGIN + '/sitemap-pages.xml', ...Array.from({ length: pages }, (_, index) => `${SITE_ORIGIN}/sitemap-posts.xml?page=${index + 1}`)];
    return xmlResponse(`<?xml version="1.0" encoding="UTF-8"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${locations.map(url => `<sitemap><loc>${escapeMarkup(url)}</loc></sitemap>`).join('')}</sitemapindex>`);
  } catch { return xmlFailure(503); }
});
