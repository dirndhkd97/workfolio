import { SITE_ORIGIN, postPath } from '../src/lib/community/seo';
import { REAL_POSTS, SITEMAP_SIZE, escapeMarkup, pageNumber, readOnly, xmlFailure, xmlResponse, type CommunitySeoEnv } from './_lib/community-seo';

export const onRequest: PagesFunction<CommunitySeoEnv> = ({ request, env }) => readOnly(request, async () => {
  const page = pageNumber(new URL(request.url));
  if (page === null) return xmlFailure(404);
  try {
    const total = await env.DB.prepare(`SELECT COUNT(*) AS count FROM community_posts WHERE ${REAL_POSTS}`).first<{ count: number }>();
    if (page > Math.max(1, Math.ceil((total?.count ?? 0) / SITEMAP_SIZE))) return xmlFailure(404);
    // Oldest-first keeps newly written posts at the end instead of shifting every existing chunk.
    const rows = await env.DB.prepare(`SELECT id FROM community_posts WHERE ${REAL_POSTS} ORDER BY created_at ASC, id ASC LIMIT ? OFFSET ?`)
      .bind(SITEMAP_SIZE, (page - 1) * SITEMAP_SIZE).all<{ id: string }>();
    return xmlResponse(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${rows.results.map(post => `<url><loc>${escapeMarkup(SITE_ORIGIN + postPath(post.id))}</loc></url>`).join('')}</urlset>`);
  } catch { return xmlFailure(503); }
});
