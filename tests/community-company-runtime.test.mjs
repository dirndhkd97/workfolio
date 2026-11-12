import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Log, LogLevel, Miniflare } from 'miniflare';

// Run authentication, company proof, posts and D1 together in workerd. Mail never leaves the test.
const root = new URL('../', import.meta.url);
let runtime, db;
const token = 'a'.repeat(43);
const cookie = `__Host-community_session=${token}`;
const messages = [];
const outgoingFailures = [];
const draft = { action: 'create', title: '오늘의 회사 이야기', body: '동료가 전해 준 따뜻한 말 덕분에 기분 좋게 퇴근했어요.', category: '회사 사람들', nickname: '퇴근하는 동료' };

before(async () => {
  const bundled = await build({
    stdin: { contents: `
      import { companyMe, sendCompanyCode, verifyCompanyCode } from './functions/_lib/community-company.ts';
      import { onRequestGet, onRequestPost } from './functions/api/board.ts';
      export default { fetch(request, env) {
        const path = new URL(request.url).pathname;
        if (path === '/api/board') return request.method === 'POST' ? onRequestPost({request,env}) : onRequestGet({request,env});
        if (path.endsWith('/send-code')) return sendCompanyCode(request, env);
        if (path.endsWith('/verify-code')) return verifyCompanyCode(request, env);
        return companyMe(request, env);
      } };
    `, resolveDir: fileURLToPath(root), loader: 'ts' },
    bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022',
  });
  runtime = new Miniflare({
    modules: true, script: bundled.outputFiles[0].text, compatibilityDate: '2024-12-01',
    d1Databases: ['DB'], bindings: { MAILGUN_API_KEY: 'dummy-runtime-key' }, log: new Log(LogLevel.NONE),
    outboundService: async request => {
      if (request.url !== 'https://api.mailgun.net/v3/workfolio.life/messages' || request.method !== 'POST') {
        outgoingFailures.push(request.url);
        return new Response(null, { status: 500 });
      }
      messages.push(Object.fromEntries((await request.formData()).entries()));
      return Response.json({ id: 'mock-mail-delivery' });
    },
  });
  db = await runtime.getD1Database('DB');
  for (const file of ['0005_community_auth.sql', '0006_community_board.sql', '0007_community_kakao_events.sql', '0008_community_session_persistence.sql', '0009_community_company_verification.sql', '0010_community_post_company.sql', '0011_community_admin_author.sql']) {
    const statements = readFileSync(new URL(`migrations/${file}`, root), 'utf8').replace(/--[^\n]*/g, '').split(';').map(sql => sql.trim()).filter(Boolean);
    await db.batch(statements.map(sql => db.prepare(sql)));
  }
  const tokenHash = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))).toString('base64url');
  await db.batch([
    db.prepare('INSERT INTO community_users (id, nickname, created_at) VALUES (?, ?, ?)').bind('runtime-member', '퇴근하는 동료', Date.now()),
    db.prepare('INSERT INTO community_sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').bind(tokenHash, 'runtime-member', Date.now(), Date.now() + 3600000),
  ]);
});
after(async () => { await runtime?.dispose(); });

