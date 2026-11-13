import { BOARD_PAGES, SITE_NAME, SITE_ORIGIN, SOCIAL_IMAGE, boardPath } from '../../src/lib/community/seo';
import { postShareLinks, postShareUrl } from '../../src/lib/community/sharing';

export interface CommunitySeoEnv { DB: D1Database }
export interface PublicPost {
  id: string;
  title: string;
  body: string;
  category: string;
  nickname: string;
  company_name: string | null;
  is_admin_author: number;
  created_at: number;
}
export interface PublicComment { id: string; body: string; nickname: string; created_at: number }

export const POST_COLUMNS = 'id, title, body, category, nickname, company_name, is_admin_author, created_at';
// Retired editorial sample IDs must never appear in the public feeds.
export const REAL_POSTS = "id NOT LIKE 'sample-%'";
export const SITEMAP_SIZE = 1000;

/** Safe for HTML text, quoted attributes, and XML text/attributes. */
export function escapeMarkup(value: unknown): string {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]!);
}

export function companyAuthorMarkup(post: Pick<PublicPost, 'company_name' | 'is_admin_author'>): string {
  const isAdmin = Boolean(post.company_name) && post.is_admin_author === 1;
  const label = isAdmin ? '관리자' : post.company_name || '회사 비공개';
  return `<span${isAdmin ? ' class="admin-author-badge" aria-label="Workfolio 인증 관리자"' : ''}>${escapeMarkup(label)}</span>`;
}

export function postShareMarkup(id: string, title: string): string {
  const url = postShareUrl(id);
  const links = postShareLinks(id, title).map(item => `<a class="reader-share-service reader-share-${item.name.toLowerCase()}" href="${escapeMarkup(item.href)}" target="_blank" rel="noopener noreferrer" aria-label="${escapeMarkup(item.name)}에 공유 (새 창)"><span class="reader-share-icon"><img src="/share/${item.name.toLowerCase()}.svg" width="32" height="32" alt="" aria-hidden="true"></span><span>${escapeMarkup(item.name)}</span></a>`).join('');
  return `<details class="reader-share" data-post-share data-share-url="${escapeMarkup(url)}" data-share-title="${escapeMarkup(title)}"><summary>공유하기</summary><div class="reader-share-options"><p class="reader-share-title">이 이야기를 함께 나눠요.</p><div class="reader-share-buttons"><button type="button" data-native-share hidden>앱으로 공유</button><button type="button" data-copy-share hidden>링크 복사</button></div><div class="reader-share-socials" role="group" aria-label="SNS로 공유">${links}</div><label class="reader-share-link">게시글 링크<input type="text" value="${escapeMarkup(url)}" readonly aria-label="복사할 게시글 링크"></label><p data-share-status role="status"></p></div></details>`;
}

export function jsonLd(value: unknown): string {
  return JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, character =>
    `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

export function excerpt(value: string, length = 150): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  const characters = Array.from(normalized);
  return characters.length > length ? characters.slice(0, length - 1).join('') + '…' : normalized;
}

export function pageNumber(url: URL): number | null {
  const values = url.searchParams.getAll('page');
  if (values.length === 0) return 1;
  if (values.length !== 1 || !/^[1-9]\d{0,8}$/.test(values[0])) return null;
  const page = Number(values[0]);
  return Number.isSafeInteger(page) ? page : null;
}

export function timeMarkup(timestamp: number): string {
  const date = new Date(timestamp);
  return `<time datetime="${date.toISOString()}">${new Intl.DateTimeFormat('ko-KR', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: 'long', day: 'numeric',
  }).format(date)}</time>`;
}

const baseHeaders = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
};

export async function readOnly(request: Request, render: () => Promise<Response>): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response(null, { status: 405, headers: { ...baseHeaders, Allow: 'GET, HEAD', 'X-Robots-Tag': 'noindex' } });
  }
  const response = await render();
  return request.method === 'HEAD' ? new Response(null, { status: response.status, headers: response.headers }) : response;
}

interface PageOptions {
  title: string;
  description: string;
  body: string;
  canonicalPath?: string;
  schema?: unknown;
  noindex?: boolean;
  status?: number;
  article?: boolean;
  image?: { url: string; width: number; height: number };
}

/** body contains markup assembled from escaped values by the route handlers. */
export function htmlPage({ title, description, body, canonicalPath, schema, noindex = false, status = 200, article = false, image }: PageOptions): Response {
  const canonical = canonicalPath ? SITE_ORIGIN + canonicalPath : null;
  const safeTitle = escapeMarkup(title);
  const safeDescription = escapeMarkup(excerpt(description, 80));
  const socialImage = image && image.url.startsWith('/api/community-images/') ? SITE_ORIGIN + image.url : SOCIAL_IMAGE;
  const socialImageAlt = image ? title : `${SITE_NAME} 직장인 커뮤니티`;
  const nav = BOARD_PAGES.map(board => `<a href="${boardPath(board.slug)}">${escapeMarkup(board.category)}</a>`).join('');
  const document = `<!doctype html>
