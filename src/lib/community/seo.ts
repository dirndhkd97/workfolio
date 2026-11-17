import type { Category } from './domain';

export const SITE_ORIGIN = 'https://workfolio.life';
export const SITE_NAME = '워크폴리오 Workfolio';
export const HOME_TITLE = '워크폴리오 | 회사 뒷담 · 직장인 익명 커뮤니티';
export const HOME_DESCRIPTION = '회사 뒷담 갤 감성의 직장인 익명 커뮤니티. 상사 스트레스와 웃픈 실수, 월급루팡 썰을 나눠요. 비회원 눈팅은 자유롭게.';
export const SOCIAL_IMAGE = `${SITE_ORIGIN}/community-og.png`;

export const BOARD_PAGES: { slug: string; category: Category; title: string; description: string }[] = [
  { slug: 'brain-off', category: '빡대가리 게시판', title: '빡대가리 게시판 · 내 실수와 회사 뒷담', description: '내가 왜 그랬지… 쟤는 또 왜 저래? 내 흑역사부터 답답한 동료, 황당한 회사 썰까지. 누군지 특정할 정보는 빼고 속 시원하게 풀어요.' },
  { slug: 'salary-lupin', category: '월급루팡', title: '월급루팡 · 직장인 일상과 잡담', description: '사장님, 저 지금 일하고 있어요. 점심 메뉴, 퇴근 카운트다운, 웃긴 짤과 소소한 일상까지. 잠깐 딴짓할 동료를 찾는 게시판.' },
  { slug: 'quit-advice', category: '퇴사각 상담소', title: '퇴사각 상담소 · 이직과 회사 생활 고민', description: '사직서는 임시저장. 일단 여기 물어봐. 인간관계, 이직, 퇴사 고민부터 회사 생활 조언까지. 신상은 지키고 서로의 경험을 나눠요.' },
];

/** Old board links survive consolidation without creating duplicate boards. */
export const LEGACY_BOARD_SLUGS: Readonly<Record<string, string>> = {
  'office-people': 'brain-off', 'funny-mistakes': 'brain-off', 'absurd-moments': 'brain-off', 'daily-life': 'salary-lupin',
};
export const boardForSlug = (slug: string) => BOARD_PAGES.find(board => board.slug === (Object.hasOwn(LEGACY_BOARD_SLUGS, slug) ? LEGACY_BOARD_SLUGS[slug] : slug));

export const boardPath = (slug: string) => `/boards/${slug}`;
// Shared by the generated compatibility sitemap and the explicit Pages endpoint.
export const STATIC_SITEMAP_PATHS = [
  '/', '/privacy/', '/terms/', '/studio/',
  ...BOARD_PAGES.map(board => boardPath(board.slug)),
];
export const postPath = (id: string) => `/posts/${encodeURIComponent(id)}`;
export const boardForCategory = (category: string) => BOARD_PAGES.find(board => board.category === category);
