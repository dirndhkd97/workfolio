import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';
import ts from 'typescript';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';

// Real SQLite transactions and RS256 signatures; network, user IDs and keys are test-only.
const root = new URL('../', import.meta.url);
mkdirSync(new URL('work/', root), { recursive: true });
const directory = mkdtempSync(join(fileURLToPath(new URL('work/', root)), 'kakao-events-tests-'));
for (const name of ['community-auth', 'kakao-events']) {
  writeFileSync(join(directory, `${name}.mjs`), ts.transpileModule(readFileSync(new URL(`functions/_lib/${name}.ts`, root), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText);
}
const { receiveKakaoEvent } = await import(pathToFileURL(join(directory, 'kakao-events.mjs')).href);
const auth = await import(pathToFileURL(join(directory, 'community-auth.mjs')).href);
const key = await generateKeyPair('RS256');
const wrongKey = await generateKeyPair('RS256');
const publicJwk = { ...await exportJWK(key.publicKey), kid: 'events-test-key', alg: 'RS256', use: 'sig' };
const issuer = 'https://kauth.kakao.com';
const unlink = 'https://schemas.openid.net/secevent/oauth/event-type/user-unlinked';
const originalFetch = globalThis.fetch;
let sqlite;
let env;
let networkCalls;

function adapter(connection) {
  function prepare(sql, args = []) {
    return {
      sql,
      bind(...bindings) { return prepare(sql, bindings); },
      async first() { return connection.prepare(sql).get(...args) || null; },
      async run() { const result = connection.prepare(sql).run(...args); return { success: true, meta: { changes: Number(result.changes) } }; },
    };
  }
  return { prepare, async batch(statements) {
    connection.exec('BEGIN');
    try { const results = []; for (const statement of statements) results.push(await statement.run()); connection.exec('COMMIT'); return results; }
    catch (error) { connection.exec('ROLLBACK'); throw error; }
  } };
}

beforeEach(() => {
  sqlite?.close();
  sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON');
  for (const file of ['0005_community_auth.sql', '0006_community_board.sql', '0007_community_kakao_events.sql']) {
    const schema = readFileSync(new URL(`migrations/${file}`, root), 'utf8');
    sqlite.exec(schema);
    sqlite.exec(schema); // Deployment applies only idempotent schema additions.
  }
  env = { DB: adapter(sqlite), KAKAO_CLIENT_ID: 'test-primary-rest-key', KAKAO_CLIENT_SECRET: 'test-client-secret' };
  networkCalls = [];
  globalThis.fetch = async (url) => {
    networkCalls.push(String(url));
    assert.equal(String(url), `${issuer}/.well-known/jwks.json`);
    return Response.json({ keys: [publicJwk] });
  };
});
after(() => { sqlite?.close(); globalThis.fetch = originalFetch; rmSync(directory, { recursive: true, force: true }); });

function seed(provider = 'kakao', subject = '12345', user = 'old-user', createdAt = Date.now() - 10000) {
  sqlite.prepare('INSERT INTO community_users VALUES (?, ?, ?)').run(user, '퇴근러테스트', createdAt);
  sqlite.prepare('INSERT INTO community_accounts VALUES (?, ?, ?, ?)').run(provider, subject, user, createdAt);
  sqlite.prepare('INSERT INTO community_sessions VALUES (?, ?, ?, ?)').run(`session-${user}`, user, createdAt, Date.now() + 60000);
}
function count(table) { return sqlite.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n; }
function eventBody(subject = '12345') { return { [unlink]: { subject: { subject_type: 'iss-sub', iss: issuer, sub: subject }, reason: 'UNLINK_FROM_APPS' } }; }
async function signed(changes = {}, signingKey = key.privateKey, header = {}) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ iss: issuer, aud: env.KAKAO_CLIENT_ID, sub: '12345', iat: now, toe: now, app_id: '123456', txm: crypto.randomUUID(), jti: crypto.randomUUID(), events: eventBody(), ...changes })
    .setProtectedHeader({ alg: 'RS256', typ: 'secevent+jwt', kid: 'events-test-key', ...header }).sign(signingKey);
}
function request(body, options = {}) {
  return new Request('https://workfolio.life/api/community-auth/kakao/events', { method: 'POST', headers: { 'Content-Type': 'application/secevent+jwt' }, body, ...options });
}
async function deliver(body) { return receiveKakaoEvent(request(body), env); }
async function startLogin() {
  const response = await auth.startCommunityOAuth(new Request('https://workfolio.life/api/community-auth/kakao'), env, 'kakao');
  assert.equal(response.status, 303);
  const state = new URL(response.headers.get('Location')).searchParams.get('state');
  const cookie = response.headers.getSetCookie()[0].split(';')[0];
  return new Request(`https://workfolio.life/api/community-auth/kakao/callback?code=test-code&state=${state}`, { headers: { Cookie: cookie } });
}
function mockLoginNetwork() {
  globalThis.fetch = async (url) => {
    if (String(url).endsWith('/jwks.json')) return Response.json({ keys: [publicJwk] });
    if (String(url).endsWith('/token')) return Response.json({ access_token: 'test-access-token', token_type: 'bearer' });
    assert.equal(String(url), 'https://kapi.kakao.com/v2/user/me');
    return Response.json({ id: 12345 });
  };
}

