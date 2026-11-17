import { getCommunityIdentity, type CommunityAuthEnv } from "../_lib/community-auth";
import { PUBLIC_POST_SQL } from "../_lib/community-channels";
import { BoardError, checkMutationRequest, readJsonBody } from "../../src/lib/community/domain";

const headers = { "Cache-Control": "private, no-store", "Vary": "Cookie", "X-Content-Type-Options": "nosniff" };
const visibleRecipientPosts = `JOIN community_posts AS p ON p.id = n.post_id
  WHERE n.recipient_id = ?1 AND ${PUBLIC_POST_SQL}`;
const unreadCountSql = `SELECT
  (SELECT COUNT(*) FROM community_notifications AS n ${visibleRecipientPosts} AND n.read_at IS NULL) +
  (SELECT COUNT(*) FROM community_like_notifications AS n ${visibleRecipientPosts}
   AND n.read_at IS NULL AND n.like_count > 0) AS unreadCount`;
const markCommentsRead = "UPDATE community_notifications SET read_at = ? WHERE recipient_id = ? AND read_at IS NULL";
const markLikesRead = "UPDATE community_like_notifications SET read_at = ? WHERE recipient_id = ? AND read_at IS NULL AND like_count > 0";

function json(data: unknown, status = 200) {
  return Response.json(data, { status, headers });
}

function failure(error: unknown) {
  if (error instanceof BoardError) return json({ error: error.message }, error.status);
  return json({ error: "알림을 불러오지 못했어요. 잠시 후 다시 시도해 주세요." }, 503);
}

async function requireRecipient(request: Request, env: CommunityAuthEnv): Promise<string> {
  const recipient = await getCommunityIdentity(request, env);
  if (!recipient) throw new BoardError("알림을 확인하려면 로그인해 주세요.", 401);
  return recipient;
}

type InboxRow = {
  id: string;
  postId: string;
  postTitle: string;
  createdAt: number;
  read: number;
  unreadCount: number;
} & ({ kind: "comment"; likeCount: null } | { kind: "like"; likeCount: number });

export const onRequestGet: PagesFunction<CommunityAuthEnv> = async ({ request, env }) => {
  try {
    const recipient = await requireRecipient(request, env);
    if (new URL(request.url).searchParams.get("summary") === "1") {
      const count = await env.DB.prepare(unreadCountSql).bind(recipient).first<{ unreadCount: number }>();
      return json({ unreadCount: count?.unreadCount ?? 0 });
    }

    // The latest 30 items and the full unread count reflect the same database snapshot.
    const inbox = await env.DB.prepare(`
      WITH recent AS (
        SELECT n.comment_id AS id, n.post_id AS postId, p.title AS postTitle, n.created_at AS createdAt,
               n.read_at, 'comment' AS kind, NULL AS likeCount
        FROM community_notifications AS n ${visibleRecipientPosts}
        UNION ALL
        SELECT n.id, n.post_id, p.title, n.created_at, n.read_at, 'like', n.like_count
        FROM community_like_notifications AS n ${visibleRecipientPosts} AND n.like_count > 0
        ORDER BY createdAt DESC, id DESC LIMIT 30
      )
      SELECT n.id, n.postId, n.postTitle, n.createdAt, (n.read_at IS NOT NULL) AS read,
             n.kind, n.likeCount, (${unreadCountSql}) AS unreadCount
      FROM recent AS n
      ORDER BY n.createdAt DESC, n.id DESC
    `).bind(recipient).all<InboxRow>();
    return json({
      notifications: inbox.results.map(({ id, postId, postTitle, createdAt, read, kind, likeCount }) => {
        const notice = { id, postId, postTitle, createdAt, read: Boolean(read), kind };
        return kind === "like" ? { ...notice, likeCount } : notice;
      }),
      unreadCount: inbox.results[0]?.unreadCount ?? 0,
    });
  } catch (error) { return failure(error); }
};

export const onRequestPost: PagesFunction<CommunityAuthEnv> = async ({ request, env }) => {
  try {
    checkMutationRequest(request);
    const recipient = await requireRecipient(request, env);
    const data = await readJsonBody(request);
    const now = Date.now();
    if (data.all === true && data.id === undefined) {
      await env.DB.batch([
        env.DB.prepare(markCommentsRead).bind(now, recipient),
        env.DB.prepare(markLikesRead).bind(now, recipient),
      ]);
    } else if (data.all === undefined && typeof data.id === "string" && /^(?:like:)?[a-zA-Z0-9_-]{1,80}$/.test(data.id)) {
      const sql = data.id.startsWith("like:") ? markLikesRead + " AND id = ?" : markCommentsRead + " AND comment_id = ?";
      await env.DB.prepare(sql).bind(now, recipient, data.id).run();
    } else {
      throw new BoardError("읽음으로 표시할 알림을 확인해 주세요.");
    }
    return json({ ok: true });
  } catch (error) { return failure(error); }
};