<html lang="ko"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${safeTitle}</title><meta name="description" content="${safeDescription}">
<meta name="robots" content="${noindex ? 'noindex, follow' : 'index, follow, max-image-preview:large'}">
${canonical ? `<link rel="canonical" href="${escapeMarkup(canonical)}"><meta property="og:url" content="${escapeMarkup(canonical)}">` : ''}
<meta property="og:type" content="${article ? 'article' : 'website'}"><meta property="og:locale" content="ko_KR">
<meta property="og:site_name" content="${escapeMarkup(SITE_NAME)}"><meta property="og:title" content="${safeTitle}"><meta property="og:description" content="${safeDescription}">
<meta property="og:image" content="${escapeMarkup(socialImage)}"><meta property="og:image:alt" content="${escapeMarkup(socialImageAlt)}">${image ? `<meta property="og:image:width" content="${image.width}"><meta property="og:image:height" content="${image.height}">` : ''}
<meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="${safeTitle}"><meta name="twitter:description" content="${safeDescription}"><meta name="twitter:image" content="${escapeMarkup(socialImage)}">
<meta name="twitter:image:alt" content="${escapeMarkup(socialImageAlt)}">
<meta name="theme-color" content="#234f39"><link rel="icon" href="${SITE_ORIGIN}/community-favicon.png" type="image/png" sizes="192x192">
<link rel="alternate" type="application/rss+xml" title="${escapeMarkup(SITE_NAME)} 최신 글" href="${SITE_ORIGIN}/rss.xml"><link rel="stylesheet" href="/community-reader.css">
${article ? '<script src="/community-share.js" defer></script>' : ''}
${schema ? `<script type="application/ld+json">${jsonLd(schema)}</script>` : ''}
</head><body><div class="reader-shell">
<header class="reader-header"><a class="reader-brand" href="/">workfolio<span aria-hidden="true">.</span></a><a href="/">커뮤니티 홈 →</a></header>
<nav class="reader-nav" aria-label="게시판">${nav}</nav>
<main id="main" class="reader-main">${body}</main>
<footer class="reader-footer"><p>회사에선 못한 말, 별명으로 나누는 퇴근 후 아지트.</p><nav aria-label="이용 안내"><a href="/privacy/">개인정보처리방침</a><a href="/terms/">이용약관</a><!--email_off--><a href="mailto:contact@workfolio.life">문의</a><!--/email_off--></nav></footer>
</div></body></html>`;
  return new Response(document, {
    status,
    headers: { ...baseHeaders, 'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
      ...(noindex ? { 'X-Robots-Tag': 'noindex, follow' } : {}),
      ...(status === 503 ? { 'Retry-After': '60' } : {}),
    },
  });
}

export function unavailablePage(status: 404 | 503): Response {
  const title = status === 404 ? '이야기를 찾을 수 없어요' : '이야기를 잠시 불러오지 못했어요';
  const description = status === 404 ? '삭제되었거나 없는 페이지예요. 다른 이야기를 둘러보세요.' : '일시적으로 연결이 원활하지 않아요. 잠시 후 다시 열어주세요.';
  return htmlPage({ title: `${title} | ${SITE_NAME}`, description, status, noindex: true,
    body: `<section class="reader-card reader-error"><p class="reader-kicker">${status}</p><h1 class="reader-title">${title}</h1><p>${description}</p><a class="reader-primary" href="/">전체 이야기로</a></section>`,
  });
}

export function xmlResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: { ...baseHeaders, 'Content-Type': 'application/xml; charset=utf-8',
    ...(status >= 400 ? { 'X-Robots-Tag': 'noindex', ...(status === 503 ? { 'Retry-After': '60' } : {}) } : {}),
  } });
}

export function xmlFailure(status: 404 | 503): Response {
  return xmlResponse(`<?xml version="1.0" encoding="UTF-8"?><error>${status === 404 ? 'Not found' : 'Temporarily unavailable'}</error>`, status);
}
