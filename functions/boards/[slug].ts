import { BOARD_PAGES, SITE_NAME, SITE_ORIGIN, boardPath, postPath } from '../../src/lib/community/seo';
import { POST_COLUMNS, REAL_POSTS, escapeMarkup as esc, excerpt, htmlPage, pageNumber, readOnly, timeMarkup, unavailablePage,
  type CommunitySeoEnv, type PublicPost } from '../_lib/community-seo';

const PAGE_SIZE = 30;

export const onRequest: PagesFunction<CommunitySeoEnv> = ({ request, env, params }) => readOnly(request, async () => {
  const board = BOARD_PAGES.find(item => item.slug === params.slug);
  const page = pageNumber(new URL(request.url));
  if (!board || page === null) return unavailablePage(404);
  try {
    const total = await env.DB.prepare(`SELECT COUNT(*) AS count FROM community_posts WHERE category = ? AND ${REAL_POSTS}`).bind(board.category).first<{ count: number }>();
    const pages = Math.max(1, Math.ceil((total?.count ?? 0) / PAGE_SIZE));
    if (page > pages) return unavailablePage(404);
    const posts = await env.DB.prepare(`SELECT ${POST_COLUMNS} FROM community_posts WHERE category = ? AND ${REAL_POSTS} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`)
      .bind(board.category, PAGE_SIZE, (page - 1) * PAGE_SIZE).all<PublicPost>();
    const path = (number: number) => boardPath(board.slug) + (number > 1 ? `?page=${number}` : '');
    const heading = board.title + (page > 1 ? ` · ${page}페이지` : '');
    const description = (page > 1 ? `${page}페이지 · ` : '') + board.description;
    const body = `<nav class="reader-breadcrumb" aria-label="현재 위치"><a href="/">커뮤니티</a><span aria-hidden="true"> / </span><span>${esc(board.category)}</span></nav>
<header><p class="reader-kicker">퇴근 후 게시판</p><h1 class="reader-title">${esc(heading)}</h1><p class="reader-description">${esc(board.description)}</p>
<div class="reader-actions"><a class="reader-primary" href="/?board=${encodeURIComponent(board.slug)}">이 게시판에서 이야기하기</a><span class="reader-meta">실제 이용자 글 ${total?.count ?? 0}개</span></div></header>
<section class="reader-post-list" aria-label="${esc(board.category)} 게시글">
${posts.results.length ? posts.results.map(post => `<article class="reader-card reader-post-item"><h2><a href="${postPath(post.id)}">${esc(post.title)}</a></h2><p>${esc(excerpt(post.body, 170))}</p><div class="reader-meta"><span>${esc(post.nickname)}</span>${timeMarkup(post.created_at)}</div></article>`).join('') : '<div class="reader-card reader-empty"><h2>아직 올라온 글이 없어요</h2><p>이 게시판에는 아직 실제 이용자가 남긴 글이 없습니다. 오늘 있었던 작은 일부터 들려주세요.</p></div>'}
</section>
${pages > 1 ? `<nav class="reader-pagination" aria-label="게시글 페이지">${page > 1 ? `<a rel="prev" href="${path(page - 1)}">← 이전 글</a>` : '<span></span>'}<span>${page} / ${pages} 페이지</span>${page < pages ? `<a rel="next" href="${path(page + 1)}">다음 글 →</a>` : '<span></span>'}</nav>` : ''}`;
    return htmlPage({ title: `${heading} | ${SITE_NAME}`, description, canonicalPath: path(page), body,
      schema: { '@context': 'https://schema.org', '@type': 'CollectionPage', name: heading, description,
        url: SITE_ORIGIN + path(page), isPartOf: { '@type': 'WebSite', name: SITE_NAME, url: SITE_ORIGIN + '/' },
        mainEntity: { '@type': 'ItemList', itemListElement: posts.results.map((post, index) => ({
          '@type': 'ListItem', position: (page - 1) * PAGE_SIZE + index + 1, name: post.title, url: SITE_ORIGIN + postPath(post.id),
        })) },
      },
    });
  } catch { return unavailablePage(503); }
});