function fetchRoute(path, body, signedIn = true) {
  return runtime.dispatchFetch(`https://workfolio.life${path}`, {
    redirect: 'manual',
    // Explicit Cookie headers supply identity; avoid Undici's 401 streamed-body retry.
    credentials: 'omit',
    method: body === undefined ? 'GET' : 'POST',
    headers: { ...(signedIn ? { Cookie: cookie } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json', Origin: 'https://workfolio.life' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

test('real D1 verifies company mailbox, enforces opt-in disclosure, and preserves private post snapshots', async () => {
  assert.equal((await fetchRoute('/api/community-company/me', undefined, false)).status, 401);
  assert.equal((await fetchRoute('/api/community-company/send-code', { email: 'member@workfolio.life' }, false)).status, 401);
  assert.equal((await fetchRoute('/api/board', { ...draft, shareCompany: true, companyName: '가짜 회사' })).status, 403);
  assert.equal((await fetchRoute('/api/community-company/send-code', { email: 'member@workfolio.life.evil.test' })).status, 400);
  assert.equal(messages.length, 0);

  const beforeProof = await fetchRoute('/api/board', { ...draft, companyName: '가짜 회사' });
  assert.equal(beforeProof.status, 201);
  const privateBefore = (await beforeProof.json()).post;
  assert.equal(privateBefore.companyName, null);
  assert.equal(privateBefore.isAdminAuthor, false);

  const sent = await fetchRoute('/api/community-company/send-code', { email: 'member@workfolio.life' });
  assert.equal(sent.status, 200);
  assert.deepEqual((await sent.json()).company, { id: 'workfolio', name: 'Workfolio' });
  assert.equal(messages.length, 1);
  const code = /인증코드: (\d{6})/.exec(messages[0].text)[1];
  const verified = await fetchRoute('/api/community-company/verify-code', { code, companyName: '가짜 회사', isAdmin: false, domain: 'evil.test' });
  assert.equal(verified.status, 200);
  const verifiedCompany = (await verified.json()).company;
  assert.equal(verifiedCompany.name, 'Workfolio');
  assert.equal(verifiedCompany.isAdmin, true);
  assert.equal((await db.prepare('SELECT domain FROM community_company_verifications WHERE user_id = ?').bind('runtime-member').first()).domain, 'workfolio.life');
  assert.equal((await fetchRoute('/api/community-company/verify-code', { code })).status, 400);
  assert.equal((await (await fetchRoute('/api/community-company/me')).json()).company.name, 'Workfolio');

  const published = await fetchRoute('/api/board', { ...draft, shareCompany: true, companyName: '가짜 회사', isAdminAuthor: false });
  assert.equal(published.status, 201);
  const publicPost = (await published.json()).post;
  assert.equal(publicPost.companyName, 'Workfolio');
  assert.equal(publicPost.isAdminAuthor, true);
  const hidden = await fetchRoute('/api/board', { ...draft, shareCompany: false, companyName: '가짜 회사', isAdminAuthor: true, role: 'admin' });
  assert.equal(hidden.status, 201);
  const privateAfter = (await hidden.json()).post;
  assert.equal(privateAfter.companyName, null);
  assert.equal(privateAfter.isAdminAuthor, false);

  const feed = await (await fetchRoute('/api/board', undefined, false)).json();
  for (const id of [privateBefore.id, privateAfter.id]) {
    assert.equal(feed.posts.find(post => post.id === id).companyName, null);
    assert.equal(feed.posts.find(post => post.id === id).isAdminAuthor, false);
    const detail = await (await fetchRoute(`/api/board?id=${id}`, undefined, false)).json();
    assert.equal(detail.post.companyName, null);
    assert.equal(detail.post.isAdminAuthor, false);
  }
  assert.equal(feed.posts.find(post => post.id === publicPost.id).companyName, 'Workfolio');
  assert.equal(feed.posts.find(post => post.id === publicPost.id).isAdminAuthor, true);
  assert.ok(feed.posts.filter(post => post.sample).every(post => post.isAdminAuthor === false));
  assert.equal(JSON.stringify(feed).includes('member@workfolio.life'), false);
  assert.equal(JSON.stringify(feed).includes('email_hash'), false);

  await db.prepare('UPDATE community_company_verifications SET expires_at = ?').bind(Date.now() - 1).run();
  assert.equal((await fetchRoute('/api/board', { ...draft, shareCompany: true })).status, 403);
  assert.deepEqual(await (await fetchRoute('/api/community-company/me')).json(), { company: null });
  assert.equal((await (await fetchRoute(`/api/board?id=${publicPost.id}`, undefined, false)).json()).post.companyName, 'Workfolio');
  assert.equal((await (await fetchRoute(`/api/board?id=${publicPost.id}`, undefined, false)).json()).post.isAdminAuthor, true);
  await db.prepare('UPDATE community_sessions SET expires_at = ?').bind(Date.now() - 1).run();
  assert.equal((await fetchRoute('/api/community-company/me')).status, 401);
  assert.equal((await fetchRoute('/api/board', draft)).status, 401);
  assert.deepEqual(outgoingFailures, []);
});
