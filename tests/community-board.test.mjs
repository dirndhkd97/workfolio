// Executes the actual route against SQLite with a small D1 adapter. No production credentials.
import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { stripTypeScriptTypes } from 'node:module';
const directory = mkdtempSync(join(tmpdir(), 'workfoilo-api-'));
const root = new URL('../', import.meta.url);
const compile = (path, filename, rewrite = (value) => value) => {
  const source = readFileSync(new URL(path, root), 'utf8');
  const compiled = stripTypeScriptTypes(source);
  writeFileSync(join(directory,filename),rewrite(compiled));
};
compile('src/lib/community/domain.ts','domain.mjs');
compile('src/lib/community/sample-posts.ts','sample-posts.mjs');
compile('functions/api/board.ts','route.mjs',value => value
  .replace(/import \{ getCommunityIdentity[^\n]+community-auth";/, 'const getCommunityIdentity = globalThis.__communityIdentityForTest;')
  .replace('"../../src/lib/community/domain"','"./domain.mjs"')
  .replace('"../../src/lib/community/sample-posts"','"./sample-posts.mjs"'));
const env = {};
const testSessions = new Map([['owner-session','owner'],['visitor-session','visitor']]);
// The real auth helper has its own tests; this stub only grants configured session cookies.
globalThis.__communityIdentityForTest = async (request) => {
  const token = /(?:^|;\s*)mock_community_session=([^;]+)/.exec(request.headers.get('Cookie') || '')?.[1];
  return testSessions.get(token) ?? null;
};
const {onRequestGet,onRequestPost} = await import(pathToFileURL(join(directory,'route.mjs')).href);
let sqlite;
function adapter(connection) {
  function prepare(sql, bindings = []) {
    return {
      bind(...args) { return prepare(sql,args); },
      async first() { return connection.prepare(sql).get(...bindings) || null; },
      async all() { return {results:connection.prepare(sql).all(...bindings)}; },
      async run() { const result = connection.prepare(sql).run(...bindings); return {success:true,meta:{changes:Number(result.changes)}}; },
    };
  }
  return {prepare,async batch(statements) {
    connection.exec('BEGIN');
    try { const results = []; for (const statement of statements) results.push(await statement.run()); connection.exec('COMMIT'); return results; }
    catch(error) { connection.exec('ROLLBACK'); throw error; }
  }};
}
beforeEach(() => {
  sqlite?.close(); sqlite = new DatabaseSync(':memory:');
  for (const file of ['0005_community_auth.sql', '0006_community_board.sql', '0009_community_company_verification.sql', '0010_community_post_company.sql']) {
    sqlite.exec(readFileSync(new URL(`migrations/${file}`,root),'utf8'));
  }
  sqlite.exec("CREATE TABLE customers (id INTEGER PRIMARY KEY, email TEXT); INSERT INTO customers VALUES (1, 'existing@example.test');");
  env.DB = adapter(sqlite);
});
after(() => { sqlite?.close(); rmSync(directory,{recursive:true,force:true}); delete globalThis.__communityIdentityForTest; });
const draft = {action:'create',title:'오늘의 작은 이야기',body:'동료가 남겨 준 작은 메모 덕분에 웃으며 퇴근했어요.',category:'회사 사람들',nickname:'책상 옆 동료'};
async function mutate(data,user='owner',extraHeaders={}) {
  const headers = {'content-type':'application/json',origin:'https://board.example', ...extraHeaders};
  if (user) headers.Cookie = `mock_community_session=${user}-session`;
  return onRequestPost({env,request:new Request('https://board.example/api/board',{method:'POST',headers,body:JSON.stringify(data)})});
}
async function list(user='owner',id='') {
  return onRequestGet({env,request:new Request('https://board.example/api/board'+(id?'?id='+id:''),{headers:user?{Cookie:`mock_community_session=${user}-session`}:{}})});
}
async function create() { const response = await mutate(draft); assert.equal(response.status,201); return (await response.json()).post; }
test('sample feed is explicitly fictional with zero counters and read-only anonymous identity',async () => {
  const response = await list(null); const data = await response.json();
  assert.equal(data.signedIn,false); assert.equal(data.posts.length,6);
  assert.ok(data.posts.every(post => post.sample && !post.mine && post.commentCount===0 && Object.values(post.reactions).every(count=>count===0)));
  assert.equal((await mutate(draft,null)).status,401);
  assert.equal(response.headers.get('cache-control'),'private, no-store');
});
test('anonymous visitors can read lists and details but every write requires login without changing stored data',async () => {
  const post = await create();
  assert.equal((await mutate({action:'comment',postId:post.id,body:'비회원에게도 보이는 댓글이에요.'})).status,201);
  assert.equal((await mutate({action:'react',postId:post.id,reaction:'same'})).status,200);
  assert.equal((await mutate({action:'report',postId:post.id,reason:'확인 요청입니다.'})).status,200);

  const feedResponse = await list(null);
  assert.equal(feedResponse.status,200);
  const feed = await feedResponse.json();
  assert.equal(feed.signedIn,false);
  const listedPost = feed.posts.find(item => item.id === post.id);
  assert.equal(listedPost.title,draft.title);
  assert.equal(listedPost.mine,false);
  assert.deepEqual(listedPost.myReactions,[]);

  const detailResponse = await list(null,post.id);
  assert.equal(detailResponse.status,200);
  const detail = await detailResponse.json();
  assert.equal(detail.signedIn,false);
  assert.equal(detail.post.body,draft.body);
  assert.equal(detail.post.mine,false);
  assert.deepEqual(detail.post.myReactions,[]);
  assert.equal(detail.post.reactions.same,1);
  assert.equal(detail.comments[0].body,'비회원에게도 보이는 댓글이에요.');
  assert.equal('reports' in detail,false);

  const snapshot = () => Object.fromEntries(['community_posts','community_comments','community_reactions','community_reports'].map(table => [table,sqlite.prepare(`SELECT * FROM ${table}`).all()]));
  const before = snapshot();
  for (const action of [
    draft,
    {action:'comment',postId:post.id,body:'로그인 없이 남기는 댓글'},
    {action:'react',postId:post.id,reaction:'same'},
    {action:'report',postId:post.id,reason:'로그인 없이 신고하기'},
    {action:'delete',postId:post.id},
  ]) {
    const response = await mutate(action,null);
    assert.equal(response.status,401,`anonymous ${action.action} must require login`);
    assert.equal(typeof (await response.json()).error,'string');
    assert.deepEqual(snapshot(),before,`anonymous ${action.action} must not change stored data`);
  }
});
test('create and read persist text without exposing raw identity or other users ownership',async () => {
  const post = await create(); assert.equal(post.mine,true); assert.equal(post.sample,false);
  const own = await (await list('owner',post.id)).json();
  const other = await (await list('visitor',post.id)).json();
  assert.equal(own.post.mine,true); assert.equal(other.post.mine,false); assert.deepEqual(own.comments,[]);
  assert.equal(JSON.stringify(own).includes('owner_id'),false);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM community_posts').get().n,1);
});
test('reaction toggle is per user and kind, with accurate active counts',async () => {
  const post = await create();
  for (const user of ['owner','visitor']) assert.equal((await mutate({action:'react',postId:post.id,reaction:'same'},user)).status,200);
  let result = await (await list('owner',post.id)).json(); assert.equal(result.post.reactions.same,2); assert.deepEqual(result.post.myReactions,['same']);
  result = await (await mutate({action:'react',postId:post.id,reaction:'same'})).json(); assert.equal(result.post.reactions.same,1); assert.deepEqual(result.post.myReactions,[]);
  assert.equal((await mutate({action:'react',postId:post.id,reaction:'invalid'})).status,400);
});
test('comments and private reports persist, and reporting twice updates instead of duplicating',async () => {
  const post = await create();
  const response = await mutate({action:'comment',postId:post.id,body:'이런 동료가 있으면 참 든든하죠.'},'visitor');
  assert.equal(response.status,201); const {comment} = await response.json(); assert.equal(comment.nickname,'익명의 동료'); assert.equal('ownerId' in comment,false);
  for (const reason of ['개인 정보가 포함되어 있어요.','내용을 다시 확인해 주세요.']) assert.equal((await mutate({action:'report',postId:post.id,reason},'visitor')).status,200);
  const details = await (await list('owner',post.id)).json(); assert.equal(details.post.commentCount,1); assert.equal(details.comments.length,1); assert.equal('reports' in details,false);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM community_reports').get().n,1);
});
test('only the author can delete; deletion removes associated records atomically',async () => {
  const post = await create();
  await mutate({action:'comment',postId:post.id,body:'좋은 이야기예요.'});
  await mutate({action:'react',postId:post.id,reaction:'cheer'});
  await mutate({action:'report',postId:post.id,reason:'확인 요청입니다.'});
  assert.equal((await mutate({action:'delete',postId:post.id},'visitor')).status,403);
  assert.equal((await mutate({action:'delete',postId:'sample-01'})).status,403);
  assert.equal((await mutate({action:'delete',postId:post.id})).status,200);
  for (const table of ['community_posts','community_comments','community_reactions','community_reports']) assert.equal(sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n,0);
  assert.equal((await list('owner',post.id)).status,404);
  assert.equal((await mutate({action:'comment',postId:post.id,body:'삭제 후 댓글'})).status,404);
});
test('sample engagement is real stored engagement, and errors remain useful but private',async () => {
  assert.equal((await mutate({action:'comment',postId:'sample-01',body:'예시 상황이 재밌네요.'})).status,201);
  const {post} = await (await mutate({action:'react',postId:'sample-01',reaction:'laugh'})).json(); assert.equal(post.reactions.laugh,1); assert.equal(post.commentCount,1);
  assert.equal((await mutate({...draft,body:'개인 연락처는 person@example.com 입니다.'})).status,400);
  env.DB = undefined;
  const response = await list(); assert.equal(response.status,503); assert.equal(typeof (await response.json()).error,'string');
});

test('forged identity headers and unknown or legacy sessions grant no board identity',async () => {
  for (const extraHeaders of [
    {'oai-authenticated-user-id':'owner'},
    {'x-user-id':'owner',authorization:'Bearer owner'},
    {Cookie:'session=owner-session'},
    {Cookie:'mock_community_session=unknown-session'},
  ]) {
    assert.equal((await mutate(draft,null,extraHeaders)).status,401);
    const result = await onRequestGet({env,request:new Request('https://board.example/api/board',{headers:extraHeaders})});
    assert.equal((await result.json()).signedIn,false);
  }
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM community_posts').get().n,0);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM community_write_limits').get().n,0);
});

