import { SAMPLE_POSTS } from '../../src/lib/community/sample-posts';
import { SITE_NAME, SITE_ORIGIN, boardForCategory, boardPath, postPath } from '../../src/lib/community/seo';
import { POST_COLUMNS, escapeMarkup as esc, excerpt, htmlPage, readOnly, timeMarkup, unavailablePage,
  type CommunitySeoEnv, type PublicComment, type PublicPost } from '../_lib/community-seo';

export const onRequest: PagesFunction<CommunitySeoEnv> = ({ request, env, params }) => readOnly(request, async () => {
  const id = params.id;
  if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(id)) return unavailablePage(404);
  try {
    const sample = SAMPLE_POSTS.find(post => post.id === id);
    const post: PublicPost | null = sample ? {
      id: sample.id, title: sample.title, body: sample.body, category: sample.category,
      nickname: sample.nickname, created_at: sample.createdAt,
    } : await env.DB.prepare(`SELECT ${POST_COLUMNS} FROM community_posts WHERE id = ?`).bind(id).first<PublicPost>();
    if (!post) return unavailablePage(404);
    const [comments, commentTotal, reactions] = await Promise.all([
      env.DB.prepare('SELECT id, body, nickname, created_at FROM community_comments WHERE post_id = ? ORDER BY created_at ASC, id ASC LIMIT 500').bind(id).all<PublicComment>(),
      env.DB.prepare('SELECT COUNT(*) AS count FROM community_comments WHERE post_id = ?').bind(id).first<{ count: number }>(),
      env.DB.prepare('SELECT COUNT(*) AS count FROM community_reactions WHERE post_id = ? AND active = 1').bind(id).first<{ count: number }>(),
    ]);
    const board = boardForCategory(post.category);
    const url = SITE_ORIGIN + postPath(id);
    const join = `/?story=${encodeURIComponent(id)}`;
    const count = commentTotal?.count ?? 0;
    const schema = sample ? undefined : {
      '@context': 'https://schema.org', '@type': 'DiscussionForumPosting',
      mainEntityOfPage: url, url, headline: post.title, text: post.body,
      author: { '@type': 'Person', name: post.nickname }, datePublished: new Date(post.created_at).toISOString(),
      commentCount: count,
      ...(board ? { isPartOf: { '@type': 'CollectionPage', name: board.title, url: SITE_ORIGIN + boardPath(board.slug) } } : {}),
      comment: comments.results.map(comment => ({
        '@type': 'Comment', text: comment.body, author: { '@type': 'Person', name: comment.nickname },
        datePublished: new Date(comment.created_at).toISOString(),
      })),
    };
    const body = `<nav class="reader-breadcrumb" aria-label="현재 위치"><a href="/">커뮤니티</a><span aria-hidden="true"> / </span>${board ? `<a href="${boardPath(board.slug)}">${esc(board.category)}</a>` : esc(post.category)}</nav>
<article class="reader-card">
<p class="reader-kicker">${esc(post.category)}${sample ? ' · 가상 예시' : ''}</p>
<h1 class="reader-title">${esc(post.title)}</h1>
<div class="reader-meta"><span>${esc(post.nickname)}</span>${sample ? '<span>편집용 가상 이야기</span>' : timeMarkup(post.created_at)}</div>
${sample ? '<p class="reader-notice">커뮤니티 이용 방법을 보여주는 가상 예시입니다. 실제 이용자가 작성한 사연이 아닙니다.</p>' : ''}
<p class="reader-body">${esc(post.body)}</p>
<div class="reader-stats"><span>공감 ${reactions?.count ?? 0}</span><span>댓글 ${count}</span></div>
<div class="reader-actions"><a class="reader-primary" href="${join}">공감하고 댓글 남기기</a>${board ? `<a href="${boardPath(board.slug)}">${esc(board.category)} 더 보기 →</a>` : ''}</div>
</article>
<section class="reader-card reader-comments" aria-labelledby="comments-heading"><h2 id="comments-heading">댓글 ${count}</h2>
${comments.results.length ? comments.results.map(comment => `<article class="reader-comment"><div class="reader-meta"><strong>${esc(comment.nickname)}</strong>${timeMarkup(comment.created_at)}</div><p class="reader-body">${esc(comment.body)}</p></article>`).join('') : '<p class="reader-empty">아직 댓글이 없어요. 첫 번째 이야기를 보태주세요.</p>'}
${count > comments.results.length ? `<p class="reader-notice">댓글 ${count}개 중 먼저 작성된 ${comments.results.length}개를 보여드려요.</p>` : ''}
<a href="${join}">로그인하고 대화에 참여하기 →</a></section>`;
    return htmlPage({ title: `${sample ? '[가상 예시] ' : ''}${post.title} | ${SITE_NAME}`,
      description: excerpt(post.body, 80), canonicalPath: postPath(id), body, schema, noindex: Boolean(sample), article: true });
  } catch { return unavailablePage(503); }
});
