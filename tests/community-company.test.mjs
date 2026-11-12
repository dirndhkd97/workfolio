import test, { after, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { stripTypeScriptTypes } from 'node:module';

// Execute real company verification code/SQLite; only authenticated identity and mail are mocked.
const root = new URL('../', import.meta.url);
const directory = mkdtempSync(join(tmpdir(), 'workfolio-company-'));
const compile = (path, filename, rewrite = value => value) => writeFileSync(join(directory, filename), rewrite(stripTypeScriptTypes(readFileSync(new URL(path, root), 'utf8'))));
compile('src/lib/community/domain.ts', 'domain.mjs');
compile('functions/_lib/community-company.ts', 'company.mjs', value => value
  .replace(/import \{ getCommunityIdentity[^\n]+community-auth';/, 'const getCommunityIdentity = globalThis.__companyIdentityForTest;')
  .replace("'../../src/lib/community/domain'", "'./domain.mjs'"));
globalThis.__companyIdentityForTest = async request => /(?:^|;\s*)test_session=([a-z0-9-]+)/.exec(request.headers.get('Cookie') || '')?.[1] ?? null;
const company = await import(pathToFileURL(join(directory, 'company.mjs')).href);
const originalFetch = globalThis.fetch;
let sqlite, env, messages;

function adapter(connection) {
  let batchTail = Promise.resolve();
  function prepare(sql, values = []) {
    return {
      bind(...args) { return prepare(sql, args); },
      async first() { return connection.prepare(sql).get(...values) ?? null; },
      async all() { return { results: connection.prepare(sql).all(...values) }; },
      async run() { return { success: true, meta: { changes: Number(connection.prepare(sql).run(...values).changes) } }; },
    };
  }
  return { prepare, batch(statements) {
    const result = batchTail.then(async () => {
      connection.exec('BEGIN');
      try { const results = []; for (const statement of statements) results.push(await statement.run()); connection.exec('COMMIT'); return results; }
      catch (error) { connection.exec('ROLLBACK'); throw error; }
    });
    batchTail = result.catch(() => {});
    return result;
  } };
}

beforeEach(() => {
  mock.timers.reset();
  mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 10, 12, 0) });
  sqlite?.close();
  sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON');
  sqlite.exec(readFileSync(new URL('migrations/0005_community_auth.sql', root), 'utf8'));
  sqlite.exec(readFileSync(new URL('migrations/0009_community_company_verification.sql', root), 'utf8'));
  for (const id of ['owner', 'visitor', ...Array.from({ length: 6 }, (_, i) => `person-${i}`)]) sqlite.prepare('INSERT INTO community_users VALUES (?, ?, ?)').run(id, id, Date.now());
  env = { DB: adapter(sqlite), MAILGUN_API_KEY: 'not-a-real-key' };
  messages = [];
  globalThis.fetch = async (url, init) => {
    assert.equal(url, 'https://api.mailgun.net/v3/workfolio.life/messages');
    assert.equal(init.redirect, 'manual');
    assert.ok(init.signal);
    messages.push(Object.fromEntries(init.body.entries()));
    return Response.json({ id: 'test-mail' });
  };
});
after(() => { mock.timers.reset(); sqlite?.close(); globalThis.fetch = originalFetch; delete globalThis.__companyIdentityForTest; rmSync(directory, { recursive: true, force: true }); });

