import { getCommunityIdentity, type CommunityAuthEnv } from "../_lib/community-auth";
import {
  BoardError, LIMITS, REACTIONS, checkMutationRequest, readJsonBody,
  textField, validPostId, validateCreate,
  type Category, type Comment, type Post, type Reaction,
} from "../../src/lib/community/domain";
import { SAMPLE_POSTS } from "../../src/lib/community/sample-posts";

const headers = { "Cache-Control": "private, no-store", "Vary": "Cookie", "X-Content-Type-Options": "nosniff" };
function json(data: unknown, status = 200) {
  return Response.json(data, { status, headers: status === 429 ? { ...headers, "Retry-After": "60" } : headers });
}
function database(env: CommunityAuthEnv): D1Database {
  if (!env.DB) throw new BoardError("저장소를 준비하고 있어요. 잠시 후 다시 시도해 주세요.", 503);
  return env.DB;
}
function failure(error: unknown) {
  if (error instanceof BoardError) return json({ error: error.message }, error.status);
  // Do not log request bodies, raw identity, or storage errors containing user content.
  return json({ error: "지금은 요청을 완료하지 못했어요. 잠시 후 다시 시도해 주세요." }, 503);
}
// One row per verified account; the conditional upsert makes concurrent requests atomic.
async function limitWrites(db: D1Database, userId: string): Promise<void> {
  const accepted = await db.prepare(`
    INSERT INTO community_write_limits (owner_id, window_started_at, attempts) VALUES (?, ?, 1)
    ON CONFLICT(owner_id) DO UPDATE SET
      window_started_at = CASE WHEN community_write_limits.window_started_at <= excluded.window_started_at - 60000
        THEN excluded.window_started_at ELSE community_write_limits.window_started_at END,
      attempts = CASE WHEN community_write_limits.window_started_at <= excluded.window_started_at - 60000
        THEN 1 ELSE community_write_limits.attempts + 1 END
    WHERE community_write_limits.window_started_at <= excluded.window_started_at - 60000
      OR community_write_limits.attempts < 30
    RETURNING attempts
  `).bind(userId, Date.now()).first<{ attempts: number }>();
  if (!accepted) throw new BoardError("잠깐만요! 요청이 많아요. 1분 뒤 다시 시도해 주세요.", 429);
}
interface StoredPost { id: string; owner_id: string; title: string; body: string; category: Category; nickname: string; created_at: number }
function publicPost(row: StoredPost, userId: string | null): Post {
  return { id: row.id, title: row.title, body: row.body, category: row.category, nickname: row.nickname, createdAt: row.created_at,
    sample: false, reactions: { same: 0, laugh: 0, cheer: 0 }, myReactions: [], commentCount: 0, mine: row.owner_id === userId };
}
async function enrich(db: D1Database, posts: Post[], userId: string | null): Promise<Post[]> {
  if (!posts.length) return [];
  const ids = posts.map((post) => post.id);
  const slots = ids.map(() => "?").join(",");
  const [counts, commentCounts, own] = await Promise.all([
    db.prepare(`SELECT post_id, reaction, COUNT(*) AS count FROM community_reactions WHERE active = 1 AND post_id IN (${slots}) GROUP BY post_id, reaction`).bind(...ids).all<{ post_id: string; reaction: Reaction; count: number }>(),
    db.prepare(`SELECT post_id, COUNT(*) AS count FROM community_comments WHERE post_id IN (${slots}) GROUP BY post_id`).bind(...ids).all<{ post_id: string; count: number }>(),
    userId ? db.prepare(`SELECT post_id, reaction FROM community_reactions WHERE owner_id = ? AND active = 1 AND post_id IN (${slots})`).bind(userId, ...ids).all<{ post_id: string; reaction: Reaction }>() : Promise.resolve({ results: [] }),
  ]);
  return posts.map((post) => {
    const reactions = { same: 0, laugh: 0, cheer: 0 };
    for (const item of counts.results) if (item.post_id === post.id && REACTIONS.includes(item.reaction)) reactions[item.reaction] = item.count;
    return { ...post, reactions, commentCount: commentCounts.results.find((item) => item.post_id === post.id)?.count ?? 0,
      myReactions: own.results.filter((item) => item.post_id === post.id).map((item) => item.reaction) };
  });
}
async function getPost(db: D1Database, id: string, userId: string | null): Promise<Post> {
  const sample = SAMPLE_POSTS.find((post) => post.id === id);
  if (sample) return (await enrich(db, [sample], userId))[0];
  const row = await db.prepare("SELECT * FROM community_posts WHERE id = ?").bind(id).first<StoredPost>();
  if (!row) throw new BoardError("삭제되었거나 찾을 수 없는 이야기예요.", 404);
  return (await enrich(db, [publicPost(row, userId)], userId))[0];
}
export const onRequestGet: PagesFunction<CommunityAuthEnv> = async ({ request, env }) => {
  try {
    const db = database(env);
    const userId = await getCommunityIdentity(request, env);
    const id = new URL(request.url).searchParams.get("id");
    if (id !== null) {
      const post = await getPost(db, validPostId(id), userId);
      const rows = await db.prepare("SELECT id, body, nickname, created_at AS createdAt FROM community_comments WHERE post_id = ? ORDER BY created_at ASC, id ASC LIMIT 500").bind(id).all<Comment>();
      return json({ post, comments: rows.results, signedIn: Boolean(userId) });
    }
    const rows = await db.prepare("SELECT * FROM community_posts ORDER BY created_at DESC, id DESC LIMIT 60").all<StoredPost>();
    const posts = await enrich(db, [...rows.results.map((row) => publicPost(row, userId)), ...SAMPLE_POSTS], userId);
    return json({ posts, signedIn: Boolean(userId) });
  } catch (error) { return failure(error); }
}
export const onRequestPost: PagesFunction<CommunityAuthEnv> = async ({ request, env }) => {
  try {
    checkMutationRequest(request);
    const userId = await getCommunityIdentity(request, env);
    if (!userId) throw new BoardError("글과 댓글을 남기려면 먼저 로그인해 주세요.", 401);
    const data = await readJsonBody(request);
    const db = database(env);
    await limitWrites(db, userId);
    if (data.action === "create") {
      const value = validateCreate(data);
      const id = crypto.randomUUID();
      const now = Date.now();
      await db.prepare("INSERT INTO community_posts (id, owner_id, title, body, category, nickname, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .bind(id, userId, value.title, value.body, value.category, value.nickname, now).run();
      return json({ post: await getPost(db, id, userId) }, 201);
    }
    if (!["comment", "react", "report", "delete"].includes(String(data.action))) throw new BoardError("지원하지 않는 요청이에요.");
    const id = validPostId(data.postId);
    const post = await getPost(db, id, userId);
    if (data.action === "delete") {
      if (post.sample || !post.mine) throw new BoardError("직접 쓴 이야기만 삭제할 수 있어요.", 403);
      // D1 batches are transactional. Every delete is owner-scoped, including associated data.
      const ownerExists = "EXISTS (SELECT 1 FROM community_posts WHERE id = ? AND owner_id = ?)";
      const result = await db.batch([
        db.prepare(`DELETE FROM community_comments WHERE post_id = ? AND ${ownerExists}`).bind(id, id, userId),
        db.prepare(`DELETE FROM community_reactions WHERE post_id = ? AND ${ownerExists}`).bind(id, id, userId),
        db.prepare(`DELETE FROM community_reports WHERE post_id = ? AND ${ownerExists}`).bind(id, id, userId),
        db.prepare("DELETE FROM community_posts WHERE id = ? AND owner_id = ?").bind(id, userId),
      ]);
      if (!result[3].meta.changes) throw new BoardError("이미 삭제된 이야기예요.", 404);
      return json({ ok: true });
    }
    // A conditional INSERT also prevents orphan writes if the author deletes during this request.
    const exists = "(? = 1 OR EXISTS (SELECT 1 FROM community_posts WHERE id = ?))";
    if (data.action === "comment") {
      const body = textField(data.body, "댓글", LIMITS.comment);
      const comment: Comment = { id: crypto.randomUUID(), body, nickname: "익명의 동료", createdAt: Date.now() };
      const result = await db.prepare(`INSERT INTO community_comments (id, post_id, owner_id, body, nickname, created_at) SELECT ?, ?, ?, ?, ?, ? WHERE ${exists}`)
        .bind(comment.id, id, userId, body, comment.nickname, comment.createdAt, post.sample ? 1 : 0, id).run();
      if (!result.meta.changes) throw new BoardError("이미 삭제된 이야기예요.", 404);
      return json({ comment }, 201);
    }
    if (data.action === "react") {
      if (!REACTIONS.includes(data.reaction as Reaction)) throw new BoardError("올바른 공감을 선택해 주세요.");
      const result = await db.prepare(`INSERT INTO community_reactions (post_id, owner_id, reaction, active) SELECT ?, ?, ?, 1 WHERE ${exists} ON CONFLICT(post_id, owner_id, reaction) DO UPDATE SET active = 1 - active`)
        .bind(id, userId, data.reaction as string, post.sample ? 1 : 0, id).run();
      if (!result.meta.changes) throw new BoardError("이미 삭제된 이야기예요.", 404);
      return json({ post: await getPost(db, id, userId) });
    }
    const reason = textField(data.reason, "신고 사유", LIMITS.report, 2);
    const result = await db.prepare(`INSERT INTO community_reports (post_id, owner_id, reason, created_at) SELECT ?, ?, ?, ? WHERE ${exists} ON CONFLICT(post_id, owner_id) DO UPDATE SET reason = excluded.reason, created_at = excluded.created_at`)
      .bind(id, userId, reason, Date.now(), post.sample ? 1 : 0, id).run();
    if (!result.meta.changes) throw new BoardError("이미 삭제된 이야기예요.", 404);
    return json({ ok: true });
  } catch (error) { return failure(error); }
}
