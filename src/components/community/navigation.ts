import { BOARD_PAGES, boardForCategory } from '../../lib/community/seo';

export type FeedSort = 'latest' | 'trending' | 'popular';
export type FeedNavigation = { topic: string; sort: FeedSort };

export function readFeedNavigation(url: URL): FeedNavigation {
  const board = BOARD_PAGES.find(item => item.slug === url.searchParams.get('board'));
  const requestedSort = url.searchParams.get('sort');
  return {
    topic: board?.category ?? '전체 이야기',
    sort: requestedSort === 'trending' || requestedSort === 'popular' ? requestedSort : 'latest',
  };
}

export function feedNavigationUrl(current: URL, topic: string, sort: FeedSort): URL {
  const url = new URL(current);
  const board = boardForCategory(topic);
  url.searchParams.delete('story');
  if (board) url.searchParams.set('board', board.slug);
  else url.searchParams.delete('board');
  if (sort === 'latest') url.searchParams.delete('sort');
  else url.searchParams.set('sort', sort);
  url.hash = 'feed';
  return url;
}

export function shouldHandleFeedLink(event: {
  defaultPrevented: boolean; button: number; metaKey: boolean; ctrlKey: boolean;
  shiftKey: boolean; altKey: boolean;
}, target = '', download = false): boolean {
  return !event.defaultPrevented && event.button === 0 && !event.metaKey && !event.ctrlKey
    && !event.shiftKey && !event.altKey && (!target || target === '_self') && !download;
}
