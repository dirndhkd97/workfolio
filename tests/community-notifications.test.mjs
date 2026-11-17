import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Log, LogLevel, Miniflare } from 'miniflare';
import { unstable_splitSqlQuery as splitSqlQuery } from 'wrangler';

// Run both Pages routes with real community session cookies and an isolated D1 database.
const root = new URL('../', import.meta.url);
const origin = 'https://workfolio.life';
const inbox = '/api/community-notifications';
const sessions = new Map();
let runtime, db;

before(async () => {
  const bundled = await build({
    stdin: {
      contents: `
        import * as board from './functions/api/board.ts';
        import * as notifications from './functions/api/community-notifications.ts';
        export default { fetch(request, env) {
          const route = new URL(request.url).pathname === '/api/board' ? board : notifications;
          return request.method === 'POST' ? route.onRequestPost({request, env}) : route.onRequestGet({request, env});
        } };
      `,
      resolveDir: fileURLToPath(root), loader: 'ts',
    },
    bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022',
  });
  runtime = new Miniflare({
    modules: true, script: bundled.outputFiles[0].text, compatibilityDate: '2024-12-01',
    d1Databases: ['DB'], log: new Log(LogLevel.NONE),
  });
  db = await runtime.getD1Database('DB');
  const migrations = new URL('migrations/', root);
  for (const name of readdirSync(migrations).filter(name => /^\d+_community_.*\.sql$/.test(name)).sort()) {
    const sql = readFileSync(new URL(name, migrations), 'utf8');
    await db.batch(splitSqlQuery(sql).map(statement => db.prepare(statement)));
  }
  for (const user of ['author', 'colleague', 'reader', 'third-reader']) {
    const token = randomBytes(32).toString('base64url');
    const tokenHash = createHash('sha256').update(token).digest('base64url');
    const now = Date.now();
    await db.batch([
      db.prepare('INSERT INTO community_users (id, nickname, created_at) VALUES (?, ?, ?)').bind(user, user, now),
      db.prepare('INSERT INTO community_sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
        .bind(tokenHash, user, now, now + 3600000),
    ]);
    sessions.set(user, `__Host-community_session=${token}`);
  }
});

beforeEach(async () => {
  await db.batch(['community_comments', 'community_reactions', 'community_posts', 'community_write_limits'].map(table => db.prepare(`DELETE FROM ${table}`)));
});
after(async () => { await runtime?.dispose(); });

function request(path, user, data, headers = {}) {
  return runtime.dispatchFetch(origin + path, {
    credentials: 'omit',
    method: data === undefined ? 'GET' : 'POST',
    headers: {
      ...(user ? { Cookie: sessions.get(user) } : {}),
      ...(data === undefined ? {} : { Origin: origin, 'Content-Type': 'application/json' }),
      ...headers,
    },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
}

async function json(path, user, data, expectedStatus = 200) {
  const response = await request(path, user, data);
  assert.equal(response.status, expectedStatus);
  return response.json();
}

async function publish(user) {
  const { post } = await json('/api/board', user, {
    action: 'create', title: '따뜻한 한마디', body: '오늘 동료의 따뜻한 한마디를 나눕니다.', category: '빡대가리 게시판',
  }, 201);
  return post;
}

const comment = (postId, user) => json('/api/board', user, { action: 'comment', postId, body: '덕분에 힘내서 퇴근해요.' }, 201);
const summary = user => json(inbox + '?summary=1', user);
const like = (postId, user, liked = true) => json('/api/board', user, { action: 'like', postId, liked });

test('a comment notifies only the author, preserves anonymity, and excludes self-comments and sample posts', async () => {
  const post = await publish('author');
  await comment(post.id, 'author');
  await json('/api/board', 'colleague', { action: 'comment', postId: 'sample-01', body: '예시 글 댓글' }, 404);
  assert.deepEqual(await summary('author'), { unreadCount: 0 });
  assert.equal(await db.prepare('SELECT COUNT(*) AS count FROM community_notifications').first('count'), 0);
  const { comment: added } = await comment(post.id, 'colleague');
  const response = await request(inbox, 'author');
  assert.equal(response.status, 200);
  assert.match(response.headers.get('cache-control'), /no-store/);
  assert.deepEqual(await response.json(), { unreadCount: 1, notifications: [
    { kind: 'comment', id: added.id, postId: post.id, postTitle: post.title, createdAt: added.createdAt, read: false },
  ] });
  for (const user of ['colleague', 'reader']) {
    assert.deepEqual(await json(inbox, user), { unreadCount: 0, notifications: [] });
  }

  await json(inbox, 'reader', { id: added.id });
  assert.deepEqual(await summary('author'), { unreadCount: 1 });
  for (let attempt = 0; attempt < 2; attempt++) {
    assert.deepEqual(await json(inbox, 'author', { id: added.id }), { ok: true });
    assert.deepEqual(await summary('author'), { unreadCount: 0 });
    assert.equal((await json(inbox, 'author')).notifications[0].read, true);
  }
});

test('both reads and writes require a session, and read mutations require same-origin JSON', async () => {
  const post = await publish('author');
  const { comment: added } = await comment(post.id, 'colleague');
  for (const path of [inbox, inbox + '?summary=1']) {
    assert.equal((await request(path, null)).status, 401);
  }
  assert.equal((await request(inbox, null, { id: added.id })).status, 401);
  for (const [headers, status] of [[{ Origin: 'https://example.test' }, 403], [{ 'Content-Type': 'text/plain' }, 415]]) {
    assert.equal((await request(inbox, 'author', { all: true }, headers)).status, status);
  }
  assert.deepEqual(await summary('author'), { unreadCount: 1 });
});

test('summary and mark-all include items older than the recent list and stay scoped to the current account', async () => {
  const post = await publish('author');
  const otherPost = await publish('reader');
  const { comment: otherComment } = await comment(otherPost.id, 'colleague');
  // Insert older comments in one D1 batch to exercise the real trigger beyond the board write-rate limit.
  const ids = Array.from({ length: 35 }, () => randomUUID());
  await db.batch(ids.map((id, index) => db.prepare(
    'INSERT INTO community_comments (id, post_id, owner_id, body, nickname, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).bind(id, post.id, 'colleague', '예전 댓글', '익명의 동료', 1000 + index)));
  const before = await json(inbox, 'author');
  assert.equal(before.unreadCount, 35);
  assert.deepEqual(await summary('author'), { unreadCount: 35 });
  assert.deepEqual(before.notifications.map(item => item.id), ids.slice(-30).reverse());
  assert.deepEqual(await json(inbox, 'author', { all: true }), { ok: true });
  assert.deepEqual(await summary('author'), { unreadCount: 0 });
  assert.ok((await json(inbox, 'author')).notifications.every(item => item.read));
  assert.deepEqual(await summary('reader'), { unreadCount: 1 });

  await json('/api/board', 'reader', { action: 'delete', postId: otherPost.id });
  assert.deepEqual(await json(inbox, 'reader'), { unreadCount: 0, notifications: [] });
  assert.deepEqual(await summary('reader'), { unreadCount: 0 });
  assert.deepEqual(await json(inbox, 'reader', { id: otherComment.id }), { ok: true });
  assert.equal((await json(inbox, 'author')).notifications.length, 30);
});

test('if saving the notification fails, the comment cannot commit on its own', async () => {
  const post = await publish('author');
  await db.prepare(`CREATE TRIGGER test_block_notification BEFORE INSERT ON community_notifications
    BEGIN SELECT RAISE(ABORT, 'test notification write failed'); END`).run();
  try {
    const response = await request('/api/board', 'colleague', { action: 'comment', postId: post.id, body: '다른 동료가 쓴 댓글' });
    assert.equal(response.status, 503);
    assert.deepEqual((await json('/api/board?id=' + post.id, 'author')).comments, []);
    assert.deepEqual(await summary('author'), { unreadCount: 0 });
  } finally {
    await db.prepare('DROP TRIGGER test_block_notification').run();
  }
});

test('likes group distinct people per post, order groups by the last like and contribute one unread item', async () => {
  const first = await publish('author');
  const second = await publish('author');
  await like(first.id, 'author');
  await json('/api/board', 'colleague', { action: 'like', postId: 'sample-01', liked: true }, 404);
  assert.deepEqual(await summary('author'), { unreadCount: 0 });

  await Promise.all([like(first.id, 'colleague'), like(first.id, 'colleague')]);
  const { notifications: [original] } = await json(inbox, 'author');
  assert.deepEqual(original, {
    id: original.id, kind: 'like', postId: first.id, postTitle: first.title, createdAt: original.createdAt, likeCount: 1, read: false,
  });
  assert.match(original.id, /^like:/);
  await like(second.id, 'reader');
  await comment(second.id, 'reader');
  await like(first.id, 'reader');
  const { notifications, unreadCount } = await json(inbox, 'author');
  assert.equal(unreadCount, 3);
  assert.deepEqual(await summary('author'), { unreadCount });
  assert.deepEqual(notifications.map(item => [item.kind, item.postId]), [
    ['like', first.id], ['comment', second.id], ['like', second.id],
  ]);
  assert.equal(notifications[0].id, original.id);
  assert.equal(notifications[0].likeCount, 2);
  assert.deepEqual(await json(inbox, 'colleague'), { notifications: [], unreadCount: 0 });

  await like(first.id, 'reader', false);
  await like(first.id, 'reader', false);
  assert.equal((await json(inbox, 'author')).notifications.find(item => item.id === original.id).likeCount, 1);
  await like(first.id, 'colleague', false);
  const afterUnlike = await json(inbox, 'author');
  assert.equal(afterUnlike.unreadCount, 2);
  assert.ok(afterUnlike.notifications.every(item => item.postId === second.id));
});

test('read groups update quietly through additional likes and unlike/re-like on the same Korean day', async () => {
  const post = await publish('author');
  await like(post.id, 'colleague');
  const { notifications: [group] } = await json(inbox, 'author');
  const { comment: reply } = await comment(post.id, 'reader');
  await json(inbox, 'reader', { id: group.id });
  assert.deepEqual(await summary('author'), { unreadCount: 2 });
  await json(inbox, 'author', { id: group.id });
  await json(inbox, 'author', { id: group.id });
  assert.deepEqual(await summary('author'), { unreadCount: 1 });
  await like(post.id, 'colleague', false);
  assert.deepEqual((await json(inbox, 'author')).notifications.map(item => item.id), [reply.id]);
  await like(post.id, 'colleague');
  await like(post.id, 'reader');
  const updated = await json(inbox, 'author');
  assert.equal(updated.unreadCount, 1);
  assert.equal(updated.notifications.length, 2);
  const groupAfterRead = updated.notifications.find(item => item.kind === 'like');
  assert.equal(groupAfterRead.id, group.id);
  assert.equal(groupAfterRead.likeCount, 2);
  assert.equal(groupAfterRead.read, true);
  assert.equal(updated.notifications.find(item => item.kind === 'comment').read, false);
});

test('legacy reaction toggles and current likes share a single notification contribution per person', async () => {
  const post = await publish('author');
  const toggle = reaction => json('/api/board', 'reader', { action: 'react', postId: post.id, reaction });
  await toggle('laugh');
  const { notifications: [first] } = await json(inbox, 'author');
  assert.equal(first.likeCount, 1);
  await toggle('cheer');
  await toggle('laugh');
  const remaining = await json(inbox, 'author');
  assert.deepEqual(remaining.notifications.map(item => [item.id, item.likeCount]), [[first.id, 1]]);
  await like(post.id, 'reader', false);
  assert.deepEqual(await json(inbox, 'author'), { notifications: [], unreadCount: 0 });

  await like(post.id, 'reader');
  await toggle('same');
  assert.deepEqual(await json(inbox, 'author'), { notifications: [], unreadCount: 0 });
});

test('an unread group spans days; a like after its read day starts a separate group', async () => {
  const post = await publish('author');
  await like(post.id, 'colleague');
  const { notifications: [group] } = await json(inbox, 'author');
  const day = 86400000;
  const offset = 9 * 3600000;
  const midnight = Math.floor((Date.now() + offset) / day) * day - offset;
  await db.prepare('UPDATE community_like_notifications SET created_at = ? WHERE id = ?').bind(midnight - 10, group.id).run();
  await like(post.id, 'reader');
  const carried = await json(inbox, 'author');
  assert.deepEqual(carried.notifications.map(item => [item.id, item.likeCount, item.read]), [[group.id, 2, false]]);

  await json(inbox, 'author', { id: group.id });
  await db.prepare('UPDATE community_like_notifications SET created_at = ?, read_at = ? WHERE id = ?')
    .bind(midnight - 10, midnight - 1, group.id).run();
  await like(post.id, 'third-reader');
  const nextDay = await json(inbox, 'author');
  assert.equal(nextDay.unreadCount, 1);
  assert.deepEqual(nextDay.notifications.map(item => [item.likeCount, item.read]), [[1, false], [2, true]]);
  assert.notEqual(nextDay.notifications[0].id, group.id);
  assert.equal(nextDay.notifications[1].id, group.id);
});

test('mark-all and post deletion cover both kinds while preserving another author’s unread group', async () => {
  const first = await publish('author');
  const other = await publish('reader');
  await like(first.id, 'colleague');
  await comment(first.id, 'colleague');
  await like(other.id, 'colleague');
  await json(inbox, 'author', { all: true });
  const marked = await json(inbox, 'author');
  assert.equal(marked.unreadCount, 0);
  assert.deepEqual(marked.notifications.map(item => item.read), [true, true]);
  assert.deepEqual(await summary('reader'), { unreadCount: 1 });
  await json('/api/board', 'author', { action: 'delete', postId: first.id });
  assert.deepEqual(await json(inbox, 'author'), { notifications: [], unreadCount: 0 });
  assert.deepEqual(await summary('reader'), { unreadCount: 1 });
});

test('migration and retries do not turn historical active reactions into new notifications', async () => {
  const post = await publish('author');
  await db.prepare("INSERT INTO community_reactions (post_id, owner_id, reaction, active) VALUES (?, 'reader', 'cheer', 1)")
    .bind(post.id).run();
  const migration = readFileSync(new URL('migrations/0014_community_like_notifications.sql', root), 'utf8');
  await db.batch(splitSqlQuery(migration).map(sql => db.prepare(sql)));
  await like(post.id, 'reader');
  assert.deepEqual(await json(inbox, 'author'), { notifications: [], unreadCount: 0 });
  await like(post.id, 'reader', false);
  await like(post.id, 'reader');
  const { notifications: [group], unreadCount } = await json(inbox, 'author');
  assert.equal(unreadCount, 1);
  assert.equal(group.likeCount, 1);
});

test('if recording the liker fails, both the reaction and the group creation roll back', async () => {
  const post = await publish('author');
  await db.prepare(`CREATE TRIGGER test_block_like BEFORE INSERT ON community_like_notification_members
    BEGIN SELECT RAISE(ABORT, 'test like notification failure'); END`).run();
  try {
    const response = await request('/api/board', 'reader', { action: 'like', postId: post.id, liked: true });
    assert.equal(response.status, 503);
    assert.equal((await json('/api/board?id=' + post.id, 'reader')).post.likeCount, 0);
    assert.equal(await db.prepare('SELECT COUNT(*) AS n FROM community_like_notifications WHERE post_id = ?').bind(post.id).first('n'), 0);
  } finally {
    await db.prepare('DROP TRIGGER test_block_like').run();
  }
});

test('inbox and unread count only include posts the author can still open', async () => {
  const post = await publish('author');
  await comment(post.id, 'colleague');
  await like(post.id, 'colleague');
  const expectAvailability = async available => {
    const inboxData = await json(inbox, 'author');
    assert.deepEqual(inboxData.notifications.map(item => item.kind).sort(), available ? ['comment', 'like'] : []);
    assert.ok(inboxData.notifications.every(item => item.postId === post.id));
    assert.equal(inboxData.unreadCount, available ? 2 : 0);
    assert.deepEqual(await summary('author'), { unreadCount: available ? 2 : 0 });
  };

  await expectAvailability(true);
  await db.prepare("UPDATE community_posts SET status = 'hidden' WHERE id = ?").bind(post.id).run();
  await expectAvailability(false);
  const channelId = randomUUID();
  await db.prepare("UPDATE community_posts SET status = 'published', channel_id = ? WHERE id = ?").bind(channelId, post.id).run();
  await expectAvailability(false);
  await db.prepare(`INSERT INTO community_channels (id, owner_id, name, normalized_name, description, rules, status, created_at)
    VALUES (?, 'author', '퇴근 모임', '퇴근모임', '동료와 만나요', '예의를 지켜요', 'pending', ?)`).bind(channelId, Date.now()).run();
  await expectAvailability(false);
  await db.prepare("UPDATE community_channels SET status = 'active' WHERE id = ?").bind(channelId).run();
  await expectAvailability(true);
});
