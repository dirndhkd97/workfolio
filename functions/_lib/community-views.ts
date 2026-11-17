import { BoardError } from '../../src/lib/community/domain';
import { PUBLIC_POST_SQL } from './community-channels';

export const VIEW_WINDOW_MS = 86400000;
const VISITOR_TTL = 30 * VIEW_WINDOW_MS;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const HEADERS = { 'Cache-Control': 'private, no-store', Vary: 'Cookie', 'X-Content-Type-Options': 'nosniff' };
export function viewJson(data: unknown, status = 200, cookie?: string): Response {
  return Response.json(data, { status, headers: { ...HEADERS, ...(status === 429 ? { 'Retry-After': '3600' } : {}), ...(cookie ? { 'Set-Cookie': cookie } : {}) } });
}
async function digest(value: string): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
function local(request: Request): boolean {
  const url = new URL(request.url);
  return url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
}
function cookieName(request: Request) { return `${local(request) ? '' : '__Host-'}community_viewer`; }
async function rate(db: D1Database, key: string, now: number, maximum: number): Promise<void> {
  const accepted = await db.prepare(`INSERT INTO community_view_limits (key,window_started_at,attempts)
    SELECT ?,?,1 WHERE (SELECT COUNT(*) FROM community_view_limits) < 50000 OR EXISTS (SELECT 1 FROM community_view_limits WHERE key = ?)
    ON CONFLICT(key) DO UPDATE SET
      window_started_at = CASE WHEN community_view_limits.window_started_at <= excluded.window_started_at - 3600000 THEN excluded.window_started_at ELSE community_view_limits.window_started_at END,
      attempts = CASE WHEN community_view_limits.window_started_at <= excluded.window_started_at - 3600000 THEN 1 ELSE community_view_limits.attempts + 1 END
    WHERE community_view_limits.window_started_at <= excluded.window_started_at - 3600000 OR community_view_limits.attempts < ? RETURNING attempts`)
    .bind(key, now, key, maximum).first();
  if (!accepted) throw new BoardError('조회 요청이 많아요. 잠시 후 다시 시도해 주세요.', 429);
}
export async function cleanupViews(db: D1Database, now: number): Promise<void> {
  // Each request performs bounded cleanup. No IP, user agent, or raw account/cookie value is stored here.
  await db.batch([
    db.prepare('DELETE FROM community_view_receipts WHERE rowid IN (SELECT rowid FROM community_view_receipts WHERE counted_at <= ? LIMIT 200)').bind(now - VIEW_WINDOW_MS),
    db.prepare('DELETE FROM community_view_visitors WHERE visitor_key IN (SELECT visitor_key FROM community_view_visitors WHERE expires_at <= ? LIMIT 200)').bind(now),
    db.prepare('DELETE FROM community_view_limits WHERE key IN (SELECT key FROM community_view_limits WHERE window_started_at <= ? LIMIT 200)').bind(now - 3600000),
  ]);
}
export async function recordView(request: Request, db: D1Database, postId: string, userId: string | null): Promise<Response> {
  const now = Date.now();
  const post = await db.prepare(`SELECT p.owner_id,p.view_count FROM community_posts p WHERE p.id = ? AND ${PUBLIC_POST_SQL}`).bind(postId).first<{owner_id:string;view_count:number}>();
  if (!post) throw new BoardError('삭제되었거나 찾을 수 없는 이야기예요.', 404);
  if (post.owner_id === userId) return viewJson({ viewCount: post.view_count, counted: false, retry: false });
  await cleanupViews(db, now);
  // A global cap bounds cookie churn and storage growth even when a visitor discards their cookie.
  await rate(db, 'global:requests', now, 20000);
  const cookie = request.headers.get('Cookie') || '';
  const value = cookie.split(';').map(part => part.trim()).find(part => part.startsWith(`${cookieName(request)}=`))?.slice(cookieName(request).length + 1);
  const candidate = value && TOKEN.test(value) ? `visitor:${await digest(value)}` : null;
  const issued = candidate && await db.prepare('SELECT visitor_key FROM community_view_visitors WHERE visitor_key = ? AND expires_at > ?').bind(candidate, now).first();
  let viewerKey: string;
  if (userId) viewerKey = `account:${await digest(userId)}`;
  else {
    if (!issued) {
      await rate(db, 'global:issuance', now, 5000);
      const token = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      const key = `visitor:${await digest(token)}`;
      const result = await db.prepare(`INSERT INTO community_view_visitors (visitor_key,expires_at)
        SELECT ?,? WHERE (SELECT COUNT(*) FROM community_view_visitors) < 100000`).bind(key, now + VISITOR_TTL).run();
      if (!result.meta.changes) throw new BoardError('조회 집계를 잠시 쉬고 있어요. 나중에 다시 시도해 주세요.', 429);
      return viewJson({ viewCount: post.view_count, counted: false, retry: true }, 200,
        `${cookieName(request)}=${token}; Path=/; HttpOnly; ${local(request) ? '' : 'Secure; '}SameSite=Lax; Max-Age=${VISITOR_TTL / 1000}`);
    }
    viewerKey = candidate!;
  }
  await rate(db, viewerKey, now, 120);
  const claimId = crypto.randomUUID();
  // Each claim gets a fresh nonce. D1 batch transactions serialize the claim and increment;
  // retries and parallel requests cannot reuse a previously counted nonce.
  const bridge = userId && issued && candidate ? [db.prepare(`INSERT INTO community_view_receipts (post_id,viewer_key,counted_at,claim_id)
      SELECT post_id,?,counted_at,? FROM community_view_receipts WHERE post_id = ? AND viewer_key = ? AND counted_at > ?
        AND ((SELECT COUNT(*) FROM community_view_receipts) < 200000 OR EXISTS (SELECT 1 FROM community_view_receipts WHERE post_id = ? AND viewer_key = ?))
      ON CONFLICT(post_id,viewer_key) DO UPDATE SET counted_at = MAX(community_view_receipts.counted_at,excluded.counted_at)`)
      .bind(viewerKey, `bridge:${claimId}`, postId, candidate, now - VIEW_WINDOW_MS, postId, viewerKey)] : [];
  const result = await db.batch([
    ...bridge,
    db.prepare(`INSERT INTO community_view_receipts (post_id,viewer_key,counted_at,claim_id)
      SELECT ?,?,?,? WHERE EXISTS (SELECT 1 FROM community_posts p WHERE p.id = ? AND p.owner_id <> ? AND ${PUBLIC_POST_SQL})
        AND ((SELECT COUNT(*) FROM community_view_receipts) < 200000 OR EXISTS (SELECT 1 FROM community_view_receipts WHERE post_id = ? AND viewer_key = ?))
      ON CONFLICT(post_id,viewer_key) DO UPDATE SET counted_at = excluded.counted_at,claim_id = excluded.claim_id
      WHERE community_view_receipts.counted_at <= excluded.counted_at - ?`)
      .bind(postId, viewerKey, now, claimId, postId, userId || '', postId, viewerKey, VIEW_WINDOW_MS),
    db.prepare(`UPDATE community_posts AS p SET view_count = view_count + 1 WHERE p.id = ? AND p.owner_id <> ? AND ${PUBLIC_POST_SQL}
      AND EXISTS (SELECT 1 FROM community_view_receipts WHERE post_id = p.id AND viewer_key = ? AND claim_id = ?)`)
      .bind(postId, userId || '', viewerKey, claimId),
    ...(userId && issued && candidate ? [db.prepare(`INSERT INTO community_view_receipts (post_id,viewer_key,counted_at,claim_id)
      SELECT post_id,?,counted_at,? FROM community_view_receipts WHERE post_id = ? AND viewer_key = ?
        AND ((SELECT COUNT(*) FROM community_view_receipts) < 200000 OR EXISTS (SELECT 1 FROM community_view_receipts WHERE post_id = ? AND viewer_key = ?))
      ON CONFLICT(post_id,viewer_key) DO UPDATE SET counted_at = MAX(community_view_receipts.counted_at,excluded.counted_at)`)
      .bind(candidate, `bridge:${claimId}`, postId, viewerKey, postId, candidate)] : []),
  ]);
  const current = await db.prepare(`SELECT p.view_count FROM community_posts p WHERE p.id = ? AND ${PUBLIC_POST_SQL}`).bind(postId).first<{view_count:number}>();
  if (!current) throw new BoardError('삭제되었거나 찾을 수 없는 이야기예요.', 404);
  return viewJson({ viewCount: current.view_count, counted: result[bridge.length + 1].meta.changes === 1, retry: false });
}
