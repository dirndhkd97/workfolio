import { getCommunityIdentity } from '../_lib/community-auth';
import { isCommunityModerator, limitChannelWrites, publicChannel, validateChannelRequest, type CommunityChannelEnv, type StoredChannel } from '../_lib/community-channels';
import { BoardError, checkMutationRequest, readJsonBody, textField, validPostId, type Post } from '../../src/lib/community/domain';

const headers = { 'Cache-Control': 'private, no-store', Vary: 'Cookie', 'X-Content-Type-Options': 'nosniff' };
function json(data: unknown, status = 200) { return Response.json(data, { status, headers: status === 429 ? { ...headers, 'Retry-After': '60' } : headers }); }
function failure(error: unknown) {
  return error instanceof BoardError ? json({ error: error.message }, error.status) : json({ error: '채널 요청을 처리하지 못했어요. 잠시 후 다시 시도해 주세요.' }, 503);
}
async function channel(db: D1Database, id: string): Promise<StoredChannel> {
  const row = await db.prepare('SELECT * FROM community_channels WHERE id = ?').bind(id).first<StoredChannel>();
  if (!row) throw new BoardError('채널을 찾을 수 없어요.', 404);
  return row;
}
function audit(db: D1Database, row: Pick<StoredChannel, 'id' | 'owner_id'>, actor: string, action: string, previous: string | null, next: string, note: string, now: number, postId: string | null = null) {
  // changes() refers to the preceding mutation in the same serialized D1 batch transaction.
  return db.prepare(`INSERT INTO community_channel_audit (id,channel_id,post_id,actor_id,applicant_id,action,previous_state,next_state,note,created_at)
    SELECT ?,?,?,?,?,?,?,?,?,? WHERE changes() > 0`).bind(crypto.randomUUID(), row.id, postId, actor, row.owner_id, action, previous, next, note, now);
}
export const onRequestGet: PagesFunction<CommunityChannelEnv> = async ({ request, env }) => {
  try {
    if (!env.DB) throw new BoardError('저장소를 준비하고 있어요.', 503);
    const userId = await getCommunityIdentity(request, env), moderator = isCommunityModerator(env, userId);
    const params = new URL(request.url).searchParams;
    if (params.has('manage')) {
      if (!userId) throw new BoardError('로그인해 주세요.', 401);
      const row = await channel(env.DB, validPostId(params.get('manage')));
      if (!moderator && row.owner_id !== userId) throw new BoardError('이 채널을 관리할 권한이 없어요.', 403);
      if (row.status !== 'active') throw new BoardError('승인된 채널만 관리할 수 있어요.', 409);
      const posts = await env.DB.prepare(`SELECT p.id,p.title,p.body,p.category,p.nickname,p.company_name,p.is_admin_author,p.created_at,p.status,p.hidden_by_scope,p.view_count,
        (SELECT COUNT(DISTINCT r.owner_id) FROM community_reactions r WHERE r.post_id = p.id AND r.active = 1) AS like_count,
        EXISTS (SELECT 1 FROM community_reactions r WHERE r.post_id = p.id AND r.owner_id = ? AND r.active = 1) AS liked,
        CASE WHEN p.owner_id = ? THEN 1 ELSE 0 END AS mine FROM community_posts p WHERE p.channel_id = ? ${moderator ? '' : "AND (p.status = 'published' OR p.hidden_by_scope = 'channel')"} ORDER BY p.created_at DESC,p.id DESC LIMIT 200`)
        .bind(userId, userId, row.id).all<{id:string;title:string;body:string;category:Post['category'];nickname:string;company_name:string|null;is_admin_author:number;created_at:number;status:Post['status'];hidden_by_scope:Post['hiddenByScope'];view_count:number;like_count:number;liked:number;mine:number}>();
      // Consent is per report. Existing reports default to platform-private. No reporter identifier is selected.
      const reports = await env.DB.prepare(`SELECT 'report-' || r.rowid AS id,r.post_id AS postId,r.reason,r.created_at AS createdAt
        FROM community_reports r JOIN community_posts p ON p.id = r.post_id
        WHERE p.channel_id = ? AND r.dismissed_at IS NULL ${moderator ? '' : "AND r.share_with_channel = 1 AND r.channel_dismissed_at IS NULL AND (p.status = 'published' OR p.hidden_by_scope = 'channel')"} ORDER BY r.created_at DESC LIMIT 200`).bind(row.id).all();
      return json({ channel: publicChannel(row, userId, moderator), posts: posts.results.map(post => ({
        id: post.id, title: post.title, body: post.body, category: post.category, nickname: post.nickname,
        companyName: post.company_name, isAdminAuthor: Boolean(post.company_name) && post.is_admin_author === 1, createdAt: post.created_at,
        status: post.status, hiddenByScope: post.hidden_by_scope, viewCount: post.view_count, channelId: row.id, channelName: row.name,
        mine: post.mine === 1, sample: false, images: [], reactions: { same: 0, laugh: 0, cheer: 0 }, myReactions: [], likeCount: post.like_count, liked: post.liked === 1, commentCount: 0,
      })), reports: reports.results, signedIn: true, isModerator: moderator });
    }
    if (params.get('review') === '1') {
      if (!userId) throw new BoardError('로그인해 주세요.', 401);
      if (!moderator) throw new BoardError('플랫폼 운영자만 심사할 수 있어요.', 403);
      const rows = await env.DB.prepare("SELECT * FROM community_channels WHERE status = 'pending' ORDER BY created_at,id LIMIT 100").all<StoredChannel>();
      return json({ requests: rows.results.map(row => publicChannel(row, userId, true)), signedIn: true, isModerator: true });
    }
    if (params.get('mine') === '1') {
      if (!userId) throw new BoardError('로그인해 주세요.', 401);
      const rows = await env.DB.prepare('SELECT * FROM community_channels WHERE owner_id = ? ORDER BY created_at DESC,id DESC LIMIT 100').bind(userId).all<StoredChannel>();
      return json({ requests: rows.results.map(row => publicChannel(row, userId, moderator)), signedIn: true, isModerator: moderator });
    }
    const rows = await env.DB.prepare("SELECT * FROM community_channels WHERE status = 'active' ORDER BY name,id LIMIT 200").all<StoredChannel>();
    return json({ channels: rows.results.map(row => publicChannel(row, userId, moderator)), signedIn: Boolean(userId), isModerator: moderator });
  } catch (error) { return failure(error); }
};
export const onRequestPost: PagesFunction<CommunityChannelEnv> = async ({ request, env }) => {
  try {
    checkMutationRequest(request);
    const userId = await getCommunityIdentity(request, env);
    if (!userId) throw new BoardError('채널을 신청하거나 관리하려면 로그인해 주세요.', 401);
    if (!env.DB) throw new BoardError('저장소를 준비하고 있어요.', 503);
    const data = await readJsonBody(request), moderator = isCommunityModerator(env, userId), db = env.DB, now = Date.now();
    if (!['request','approve','reject','hide','restore','dismiss'].includes(String(data.action))) throw new BoardError('지원하지 않는 요청이에요.');
    await limitChannelWrites(db, userId, data.action === 'request');
    if (data.action === 'request') {
      const value = validateChannelRequest(data), id = crypto.randomUUID();
      const result = await db.batch([
        db.prepare(`INSERT INTO community_channels (id,owner_id,name,normalized_name,description,rules,status,created_at)
          SELECT ?,?,?,?,?,?,'pending',? WHERE (SELECT COUNT(*) FROM community_channels WHERE owner_id = ? AND status = 'active') < 3
          AND NOT EXISTS (SELECT 1 FROM community_channels WHERE owner_id = ? AND status = 'pending') ON CONFLICT DO NOTHING`)
          .bind(id, userId, value.name, value.normalizedName, value.description, value.rules, now, userId, userId),
        audit(db, { id, owner_id: userId }, userId, 'request', null, 'pending', '', now),
      ]);
      if (result[0].meta.changes !== 1) throw new BoardError('사용 중인 채널 이름이거나 개설 한도를 넘었어요. 심사 중 1개, 운영 중 3개까지 가능해요.', 409);
      return json({ channel: publicChannel(await channel(db, id), userId, moderator) }, 201);
    }
    const row = await channel(db, validPostId(data.channelId));
    const note = data.action === 'approve' && (data.note === undefined || data.note === '') ? '' : textField(data.note, '처리 사유', 500, 2);
    if (data.action === 'approve' || data.action === 'reject') {
      if (!moderator) throw new BoardError('플랫폼 운영자만 채널을 승인하거나 반려할 수 있어요.', 403);
      const next = data.action === 'approve' ? 'active' : 'rejected';
      // An allowlisted platform moderator may explicitly review their own application. Company badges never qualify.
      const result = await db.batch([
        db.prepare(`UPDATE community_channels SET status = ?,reviewed_at = ?,reviewed_by = ?,review_note = ? WHERE id = ? AND status = 'pending'
          AND (? = 'rejected' OR (SELECT COUNT(*) FROM community_channels c WHERE c.owner_id = community_channels.owner_id AND c.status = 'active') < 3)`)
          .bind(next, now, userId, note, row.id, next),
        audit(db, row, userId, String(data.action), 'pending', next, note, now),
      ]);
      if (result[0].meta.changes !== 1) throw new BoardError('이미 처리된 신청이거나 운영 한도를 넘었어요.', 409);
      return json({ channel: publicChannel(await channel(db, row.id), userId, true) });
    }
    if (!moderator && row.owner_id !== userId) throw new BoardError('이 채널을 관리할 권한이 없어요.', 403);
    if (row.status !== 'active') throw new BoardError('승인된 채널만 관리할 수 있어요.', 409);
    const postId = validPostId(data.postId);
    const post = await db.prepare('SELECT status,hidden_by_scope FROM community_posts WHERE id = ? AND channel_id = ?').bind(postId, row.id).first<{status:string;hidden_by_scope:string|null}>();
    if (!post) throw new BoardError('채널의 글을 찾을 수 없어요.', 404);
    const scope = moderator ? 'platform' : 'channel';
    if (!moderator && post.status === 'hidden' && post.hidden_by_scope !== 'channel') throw new BoardError('플랫폼이 숨긴 글은 채널 관리자가 복구할 수 없어요.', 403);
    if (data.action === 'dismiss') {
      const result = await db.batch([
        db.prepare(`UPDATE community_reports SET ${moderator ? 'dismissed_at' : 'channel_dismissed_at'} = ? WHERE post_id = ? AND dismissed_at IS NULL ${moderator ? '' : 'AND share_with_channel = 1 AND channel_dismissed_at IS NULL'}
          AND EXISTS (SELECT 1 FROM community_posts WHERE id = ? AND channel_id = ?)`)
          .bind(now, postId, postId, row.id),
        audit(db, row, userId, 'dismiss', 'open', 'dismissed', note, now, postId),
      ]);
      if (!result[0].meta.changes) throw new BoardError('처리할 신고가 없어요.', 409);
      return json({ ok: true });
    }
    const next = data.action === 'hide' ? 'hidden' : 'published';
    if (post.status === next && !(moderator && next === 'hidden' && post.hidden_by_scope === 'channel')) throw new BoardError('이미 처리된 글이에요.', 409);
    const result = await db.batch([
      db.prepare(`UPDATE community_posts SET status = ?,hidden_by_scope = ? WHERE id = ? AND channel_id = ? AND status = ?
        AND hidden_by_scope IS ? AND EXISTS (SELECT 1 FROM community_channels WHERE id = ? AND status = 'active' ${moderator ? '' : 'AND owner_id = ?'})`)
        .bind(next, next === 'hidden' ? scope : null, postId, row.id, post.status, post.hidden_by_scope, row.id, ...(moderator ? [] : [userId])),
      audit(db, row, userId, String(data.action), `${post.status}:${post.hidden_by_scope || 'none'}`, `${next}:${next === 'hidden' ? scope : 'none'}`, note, now, postId),
    ]);
    if (result[0].meta.changes !== 1) throw new BoardError('글 상태가 바뀌었어요. 새로고침 후 다시 시도해 주세요.', 409);
    return json({ ok: true });
  } catch (error) { return failure(error); }
};
