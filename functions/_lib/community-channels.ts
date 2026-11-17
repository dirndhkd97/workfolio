import type { CommunityAuthEnv } from './community-auth';
import { BoardError, CATEGORIES, textField, type Channel } from '../../src/lib/community/domain';

export interface CommunityChannelEnv extends CommunityAuthEnv { COMMUNITY_MODERATOR_USER_IDS?: string }
// Display badges and verified company domains are not moderation credentials.
export function isCommunityModerator(env: CommunityChannelEnv, userId: string | null): boolean {
  return Boolean(userId && typeof env.COMMUNITY_MODERATOR_USER_IDS === 'string'
    && env.COMMUNITY_MODERATOR_USER_IDS.split(/[,\s]+/).filter(Boolean).includes(userId));
}
export const PUBLIC_POST_SQL = "p.status = 'published' AND (p.channel_id IS NULL OR EXISTS (SELECT 1 FROM community_channels c WHERE c.id = p.channel_id AND c.status = 'active'))";
export interface StoredChannel {
  id: string; owner_id: string; name: string; description: string; rules: string;
  status: Channel['status']; created_at: number; review_note: string;
}
export function publicChannel(row: StoredChannel, userId: string | null, moderator = false): Channel {
  return { id: row.id, name: row.name, description: row.description, rules: row.rules,
    status: row.status, createdAt: row.created_at, mine: row.owner_id === userId,
    ...((row.owner_id === userId || moderator) ? { reviewNote: row.review_note } : {}) };
}
export function normalizedChannelName(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('en-US').replace(/[\s\p{P}\p{S}]/gu, '');
}
export function validateChannelRequest(data: Record<string, unknown>) {
  if (data.originalConfirmed !== true) throw new BoardError('직접 만든 채널 소개와 운영 규칙인지 확인해 주세요.');
  const name = textField(data.name, '채널 이름', 30, 3);
  if (!/^[\p{L}\p{N} _-]+$/u.test(name)) throw new BoardError('채널 이름은 글자, 숫자, 공백, 밑줄, 하이픈만 사용할 수 있어요.');
  const normalizedName = normalizedChannelName(name);
  const reserved = [...CATEGORIES, '전체', '전체글', '공지', '공지사항', '운영자', '관리자', '공식', '워크폴리오', 'workfolio', 'workfoilo', 'admin', 'moderator'];
  if (normalizedName.length < 2 || reserved.some(value => normalizedChannelName(value) === normalizedName)
      || /workfolio|workfoilo|워크폴리오|관리자|운영자|공식|admin|moderator/.test(normalizedName)) throw new BoardError('기본 게시판이나 운영진으로 오해할 수 있는 이름은 사용할 수 없어요.');
  return { name, normalizedName, description: textField(data.description, '채널 소개', 500, 20), rules: textField(data.rules, '운영 규칙', 1000, 20) };
}
export async function limitChannelWrites(db: D1Database, userId: string, request: boolean): Promise<void> {
  const now = Date.now(), interval = request ? 86400000 : 60000, maximum = request ? 6 : 30;
  await db.prepare('DELETE FROM community_channel_limits WHERE key IN (SELECT key FROM community_channel_limits WHERE window_started_at <= ? LIMIT 200)').bind(now - 86400000).run();
  const accepted = await db.prepare(`INSERT INTO community_channel_limits (key,window_started_at,attempts)
    SELECT ?,?,1 WHERE (SELECT COUNT(*) FROM community_channel_limits) < 50000 OR EXISTS (SELECT 1 FROM community_channel_limits WHERE key = ?)
    ON CONFLICT(key) DO UPDATE SET
      window_started_at = CASE WHEN community_channel_limits.window_started_at <= excluded.window_started_at - ? THEN excluded.window_started_at ELSE community_channel_limits.window_started_at END,
      attempts = CASE WHEN community_channel_limits.window_started_at <= excluded.window_started_at - ? THEN 1 ELSE community_channel_limits.attempts + 1 END
    WHERE community_channel_limits.window_started_at <= excluded.window_started_at - ? OR community_channel_limits.attempts < ? RETURNING attempts`)
    .bind(`${request ? 'request' : 'manage'}:${userId}`, now, `${request ? 'request' : 'manage'}:${userId}`, interval, interval, interval, maximum).first();
  if (!accepted) throw new BoardError('요청이 많아요. 잠시 후 다시 시도해 주세요.', 429);
}