test('cross-origin, malformed and oversized mutation requests do not write posts',async () => {
  assert.equal((await mutate(draft,'owner',{origin:'https://evil.example'})).status,403);
  assert.equal((await mutate(draft,'owner',{'sec-fetch-site':'cross-site'})).status,403);
  assert.equal((await mutate(draft,'owner',{'content-type':'text/plain'})).status,415);
  assert.equal((await mutate({...draft,body:'가'.repeat(6000)})).status,413);
  assert.equal((await mutate({...draft,category:'없는 게시판'})).status,400);
  const request = new Request('https://board.example/api/board',{
    method:'POST',headers:{origin:'https://board.example','content-type':'application/json',Cookie:'mock_community_session=owner-session'},body:'{broken',
  });
  assert.equal((await onRequestPost({env,request})).status,400);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM community_posts').get().n,0);
});

test('write rate limits are account-scoped, atomic and reset after one minute',async () => {
  for (let attempt=0;attempt<30;attempt++) {
    assert.equal((await mutate({action:'react',postId:'sample-01',reaction:'same'})).status,200);
  }
  const blocked = await mutate(draft);
  assert.equal(blocked.status,429);
  assert.equal(blocked.headers.get('retry-after'),'60');
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM community_posts').get().n,0);
  assert.equal((await mutate(draft,'visitor')).status,201);
  sqlite.prepare('UPDATE community_write_limits SET window_started_at = ? WHERE owner_id = ?').run(Date.now()-61000,'owner');
  assert.equal((await mutate(draft)).status,201);
  assert.equal(sqlite.prepare('SELECT attempts FROM community_write_limits WHERE owner_id = ?').get('owner').attempts,1);
});