function request(path, data, user = 'owner', headers = {}) {
  return new Request(`https://workfolio.life/api/community-company/${path}`, {
    method: data === undefined ? 'GET' : 'POST',
    headers: { Origin: 'https://workfolio.life', ...(user ? { Cookie: `test_session=${user}` } : {}), ...(data === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
}
const send = (email = 'member@workfolio.life', user = 'owner') => company.sendCompanyCode(request('send-code', { email }, user), env);
const verify = (code = lastCode(), user = 'owner', extra = {}) => company.verifyCompanyCode(request('verify-code', { code, ...extra }, user), env);
const me = (user = 'owner') => company.companyMe(request('me', undefined, user), env);
function lastCode() { return /인증코드: (\d{6})/.exec(messages.at(-1).text)[1]; }
function advance(minutes) { mock.timers.tick(minutes * 60000); }
function storedChallenges() { return sqlite.prepare('SELECT * FROM community_company_challenges').all(); }

test('company endpoints require verified login and same-origin JSON mutations', async () => {
  assert.equal((await me(null)).status, 401);
  assert.equal((await send('member@workfolio.life', null)).status, 401);
  assert.equal((await verify('123456', null)).status, 401);
  for (const [headers, expected] of [[{ Origin: 'https://evil.example' }, 403], [{ 'Sec-Fetch-Site': 'cross-site' }, 403], [{ 'Content-Type': 'text/plain' }, 415]]) {
    assert.equal((await company.sendCompanyCode(request('send-code', { email: 'member@workfolio.life' }, 'owner', headers), env)).status, expected);
    assert.equal((await company.verifyCompanyCode(request('verify-code', { code: '123456' }, 'owner', headers), env)).status, expected);
  }
  assert.equal(messages.length, 0);
  assert.deepEqual(await (await me()).json(), { company: null });
});

test('only an exact operator-approved domain can claim its company; request names are ignored', async () => {
  for (const email of ['member@gmail.com', 'member@mail.workfolio.life', 'member@workfolio.life.evil.test', 'a@workfolio.life,b@workfolio.life', 'a@workfolio.life\r\nBcc:b@evil.test', 'not-an-email']) {
    assert.equal((await send(email)).status, 400, email);
  }
  const response = await company.sendCompanyCode(request('send-code', { email: ' MEMBER@WORKFOLIO.LIFE ', company: { id: 'fake', name: '가짜 회사' } }), env);
  assert.equal(response.status, 200);
  const value = await response.json();
  assert.deepEqual(value.company, { id: 'workfolio', name: 'Workfolio' });
  assert.equal(value.expiresAt, Date.now() + 600000);
  assert.equal(messages[0].to, 'member@workfolio.life');
  const persisted = JSON.stringify(storedChallenges());
  assert.equal(persisted.includes('member@workfolio.life'), false);
  assert.equal(persisted.includes(lastCode()), false);
  assert.equal(JSON.stringify(value).includes(lastCode()), false);
  assert.equal(value.sent, true);
});

test('one-time code verifies only its signed-in requester and expires company proof after 90 days', async () => {
  await send();
  const code = lastCode();
  assert.equal((await verify(code, 'visitor')).status, 400);
  assert.deepEqual(await (await me('visitor')).json(), { company: null });
  const response = await verify(code, 'owner', { company: { id: 'fake', name: '가짜 회사' } });
  assert.equal(response.status, 200);
  const expected = { id: 'workfolio', name: 'Workfolio', verifiedAt: Date.now(), expiresAt: Date.now() + 90 * 86400000 };
  assert.deepEqual((await response.json()).company, expected);
  assert.deepEqual(await (await me()).json(), { company: expected });
  assert.equal(storedChallenges()[0].code_hash, null);
  assert.equal((await verify(code)).status, 400);
  const stored = JSON.stringify(sqlite.prepare('SELECT * FROM community_company_verifications').all());
  assert.equal(stored.includes('member@workfolio.life'), false);
  advance(90 * 24 * 60);
  assert.deepEqual(await (await me()).json(), { company: null });
});

test('five wrong attempts exhaust a code; expired codes cannot certify a company', async () => {
  await send();
  const code = lastCode(), wrong = code === '000000' ? '000001' : '000000';
  for (let i = 0; i < 5; i++) assert.equal((await verify(wrong)).status, 400);
  assert.equal((await verify(code)).status, 400);
  assert.equal(storedChallenges()[0].attempts, 5);
  advance(1);
  await send();
  advance(10);
  assert.equal((await verify()).status, 400);
  assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM community_company_verifications').get().n, 0);
});

test('resending invalidates earlier codes without invalidating a request rejected by the cooldown', async () => {
  await send();
  const oldCode = lastCode();
  assert.equal((await send()).status, 429);
  assert.equal(storedChallenges()[0].status, 'sent');
  advance(1);
  assert.equal((await send()).status, 200);
  assert.equal(storedChallenges()[0].status, 'cancelled');
  assert.equal(storedChallenges()[0].code_hash, null);
  const newCode = lastCode();
  // Randomly equal codes remain bound to different requests, so test hash invalidation separately.
  if (oldCode !== newCode) assert.equal((await verify(oldCode)).status, 400);
  assert.equal((await verify(newCode)).status, 200);
});

test('mail failures and redirects do not leave usable codes, and missing configuration does not send', async () => {
  delete env.MAILGUN_API_KEY;
  assert.equal((await send()).status, 503);
  assert.equal(storedChallenges().length, 0);
  env.MAILGUN_API_KEY = 'not-a-real-key';
  for (const status of [500, 302]) {
    globalThis.fetch = async () => new Response(null, { status });
    assert.equal((await send()).status, 503);
    assert.equal(storedChallenges().at(-1).status, 'failed');
    assert.equal(storedChallenges().at(-1).code_hash, null);
    assert.equal((await verify('123456')).status, 400);
    advance(1);
  }
  globalThis.fetch = async () => { throw new Error('private mail failure'); };
  const response = await send();
  assert.equal(response.status, 503);
  assert.equal((await response.text()).includes('private mail failure'), false);
  assert.equal(storedChallenges().at(-1).status, 'failed');
});

test('send limits are atomic across concurrent requests and apply to both account and mailbox', async () => {
  const first = await Promise.all([send(), send()]);
  assert.deepEqual(first.map(item => item.status).sort(), [200, 429]);
  assert.equal(messages.length, 1);
  for (let i = 1; i < 5; i++) { advance(1); assert.equal((await send(`member-${i}@workfolio.life`)).status, 200); }
  advance(1);
  assert.equal((await send('another@workfolio.life')).status, 429);
  // A mailbox limit also spans different authenticated users.
  for (let i = 0; i < 5; i++) { advance(1); assert.equal((await send('shared@workfolio.life', `person-${i}`)).status, 200); }
  advance(1);
  assert.equal((await send('shared@workfolio.life', 'person-5')).status, 429);
  advance(60);
  assert.equal((await send('shared@workfolio.life', 'person-5')).status, 200);
  assert.equal(storedChallenges().length, 1);
});

test('concurrent verification consumes a code once and a revoked domain cannot certify a company', async () => {
  await send();
  const result = await Promise.all([verify(), verify()]);
  assert.deepEqual(result.map(item => item.status).sort(), [200, 409]);
  assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM community_company_verifications').get().n, 1);
  advance(1);
  await send('member2@workfolio.life', 'visitor');
  sqlite.prepare('DELETE FROM community_company_domains WHERE domain = ?').run('workfolio.life');
  assert.equal((await verify(lastCode(), 'visitor')).status, 409);
  assert.deepEqual(await (await me('visitor')).json(), { company: null });
});

test('reverification updates the current company without granting proof to another account', async () => {
  await send();
  await verify();
  sqlite.exec("INSERT INTO community_companies VALUES ('next', '새 회사'); INSERT INTO community_company_domains VALUES ('next.example', 'next');");
  advance(1);
  await send('member@next.example');
  const response = await verify();
  assert.equal((await response.json()).company.name, '새 회사');
  assert.deepEqual(await (await me('visitor')).json(), { company: null });
});
