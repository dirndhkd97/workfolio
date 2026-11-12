import { SITE_NAME, SITE_ORIGIN, boardForCategory, boardPath, postPath } from '../../src/lib/community/seo';
import { POST_COLUMNS, companyAuthorMarkup, postShareMarkup, escapeMarkup as esc, excerpt, htmlPage, readOnly, timeMarkup, unavailablePage,
  type CommunitySeoEnv, type PublicComment, type PublicPost } from '../_lib/community-seo';

export const onRequest: PagesFunction<CommunitySeoEnv> = ({ request, env, params }) => readOnly(request, async () => {
  const id = params.id;
  if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(id)) return unavailablePage(404);
  try {
    if (id.startsWith('sample-')) return unavailablePage(404);
    const post = await env.DB.prepare(`SELECT ${POST_COLUMNS} FROM community_posts WHERE id = ?`).bind(id).first<PublicPost>();
    if (!post) return unavailablePage(404);
    const [comments, commentTotal, reactions, attachmentRows] = await Promise.all([
      env.DB.prepare('SELECT id, body, nickname, created_at FROM community_comments WHERE post_id = ? ORDER BY created_at ASC, id ASC LIMIT 500').bind(id).all<PublicComment>(),
      env.DB.prepare('SELECT COUNT(*) AS count FROM community_comments WHERE post_id = ?').bind(id).first<{ count: number }>(),
      env.DB.prepare('SELECT COUNT(*) AS count FROM community_reactions WHERE post_id = ? AND active = 1').bind(id).first<{ count: number }>(),
      env.DB.prepare("SELECT id, width, height FROM community_post_images WHERE post_id = ? AND status = 'attached' ORDER BY position, created_at, id").bind(id).all<{ id: string; width: number; height: number }>(),
    ]);
    const images = attachmentRows.results.map(image => ({ ...image, url: `/api/community-images/${encodeURIComponent(image.id)}` }));
    const gallery = images.length ? `<div class="reader-gallery" aria-label="첨부 이미지">${images.map((image, index) => `<a href="${esc(image.url)}" target="_blank" rel="noopener" aria-label="첨부 이미지 ${index + 1} 크게 보기 (새 창)"><img src="${esc(image.url)}" alt="${esc(post.title)} 첨부 이미지 ${index + 1}" width="${image.width}" height="${image.height}" loading="${index === 0 ? 'eager' : 'lazy'}" decoding="async"></a>`).join('')}</div>` : '';
    const board = boardForCategory(post.category);
    const url = SITE_ORIGIN + postPath(id);
    const join = `/?story=${encodeURIComponent(id)}`;
    const count = commentTotal?.count ?? 0;
    const schema = {
      '@context': 'https://schema.org', '@type': 'DiscussionForumPosting',
      mainEntityOfPage: url, url, headline: post.title, text: post.body,
      author: { '@type': 'Person', name: post.nickname }, datePublished: new Date(post.created_at).toISOString(),
      commentCount: count,
      ...(images.length ? { image: images.map(image => SITE_ORIGIN + image.url) } : {}),
      ...(board ? { isPartOf: { '@type': 'CollectionPage', name: board.title, url: SITE_ORIGIN + boardPath(board.slug) } } : {}),
      comment: comments.results.map(comment => ({
        '@type': 'Comment', text: comment.body, author: { '@type': 'Person', name: comment.nickname },
        datePublished: new Date(comment.created_at).toISOString(),
      })),
    };
    const body = `<nav class="reader-breadcrumb" aria-label="현재 위치"><a href="/">커뮤니티</a><span aria-hidden="true"> / </span>${board ? `<a href="${boardPath(board.slug)}">${esc(board.category)}</a>` : esc(post.category)}</nav>
<article class="reader-card">
<p class="reader-kicker">${esc(post.category)}</p>
<h1 class="reader-title">${esc(post.title)}</h1>
<div class="reader-meta">${companyAuthorMarkup(post)}<span aria-hidden="true">·</span><span>${esc(post.nickname)}</span>${timeMarkup(post.created_at)}</div>
<p class="reader-body">${esc(post.body)}</p>
${gallery}
<div class="reader-stats"><span>공감 ${reactions?.count ?? 0}</span><span>댓글 ${count}</span></div>
${postShareMarkup(post.id, post.title)}
<div class="reader-actions"><a class="reader-primary" href="${join}">공감하고 댓글 남기기</a>${board ? `<a href="${boardPath(board.slug)}">${esc(board.category)} 더 보기 →</a>` : ''}</div>
</article>
<section class="reader-card reader-comments" aria-labelledby="comments-heading"><h2 id="comments-heading">댓글 ${count}</h2>
${comments.results.length ? comments.results.map(comment => `<article class="reader-comment"><div class="reader-meta"><strong>${esc(comment.nickname)}</strong>${timeMarkup(comment.created_at)}</div><p class="reader-body">${esc(comment.body)}</p></article>`).join('') : '<p class="reader-empty">아직 댓글이 없어요. 첫 번째 이야기를 보태주세요.</p>'}
${count > comments.results.length ? `<p class="reader-notice">댓글 ${count}개 중 먼저 작성된 ${comments.results.length}개를 보여드려요.</p>` : ''}
<a href="${join}">로그인하고 대화에 참여하기 →</a></section>`;
    return htmlPage({ title: `${post.title} | ${SITE_NAME}`,
      description: excerpt(post.body, 80), canonicalPath: postPath(id), body, schema, article: true, image: images[0] });
  } catch { return unavailablePage(503); }
});