test('all six boards are accepted and community writes leave commerce data untouched',async () => {
  for (const category of ['웃픈 실수','황당한 순간','회사 사람들','소소한 일상','빡대가리 게시판','월급루팡']) {
    const response = await mutate({...draft,category});
    assert.equal(response.status,201);
    assert.equal((await response.json()).post.category,category);
  }
  assert.deepEqual({...sqlite.prepare('SELECT * FROM customers').get()},{id:1,email:'existing@example.test'});
});

function verifyCompany(user = 'owner', company = 'workfolio', expiresAt = Date.now() + 86400000) {
  sqlite.prepare('INSERT OR IGNORE INTO community_users (id, nickname, created_at) VALUES (?, ?, ?)').run(user, '테스트 동료', Date.now());
  sqlite.prepare('INSERT OR REPLACE INTO community_company_verifications (user_id, company_id, email_hash, verified_at, expires_at) VALUES (?, ?, ?, ?, ?)')
    .run(user, company, `private-email-hash-${user}`, Date.now(), expiresAt);
}

test('company disclosure is opt-in and never leaks a private company through list or detail responses', async () => {
  verifyCompany();
  for (const data of [draft, {...draft, shareCompany:false}, {...draft, companyName:'위조 회사', companyId:'workfolio'}]) {
    const response = await mutate(data);
    assert.equal(response.status,201);
    const post = (await response.json()).post;
    assert.equal(post.companyName,null);
    assert.equal(sqlite.prepare('SELECT company_name FROM community_posts WHERE id = ?').get(post.id).company_name,null);
    for (const user of [null,'owner','visitor']) {
      const serialized = await (await list(user,post.id)).text();
      assert.equal(JSON.parse(serialized).post.companyName,null);
      assert.doesNotMatch(serialized,/Workfolio|private-email-hash|company_id|email_hash|verified_at/);
    }
  }
  const feed = await (await list(null)).text();
  assert.doesNotMatch(feed,/Workfolio|private-email-hash|company_id|email_hash/);
  assert.ok(JSON.parse(feed).posts.every(post => post.companyName === null));
});

