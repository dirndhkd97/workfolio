import type { Channel, Post } from "./domain";

export type ChannelPanelTab = 'browse' | 'mine' | 'apply' | 'review';
export type ChannelNavigation = { tab: ChannelPanelTab | null; channelId: string; manageId: string };
const tabs: ChannelPanelTab[] = ['browse', 'mine', 'apply', 'review'];
const safeId = (value: string | null) => value && /^[a-zA-Z0-9_-]{1,80}$/.test(value) ? value : '';

export function readChannelNavigation(url: URL): ChannelNavigation {
  const value = url.searchParams.get('channels') as ChannelPanelTab;
  const tab = tabs.includes(value) ? value : null;
  return { tab, channelId: safeId(url.searchParams.get('channel')), manageId: tab === 'mine' ? safeId(url.searchParams.get('manage')) : '' };
}
export function channelPanelUrl(current: URL, tab: ChannelPanelTab | null, manageId = ''): URL {
  const url = new URL(current);
  url.searchParams.delete('story');
  url.searchParams.delete('manage');
  if (tab) url.searchParams.set('channels', tab);
  else url.searchParams.delete('channels');
  if (tab === 'mine' && safeId(manageId)) url.searchParams.set('manage', manageId);
  return url;
}
export function channelFeedUrl(current: URL, channelId: string): URL {
  const url = channelPanelUrl(current, null);
  url.searchParams.delete('board');
  url.searchParams.delete('sort');
  if (safeId(channelId)) url.searchParams.set('channel', channelId);
  else url.searchParams.delete('channel');
  url.hash = 'feed';
  return url;
}
export class ChannelApiError extends Error {
  status: number;
  constructor(message: string, status: number) { super(message); this.status = status; }
}
export async function channelApi<T>(query = '', body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`/api/channels${query}`, body ? {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal,
  } : { cache: 'no-store', signal });
  const data = await response.json() as T & { error?: string };
  if (!response.ok) throw new ChannelApiError(data.error || '채널을 불러오지 못했어요. 잠시 후 다시 시도해 주세요.', response.status);
  return data;
}

// These flags only shape the UI; the server checks the same permissions on every request.
export function canManageChannel(channel: Pick<Channel, 'status' | 'mine'>, isModerator: boolean): boolean {
  return channel.status === 'active' && (channel.mine || isModerator);
}
export function canRestoreChannelPost(post: Pick<Post, 'status' | 'hiddenByScope'>, isModerator: boolean): boolean {
  return post.status === 'hidden' && (isModerator || post.hiddenByScope === 'channel');
}
