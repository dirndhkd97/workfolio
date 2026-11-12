import type { Category } from './domain';

export const SITE_ORIGIN = 'https://workfolio.life';
export const SITE_NAME = '워크폴리오 Workfolio';
export const HOME_TITLE = '워크폴리오 | 회사 뒷담 · 직장인 익명 커뮤니티';
export const HOME_DESCRIPTION = '회사 뒷담 갤을 찾는 직장인의 퇴근 후 아지트. 상사 스트레스, 회사 생활 고민, 빡대가리 게시판과 월급루팡 썰까지. 로그인 없이 읽고 별명으로 이야기하는 Workfolio.';
export const SOCIAL_IMAGE = `${SITE_ORIGIN}/community-og.png`;

export const BOARD_PAGES: { slug: string; category: Category; title: string; description: string }[] = [
  { slug: 'brain-off', category: '빡대가리 게시판', title: '빡대가리 게시판 · 직장인 실수 썰', description: '첨부파일 없는 메일부터 음소거 사고까지. 오늘 회사에서 한 실수와 흑역사를 별명으로 털어놓고 같이 웃는 직장인 게시판.' },
  { slug: 'salary-lupin', category: '월급루팡', title: '월급루팡 · 직장인 딴짓과 퇴근 잡담', description: '퇴근까지 남은 시간, 월급날 이야기, 일하다 잠깐 쉬어가는 잡담. 회사 생활에 지친 직장인들의 월급루팡 게시판.' },
  { slug: 'office-people', category: '회사 사람들', title: '회사 뒷담 · 상사와 동료 이야기', description: '상사 스트레스부터 동료와의 웃픈 에피소드까지. 회사에서 못 한 뒷담과 인간관계 고민을 개인을 특정하지 않고 나누는 회사 사람들 게시판.' },
  { slug: 'funny-mistakes', category: '웃픈 실수', title: '웃픈 실수 · 회사 생활 흑역사', description: '회의, 메신저, 메일에서 터진 웃픈 실수. 그땐 아찔했지만 이제는 웃으며 풀 수 있는 회사 생활 흑역사와 공감을 나눠요.' },
  { slug: 'absurd-moments', category: '황당한 순간', title: '황당한 순간 · 회사에서 생긴 일', description: '끝없는 회의와 이해하기 어려운 회사 문화. 직장에서 겪은 황당한 순간과 회사 뒷이야기를 별명으로 나눠요.' },
  { slug: 'daily-life', category: '소소한 일상', title: '소소한 일상 · 직장인 퇴근 후 이야기', description: '출근길 커피부터 퇴근 후 취미와 월급날 기쁨까지. 회사 밖에서도 이어지는 직장인의 소소한 일상과 잡담을 나눠요.' },
];

export const boardPath = (slug: string) => `/boards/${slug}`;
export const postPath = (id: string) => `/posts/${encodeURIComponent(id)}`;
export const boardForCategory = (category: string) => BOARD_PAGES.find(board => board.category === category);