test('valid SET revokes every matched session and provider link, while preserving users and content', async () => {
  seed();
  seed('naver', '12345', 'naver-user');
  seed('kakao', '67890', 'other-kakao-user');
  sqlite.prepare('INSERT INTO community_sessions VALUES (?, ?, ?, ?)').run('second-session', 'old-user', Date.now(), Date.now() + 60000);
  sqlite.prepare('INSERT INTO community_posts VALUES (?, ?, ?, ?, ?, ?, ?)').run('post', 'old-user', 'title', 'body', 'free', '퇴근러테스트', Date.now());
  sqlite.prepare('INSERT INTO community_comments VALUES (?, ?, ?, ?, ?, ?)').run('comment', 'post', 'old-user', 'comment', '퇴근러테스트', Date.now());
  const response = await deliver(await signed());
  assert.equal(response.status, 202);
  assert.equal(await response.text(), '');
  assert.equal(count('community_sessions'), 2);
  assert.equal(count('community_accounts'), 2);
  assert.equal(count('community_users'), 3);
  assert.equal(count('community_posts'), 1);
  assert.equal(count('community_comments'), 1);
  const receipt = sqlite.prepare('SELECT * FROM community_kakao_events').get();
  assert.match(receipt.event_hash, /^[A-Za-z0-9_-]{43}$/);
  assert.match(receipt.subject_hash, /^[A-Za-z0-9_-]{43}$/);
  assert.ok(receipt.blocked_until - receipt.processed_at === 11 * 60 * 1000);
  assert.ok(receipt.expires_at - receipt.processed_at === 24 * 60 * 60 * 1000);
  assert.equal(JSON.stringify(receipt).includes('12345'), false);
});

test('signature, issuer, audience, type, subject, event and time failures never mutate data', async () => {
  seed();
  const now = Math.floor(Date.now() / 1000);
  const cases = [
    [await signed({}, wrongKey.privateKey), 'invalid_key'],
    [await signed({ iss: 'https://evil.test' }), 'invalid_issuer'],
    [await signed({ aud: 'other-app' }), 'invalid_audience'],
    [await signed({}, key.privateKey, { typ: 'JWT' }), 'invalid_request'],
    [await signed({ events: eventBody('other-subject') }), 'invalid_request'],
    [await signed({ events: { [unlink.replace('user-unlinked', 'user-linked')]: {} } }), 'invalid_request'],
    [await signed({ events: { ...eventBody(), another: {} } }), 'invalid_request'],
    [await signed({ toe: now + 120 }), 'invalid_request'],
    [await signed({ iat: now + 120 }), 'invalid_request'],
    [await signed({ iat: now - 5 * 3600, toe: now - 5 * 3600 }), 'invalid_request'],
    [await signed({ toe: now - 5 * 3600 }), 'invalid_request'],
    [await signed({ toe: now + 0.5 }), 'invalid_request'],
    [await signed({ jti: '' }), 'invalid_request'],
    [await signed({ app_id: '' }), 'invalid_request'],
    ['not-a-token', 'invalid_request'],
  ];
  for (const [token, expected] of cases) {
    const response = await deliver(token);
    assert.equal(response.status, 400, expected);
    assert.equal((await response.json()).err, expected);
    assert.equal(count('community_accounts'), 1);
    assert.equal(count('community_sessions'), 1);
    assert.equal(count('community_kakao_events'), 0);
  }
});

test('duplicates do not affect a later login; a first delayed unlink still revokes conservatively', async () => {
  const token = await signed();
  assert.equal((await deliver(token)).status, 202);
  seed();
  assert.equal((await deliver(token)).status, 202);
  assert.equal(count('community_sessions'), 1);
  assert.equal(count('community_accounts'), 1);
  assert.equal(count('community_kakao_events'), 1);
  const oldEvent = await signed({ toe: Math.floor(Date.now() / 1000) - 30 });
  assert.equal((await deliver(oldEvent)).status, 202);
  assert.equal(count('community_sessions'), 0);
  assert.equal(count('community_accounts'), 0);
});