test('public company names come from current server verification and stay as a per-post snapshot', async () => {
  const earlierPrivate = await create();
  verifyCompany();
  const response = await mutate({...draft,shareCompany:true,companyName:'위조 회사',companyId:'forged'});
  assert.equal(response.status,201);
  const post = (await response.json()).post;
  assert.equal(post.companyName,'Workfolio');
  sqlite.prepare('INSERT INTO community_companies (id,name) VALUES (?,?)').run('next-company','다음 회사');
  verifyCompany('owner','next-company');
  const next = await mutate({...draft,shareCompany:true});
  assert.equal((await next.json()).post.companyName,'다음 회사');
  assert.equal((await (await list(null,post.id)).json()).post.companyName,'Workfolio');
  assert.equal((await (await list(null,earlierPrivate.id)).json()).post.companyName,null);
  sqlite.prepare('DELETE FROM community_company_verifications').run();
  assert.equal((await (await list(null,post.id)).json()).post.companyName,'Workfolio');
});

test('unverified, expired, and other-account company proofs cannot authorize a public company post', async () => {
  assert.equal((await mutate({...draft,shareCompany:true,companyName:'Workfolio'})).status,403);
  verifyCompany('visitor');
  assert.equal((await mutate({...draft,shareCompany:true})).status,403);
  verifyCompany('owner','workfolio',Date.now()-1);
  assert.equal((await mutate({...draft,shareCompany:true})).status,403);
  for (const shareCompany of ['true','false',1,null,{}]) {
    assert.equal((await mutate({...draft,shareCompany})).status,400);
  }
  assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM community_posts').get().n,0);
  assert.equal((await mutate({...draft,shareCompany:false})).status,201);
});
