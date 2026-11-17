import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { stripTypeScriptTypes } from 'node:module';

const directory = mkdtempSync(join(tmpdir(), 'workfolio-channels-'));
const files = {
  domain: 'src/lib/community/domain.ts', 'community-channels': 'functions/_lib/community-channels.ts',
  'community-views': 'functions/_lib/community-views.ts', 'community-images': 'functions/_lib/community-images.ts',
  board: 'functions/api/board.ts', channels: 'functions/api/channels.ts', views: 'functions/api/views.ts',
};
for (const [name, file] of Object.entries(files)) {
  let source = stripTypeScriptTypes(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'));
  source = source.replace(/import \{ getCommunityIdentity[^\n]+community-auth['"];?/, 'const getCommunityIdentity = globalThis.__channelTestIdentity;');
  source = source.replace(/(['"])(?:\.\.\/|\.\/)[^'"]*\/(domain|community-channels|community-views|community-images)\1/g, "'./$2.mjs'")
    .replace(/(['"])\.\/(community-channels)\1/g, "'./$2.mjs'");
  writeFileSync(join(directory, `${name}.mjs`), source);
}
globalThis.__channelTestIdentity = async request => {
  const cookie = request.headers.get('Cookie') || '';
  return /(?:^|;\s*)session=(owner|visitor|moderator|outsider)(?:;|$)/.exec(cookie)?.[1] || null;
};
const board = await import(pathToFileURL(join(directory, 'board.mjs')));
const channels = await import(pathToFileURL(join(directory, 'channels.mjs')));
const views = await import(pathToFileURL(join(directory, 'views.mjs')));
const images = await import(pathToFileURL(join(directory, 'community-images.mjs')));
const channelLib = await import(pathToFileURL(join(directory, 'community-channels.mjs')));
let sqlite, env, nextBatch;
// Serialized SQLite adapter preserves D1 batch transaction boundaries under concurrent HTTP requests.
function adapter(connection) {
  let queue = Promise.resolve();
  function schedule(fn) { const job = queue.then(fn); queue = job.catch(() => {}); return job; }
  function prepare(sql, bindings = []) {
    const execute = mode => {
      const statement = connection.prepare(sql);
      if (mode === 'first') return statement.get(...bindings) || null;
      if (mode === 'all') return { results: statement.all(...bindings) };
      return { success: true, meta: { changes: Number(statement.run(...bindings).changes) } };
    };
    return { bind: (...args) => prepare(sql, args), first: () => schedule(() => execute('first')), all: () => schedule(() => execute('all')), run: () => schedule(() => execute('run')), execute };
  }
  return { prepare, batch: statements => schedule(() => {
    const before = nextBatch; nextBatch = null; before?.();
    connection.exec('BEGIN');
    try { const result = statements.map(statement => statement.execute('run')); connection.exec('COMMIT'); return result; }
    catch (error) { connection.exec('ROLLBACK'); throw error; }
  }) };
}
beforeEach(() => {
  sqlite?.close(); sqlite = new DatabaseSync(':memory:'); nextBatch = null;
  for (const name of ['0005_community_auth.sql', '0006_community_board.sql', '0009_community_company_verification.sql', '0010_community_post_company.sql', '0011_community_admin_author.sql', '0012_community_post_images.sql', '0015_community_boards_channels_views.sql']) sqlite.exec(readFileSync(new URL(`../migrations/${name}`, import.meta.url), 'utf8'));
  env = { DB: adapter(sqlite), COMMUNITY_MODERATOR_USER_IDS: 'moderator', COMMUNITY_IMAGES: { async get() { return { body: 'image', httpEtag: '"image"', writeHttpMetadata(headers) { headers.set('Content-Type', 'image/png'); } }; } } };
});
after(() => { sqlite.close(); rmSync(directory, { recursive: true, force: true }); delete globalThis.__channelTestIdentity; });
function req(path, user, data, cookie = '', extra = {}) {
  return new Request(`https://board.example/api/${path}`, { method: data ? 'POST' : 'GET', headers: {
    ...(data ? { origin: 'https://board.example', 'Content-Type': 'application/json' } : {}),
    Cookie: [user ? `session=${user}` : '', cookie].filter(Boolean).join('; '), ...extra,
  }, ...(data ? { body: JSON.stringify(data) } : {}) });
}
function mutate(data, user = 'owner') { return channels.onRequestPost({ env, request: req('channels', user, data) }); }
function read(query = '', user = 'owner') { return channels.onRequestGet({ env, request: req(`channels${query}`, user) }); }
function writePost(data, user = 'owner') { return board.onRequestPost({ env, request: req('board', user, data) }); }
function postRead(id, user = null) { return board.onRequestGet({ env, request: req(`board?id=${id}`, user) }); }
function view(id, user = null, cookie = '', extra = {}) { return views.onRequestPost({ env, request: req('views', user, { postId: id }, cookie, extra) }); }
const application = { action: 'request', name: '동료의 휴게실', description: '잠깐 쉬면서 함께 이런저런 이야기를 나누어요.', rules: '개인정보는 올리지 말고 서로를 존중하며 이야기해요.', originalConfirmed: true };
const draft = { action: 'create', title: '오늘의 이야기', body: '오늘 있었던 일을 편하게 이야기하고 싶어요.', category: '월급루팡' };
async function apply(name = application.name, user = 'owner') { const result = await mutate({ ...application, name }, user); assert.equal(result.status, 201); return (await result.json()).channel; }
async function active(name = application.name, user = 'owner') { const row = await apply(name, user); assert.equal((await mutate({ action: 'approve', channelId: row.id }, 'moderator')).status, 200); return row; }
async function post(channelId, user = 'visitor', extra = {}) { const result = await writePost({ ...draft, ...(channelId ? { channelId, channelModerationConfirmed: true } : {}), ...extra }, user); assert.equal(result.status, 201); return (await result.json()).post; }
const note = '운영 규칙에 따라 확인했어요.';

test('authentication and allowlist fail closed; forged roles, company badges, and ownership grant no approval', async () => {
  assert.equal((await mutate(application, null)).status, 401);
  const row = await apply();
  assert.equal((await read('?review=1', 'owner')).status, 403);
  assert.equal((await mutate({ action: 'approve', channelId: row.id, role: 'admin', isAdminAuthor: true, ownerId: 'moderator' })).status, 403);
  assert.equal((await mutate({ action: 'approve', channelId: row.id }, 'outsider')).status, 403);
  assert.equal(channelLib.isCommunityModerator({}, 'moderator'), false);
  assert.equal(channelLib.isCommunityModerator({ COMMUNITY_MODERATOR_USER_IDS: 'other-moderator' }, 'moderator'), false);
  assert.equal(channelLib.isCommunityModerator({ COMMUNITY_MODERATOR_USER_IDS: 'moderator, other' }, 'moderator'), true);
  assert.equal((await read('', null)).status, 200);
  assert.equal((await (await read('', null)).json()).channels.length, 0);
  assert.doesNotMatch(JSON.stringify(await (await read('?mine=1')).json()), /owner_id|reviewed_by/);
  const own = await apply('플랫폼 동료 모임', 'moderator');
  assert.equal((await mutate({ action: 'approve', channelId: own.id }, 'moderator')).status, 200);
  assert.equal(sqlite.prepare('SELECT actor_id,applicant_id FROM community_channel_audit WHERE action=?').get('approve').actor_id, 'moderator');
});

test('channel normalization, reserved names, consent, pending cap and active cap are atomic', async () => {
  for (const name of ['월급 루팡', '퇴사각_상담소', 'workfolio', 'ＡＤＭＩＮ', '공식 동료', 'bad\u200bname']) assert.equal((await mutate({ ...application, name })).status, 400);
  sqlite.exec('DELETE FROM community_channel_limits');
  assert.equal((await mutate({ ...application, originalConfirmed: false })).status, 400);
  // Reset validation attempts so the remaining checks concern caps, not rate limiting.
  sqlite.exec('DELETE FROM community_channel_limits');
  const results = await Promise.all([mutate({ ...application, name: '개발 동료들' }), mutate({ ...application, name: '디자인 동료들' })]);
  assert.deepEqual(results.map(result => result.status).sort(), [201,409]);
  const pending = sqlite.prepare("SELECT id FROM community_channels WHERE status='pending'").get();
  assert.equal((await mutate({ action: 'approve', channelId: pending.id }, 'moderator')).status, 200);
  await active('두 번째 휴게실'); await active('세 번째 휴게실');
  assert.equal((await mutate({ ...application, name: '네 번째 휴게실' })).status, 409);
  const duplicate = await Promise.all([mutate({ ...application, name: '새 채널' }, 'visitor'), mutate({ ...application, name: '새_채널' }, 'outsider')]);
  assert.deepEqual(duplicate.map(result => result.status).sort(), [201,409]);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM community_channels WHERE owner_id='owner' AND status='active'").get().n, 3);
});

test('approve/reject are transactional, audited, race-safe and cannot silently overwrite a review', async () => {
  const row = await apply();
  const result = await Promise.all([mutate({ action: 'approve', channelId: row.id }, 'moderator'), mutate({ action: 'reject', channelId: row.id, note }, 'moderator')]);
  assert.deepEqual(result.map(response => response.status).sort(), [200,409]);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM community_channel_audit WHERE action IN ('approve','reject')").get().n, 1);
  const other = await apply('실패 확인 채널', 'visitor');
  sqlite.exec("CREATE TRIGGER fail_audit BEFORE INSERT ON community_channel_audit BEGIN SELECT RAISE(ABORT,'test'); END;");
  assert.equal((await mutate({ action: 'approve', channelId: other.id }, 'moderator')).status, 503);
  assert.equal(sqlite.prepare('SELECT status FROM community_channels WHERE id=?').get(other.id).status, 'pending');
});

test('channel posts require active channels and explicit moderation consent; feed filtering preserves company/image rules', async () => {
  const row = await apply();
  assert.equal((await writePost({ ...draft, channelId: row.id, channelModerationConfirmed: true })).status, 403);
  assert.equal((await mutate({ action: 'approve', channelId: row.id }, 'moderator')).status, 200);
  assert.equal((await writePost({ ...draft, channelId: row.id })).status, 400);
  const item = await post(row.id); await post(null);
  const feed = await board.onRequestGet({ env, request: req(`board?channel=${row.id}`, null) });
  const body = await feed.json(); assert.deepEqual(body.posts.map(value => value.id), [item.id]);
  assert.equal(body.posts[0].channelName, row.name); assert.equal(body.posts[0].viewCount, 0);
  assert.equal((await read(`?manage=${row.id}`, 'outsider')).status, 403);
});

test('reports remain platform-private unless explicitly shared; channel dismiss does not dismiss platform review', async () => {
  const row = await active(), item = await post(row.id);
  await writePost({ action: 'report', postId: item.id, reason: '플랫폼만 확인해 주세요.' }, 'visitor');
  await writePost({ action: 'report', postId: item.id, reason: '채널에도 공유해 주세요.', shareWithChannel: true }, 'outsider');
  const own = await (await read(`?manage=${row.id}`)).json();
  assert.equal(own.reports.length, 1); assert.equal(own.reports[0].reason, '채널에도 공유해 주세요.');
  assert.doesNotMatch(JSON.stringify(own.reports), /owner_id|outsider|visitor/);
  assert.equal((await (await read(`?manage=${row.id}`, 'moderator')).json()).reports.length, 2);
  assert.equal((await mutate({ action: 'dismiss', channelId: row.id, postId: item.id, note })).status, 200);
  assert.equal((await (await read(`?manage=${row.id}`)).json()).reports.length, 0);
  assert.equal((await (await read(`?manage=${row.id}`, 'moderator')).json()).reports.length, 2);
  await writePost({ action: 'report', postId: item.id, reason: '다시 확인해 주세요.', shareWithChannel: true }, 'outsider');
  assert.equal((await (await read(`?manage=${row.id}`)).json()).reports.length, 1);
});

test('channel hiding blocks detail, comments, reactions, views and images; platform-hidden content never reaches owner management', async () => {
  const row = await active(), item = await post(row.id), imageId = crypto.randomUUID();
  sqlite.prepare("INSERT INTO community_post_images (id,owner_id,object_key,post_id,status,content_type,byte_size,width,height,created_at,expires_at) VALUES (?,?,?,?,'attached','image/png',100,1,1,?,?)").run(imageId, 'visitor', imageId, item.id, Date.now(), Date.now() + 86400000);
  const imageRequest = () => images.serveImage(req('image', null), env, imageId);
  assert.equal((await imageRequest()).status, 200);
  const action = type => ({ action: type, channelId: row.id, postId: item.id, note });
  assert.equal((await mutate(action('hide'), 'outsider')).status, 403);
  assert.equal((await mutate(action('hide'))).status, 200);
  assert.equal((await mutate(action('hide'))).status, 409);
  assert.equal((await postRead(item.id)).status, 404);
  for (const action of ['comment','react','report']) assert.equal((await writePost({ action, postId: item.id, body: '댓글을 다시 남겨요.', reaction: 'same', reason: note })).status, 404);
  assert.equal((await view(item.id)).status, 404);
  await assert.rejects(imageRequest, error => error.status === 404);
  assert.equal((await mutate(action('restore'))).status, 200);
  assert.equal((await imageRequest()).status, 200);
  assert.equal((await mutate(action('hide'), 'moderator')).status, 200);
  assert.equal((await mutate(action('restore'))).status, 403);
  assert.equal((await (await read(`?manage=${row.id}`)).json()).posts.length, 0);
  assert.equal((await (await read(`?manage=${row.id}`, 'moderator')).json()).posts.length, 1);
  assert.equal((await mutate(action('restore'), 'moderator')).status, 200);
});

test('GET never counts; anonymous cookie issuance and forged tokens never count until a valid retry', async () => {
  const item = await post(null);
  assert.equal((await postRead(item.id)).status, 200);
  assert.equal((await views.onRequestGet({})).status, 405);
  const first = await view(item.id); assert.deepEqual(await first.json(), { viewCount: 0, counted: false, retry: true });
  const cookie = first.headers.get('Set-Cookie').split(';')[0];
  assert.match(first.headers.get('Set-Cookie'), /HttpOnly; Secure; SameSite=Lax/);
  const second = await view(item.id, null, cookie); assert.deepEqual(await second.json(), { viewCount: 1, counted: true, retry: false });
  assert.equal((await (await view(item.id, null, cookie)).json()).counted, false);
  const forged = await view(item.id, null, '__Host-community_viewer=' + 'a'.repeat(43));
  assert.deepEqual(await forged.json(), { viewCount: 1, counted: false, retry: true });
  assert.equal((await view(item.id, null, cookie, { origin: 'https://evil.example' })).status, 403);
});

test('account and issued browser receipts bridge login/logout, deduplicate concurrent retries and expire after 24h', async () => {
  const item = await post(null);
  const issued = await view(item.id); const cookie = issued.headers.get('Set-Cookie').split(';')[0];
  assert.equal((await (await view(item.id, null, cookie)).json()).counted, true);
  assert.equal((await (await view(item.id, 'owner', cookie)).json()).counted, false);
  assert.equal((await (await view(item.id, 'owner')).json()).counted, false);
  const second = await post(null);
  assert.equal((await (await view(second.id, 'owner', cookie)).json()).counted, true);
  assert.equal((await (await view(second.id, null, cookie)).json()).counted, false);
  const third = await post(null);
  const responses = await Promise.all(Array.from({ length: 20 }, () => view(third.id, 'owner')));
  const results = await Promise.all(responses.map(response => response.json()));
  assert.equal(results.filter(value => value.counted).length, 1);
  assert.equal(sqlite.prepare('SELECT view_count FROM community_posts WHERE id=?').get(third.id).view_count, 1);
  sqlite.prepare('UPDATE community_view_receipts SET counted_at=? WHERE post_id=?').run(Date.now() - 86400001, third.id);
  assert.equal((await (await view(third.id, 'owner')).json()).counted, true);
  assert.equal((await (await view(third.id, 'visitor')).json()).counted, false);
  const receipts = JSON.stringify(sqlite.prepare('SELECT * FROM community_view_receipts').all());
  assert.doesNotMatch(receipts, /owner|visitor-session|192\.0\./);
});

test('view rate limits are global and account bound; failed increments roll back receipt claims', async () => {
  const item = await post(null);
  sqlite.prepare('INSERT INTO community_view_limits VALUES (?,?,?)').run('global:requests', Date.now(), 20000);
  assert.equal((await view(item.id, 'owner')).status, 429);
  assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM community_view_receipts').get().n, 0);
  sqlite.exec('DELETE FROM community_view_limits');
  sqlite.exec("CREATE TRIGGER fail_increment BEFORE UPDATE OF view_count ON community_posts BEGIN SELECT RAISE(ABORT,'test'); END;");
  assert.equal((await view(item.id, 'owner')).status, 503);
  assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM community_view_receipts').get().n, 0);
  assert.equal(sqlite.prepare('SELECT view_count FROM community_posts').get().view_count, 0);
});

test('a concurrent platform hide wins over a channel owner and cannot be undone by a stale moderation read', async () => {
  const row = await active(), item = await post(row.id);
  nextBatch = () => sqlite.prepare("UPDATE community_posts SET status='hidden',hidden_by_scope='platform' WHERE id=?").run(item.id);
  const result = await mutate({action:'hide',channelId:row.id,postId:item.id,note});
  assert.equal(result.status,409);
  assert.equal(sqlite.prepare('SELECT hidden_by_scope FROM community_posts WHERE id=?').get(item.id).hidden_by_scope,'platform');
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM community_channel_audit WHERE action='hide'").get().n,0);
});

test('a post hidden between view eligibility and its transaction receives no receipt or increment', async () => {
  const row = await active(), item = await post(row.id);
  nextBatch = () => sqlite.prepare("UPDATE community_posts SET status='hidden',hidden_by_scope='platform' WHERE id=?").run(item.id);
  assert.equal((await view(item.id,'owner')).status,404);
  assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM community_view_receipts').get().n,0);
  assert.equal(sqlite.prepare('SELECT view_count FROM community_posts WHERE id=?').get(item.id).view_count,0);
});

test('issued-cookie rate caps reject cookie churn without creating visitor rows', async () => {
  const item = await post(null);
  sqlite.prepare('INSERT INTO community_view_limits VALUES (?,?,?)').run('global:issuance',Date.now(),5000);
  assert.equal((await view(item.id)).status,429);
  assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM community_view_visitors').get().n,0);
  assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM community_view_receipts').get().n,0);
});