test('second-resolution event time conservatively revokes a link created during the same second', async () => {
  const second = Math.floor(Date.now() / 1000);
  seed('kakao', '12345', 'old-user', second * 1000 + 800);
  assert.equal((await deliver(await signed({ toe: second }))).status, 202);
  assert.equal(count('community_sessions'), 0);
  assert.equal(count('community_accounts'), 0);
});

test('database failure rolls back receipt and deletes so Kakao retry can complete safely', async () => {
  seed();
  sqlite.exec("CREATE TRIGGER fail_unlink BEFORE DELETE ON community_accounts BEGIN SELECT RAISE(ABORT, 'test failure'); END");
  const token = await signed();
  assert.equal((await deliver(token)).status, 503);
  assert.equal(count('community_kakao_events'), 0);
  assert.equal(count('community_sessions'), 1);
  assert.equal(count('community_accounts'), 1);
  sqlite.exec('DROP TRIGGER fail_unlink');
  assert.equal((await deliver(token)).status, 202);
  assert.equal(count('community_sessions'), 0);
  assert.equal(count('community_accounts'), 0);
});

test('unlink wins a race with an in-flight OAuth callback; a later login creates a new identity', async () => {
  seed();
  const callback = await startLogin();
  const eventSecond = Math.floor(Date.now() / 1000);
  const token = await signed({ toe: eventSecond });
  mockLoginNetwork();
  const originalBatch = env.DB.batch;
  let intercepted = false;
  env.DB.batch = async (statements) => {
    if (!intercepted && statements[0].sql.startsWith('INSERT INTO community_users')) {
      intercepted = true;
      assert.equal((await deliver(token)).status, 202);
    }
    return originalBatch(statements);
  };
  const denied = await auth.finishCommunityOAuth(callback, env, 'kakao');
  assert.match(denied.headers.get('Location'), /auth_error=login_failed/);
  assert.equal(count('community_accounts'), 0);
  assert.equal(count('community_sessions'), 0);
  assert.equal(count('community_users'), 1);
  const newCallback = await startLogin();
  // Advance the stored flow start past the whole-second event boundary without sleeping.
  sqlite.prepare('UPDATE community_oauth_flows SET expires_at = ?').run((eventSecond + 2) * 1000 + 600000);
  const success = await auth.finishCommunityOAuth(newCallback, env, 'kakao');
  assert.equal(success.headers.get('Location'), '/');
  const cookie = success.headers.getSetCookie().find((item) => item.startsWith('__Host-community_session=')).split(';')[0];
  const newId = await auth.getCommunityIdentity(new Request('https://workfolio.life/', { headers: { Cookie: cookie } }), env);
  assert.ok(newId);
  assert.notEqual(newId, 'old-user');
  assert.equal((await deliver(token)).status, 202);
  assert.equal(await auth.getCommunityIdentity(new Request('https://workfolio.life/', { headers: { Cookie: cookie } }), env), newId);
});

test('expired subject watermarks and replay receipts are cleaned on OAuth starts and event delivery', async () => {
  sqlite.prepare('INSERT INTO community_kakao_events VALUES (?, ?, ?, ?, ?, ?)').run('expired-receipt', 'hash-a', 1, 2, 3, Date.now() - 1);
  sqlite.prepare('INSERT INTO community_kakao_events VALUES (?, ?, ?, ?, ?, ?)').run('expired-watermark', 'hash-b', 1, Date.now() - 1, 3, Date.now() + 60000);
  await startLogin();
  assert.equal(count('community_kakao_events'), 1);
  const row = sqlite.prepare('SELECT * FROM community_kakao_events').get();
  assert.equal(row.subject_hash, null);
  assert.equal(row.occurred_before, null);
  assert.equal(row.blocked_until, null);
  sqlite.prepare('UPDATE community_kakao_events SET expires_at = ?').run(Date.now() - 1);
  assert.equal((await deliver(await signed())).status, 202);
  assert.equal(count('community_kakao_events'), 1);
});

test('unsupported requests and missing configuration cannot fetch keys or change accounts', async () => {
  seed();
  assert.equal((await receiveKakaoEvent(request(null, { method: 'GET' }), env)).status, 405);
  assert.equal((await receiveKakaoEvent(request('x', { headers: { 'Content-Type': 'text/plain' } }), env)).status, 400);
  assert.equal((await deliver('a'.repeat(16385))).status, 400);
  assert.equal((await receiveKakaoEvent(request('x'), { DB: env.DB })).status, 503);
  assert.equal(networkCalls.length, 0);
  assert.equal(count('community_accounts'), 1);
  assert.equal(count('community_sessions'), 1);
});
