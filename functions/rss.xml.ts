import { HOME_TITLE, HOME_DESCRIPTION, SITE_ORIGIN, postPath } from '../src/lib/community/seo';
import { REAL_POSTS, escapeMarkup as esc, readOnly, xmlFailure, xmlResponse,
  type CommunitySeoEnv, type PublicPost } from './_lib/community-seo';

type FeedPost = Pick<PublicPost, 'id' | 'title' | 'body' | 'created_at'>;

export const onRequest: PagesFunction<CommunitySeoEnv> = ({ request, env }) => readOnly(request, async () => {
  try {
    const posts = await env.DB.prepare(`SELECT id, title, body, created_at FROM community_posts WHERE ${REAL_POSTS} ORDER BY created_at DESC, id DESC LIMIT 30`)
      .all<FeedPost>();
    const items = posts.results.map(post => {
      const url = esc(SITE_ORIGIN + postPath(post.id));
      return `<item><title>${esc(post.title)}</title><link>${url}</link><guid isPermaLink="true">${url}</guid><description>${esc(post.body)}</description><pubDate>${new Date(post.created_at).toUTCString()}</pubDate></item>`;
    }).join('');
    const response = xmlResponse(`<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom"><channel>
<title>${esc(HOME_TITLE)}</title><link>${esc(SITE_ORIGIN + '/')}</link><description>${esc(HOME_DESCRIPTION)}</description><language>ko-KR</language>
<atom:link href="${esc(SITE_ORIGIN + '/rss.xml')}" rel="self" type="application/rss+xml"/>
${items}</channel></rss>`);
    response.headers.set('Content-Type', 'application/rss+xml; charset=utf-8');
    return response;
  } catch { return xmlFailure(503); }
});
