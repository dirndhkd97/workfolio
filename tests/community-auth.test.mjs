import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';
import ts from 'typescript';
import { exportJWK, exportPKCS8, generateKeyPair, jwtVerify, SignJWT } from 'jose';

// Real SQLite + real JOSE signatures. Every provider HTTP request is mocked; no credentials/network.
const root = new URL('../', import.meta.url);
mkdirSync(new URL('work/', root), { recursive: true });
const directory = mkdtempSync(join(fileURLToPath(new URL('work/', root)), 'auth-tests-'));
const source = readFileSync(new URL('functions/_lib/community-auth.ts', root), 'utf8');
writeFileSync(join(directory, 'community-auth.mjs'), ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText);
const auth = await import(pathToFileURL(join(directory, 'community-auth.mjs')).href);
const signingKey = await generateKeyPair('RS256');
const wrongKey = await generateKeyPair('RS256');
const publicJwk = { ...await exportJWK(signingKey.publicKey), kid: 'test-key', alg: 'RS256', use: 'sig' };
const originalFetch = globalThis.fetch;
let sqlite;
let env;
let calls;

function adapter(connection) {
  function prepare(sql, args = []) {
    return {
      bind(...bindings) { return prepare(sql, bindings); },
      async first() { return connection.prepare(sql).get(...args) || null; },
      async all() { return { results: connection.prepare(sql).all(...args) }; },
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
  sqlite.exec(readFileSync(new URL('migrations/0005_community_auth.sql', root), 'utf8'));
  env = { DB: adapter(sqlite) };
  calls = [];
  globalThis.fetch = async (...args) => { calls.push(args); throw new Error('Unexpected network request'); };
});
after(() => { sqlite?.close(); globalThis.fetch = originalFetch; rmSync(directory, { recursive: true, force: true }); });

function configure(provider) {
  env[`${provider.toUpperCase()}_CLIENT_ID`] = `${provider}-client`;
  env[`${provider.toUpperCase()}_CLIENT_SECRET`] = `${provider}-test-secret`;
}
function setCookies(response) { return response.headers.getSetCookie(); }
function sessionCookie(response) { return setCookies(response).find((value) => value.startsWith('__Host-community_session='))?.split(';')[0]; }
function request(path, options) { return new Request(`https://workfolio.life${path}`, options); }
function callback(flow, overrides = {}) {
  const params = new URLSearchParams({ code: 'test-code', state: flow.state, ...overrides });
  return flow.provider === 'apple'
    ? request(`/api/community-auth/apple/callback`, { method: 'POST', headers: { Cookie: flow.cookie, 'Content-Type': 'application/x-www-form-urlencoded' }, body: params })
    : request(`/api/community-auth/${flow.provider}/callback?${params}`, { headers: { Cookie: flow.cookie } });
}
async function start(provider, returnTo = '/') {
  configure(provider);
  const response = await auth.startCommunityOAuth(request(`/api/community-auth/${provider}?return_to=${encodeURIComponent(returnTo)}`), env, provider);
  assert.equal(response.status, 303);
  const location = new URL(response.headers.get('Location'));
  const state = location.searchParams.get('state');
  const cookie = setCookies(response)[0].split(';')[0];
  const hash = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(state))).toString('base64url');
  const stored = sqlite.prepare('SELECT * FROM community_oauth_flows WHERE state_hash = ?').get(hash);
  return { provider, response, location, state, cookie, stored };
}
function errorCode(response) { return new URL(response.headers.get('Location'), 'https://workfolio.life').searchParams.get('auth_error'); }
function mockUserinfo(provider, id = provider === 'kakao' ? 12345 : '12345') {
  globalThis.fetch = async (url, init) => {
    calls.push([String(url), init]);
    if (String(url).includes('/token')) return Response.json({ access_token: 'provider-only-token', token_type: 'bearer' });
    assert.equal(new Headers(init.headers).get('Authorization'), 'Bearer provider-only-token');
    return Response.json(provider === 'kakao' ? { id, kakao_account: { email: 'same@example.test' } } : { resultcode: '00', response: { id, email: 'same@example.test' } });
  };
}
async function signedIdToken(flow, changes = {}, privateKey = signingKey.privateKey) {
  return new SignJWT({ nonce: flow.stored.nonce, ...changes })
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
    .setIssuer(changes.iss ?? (flow.provider === 'google' ? 'https://accounts.google.com' : 'https://appleid.apple.com'))
    .setAudience(changes.aud ?? `${flow.provider}-client`)
    .setSubject(changes.sub ?? 'oidc-subject')
    .setIssuedAt(changes.iat ?? Math.floor(Date.now() / 1000))
    .setExpirationTime(changes.exp ?? Math.floor(Date.now() / 1000) + 300)
    .sign(privateKey);
}
function mockOidc(token, validateTokenRequest = () => {}) {
  globalThis.fetch = async (url, init) => {
    calls.push([String(url), init]);
    if (String(url).endsWith('/certs') || String(url).endsWith('/keys')) return Response.json({ keys: [publicJwk] });
    await validateTokenRequest(new URLSearchParams(init.body), init);
    return Response.json({ id_token: token });
  };
}

test('missing provider registrations are visible and cannot trigger fake login or network requests', async () => {
  const me = await auth.communityMe(request('/api/community-auth/me'), env);
  assert.equal(me.status, 200);
  const value = await me.json();
  assert.equal(value.signedIn, false);
  assert.equal(value.user, null);
  assert.deepEqual(value.providers.map((item) => item.configured), [false, false, false, false]);
  for (const provider of ['kakao', 'naver', 'google', 'apple']) {
    const response = await auth.startCommunityOAuth(request(`/api/community-auth/${provider}`), env, provider);
    assert.equal(response.status, 503);
    assert.equal((await response.json()).code, 'provider_unavailable');
    assert.equal(response.headers.get('Location'), null);
  }
  assert.equal(calls.length, 0);
  assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM community_oauth_flows').get().n, 0);
});

test('return paths cannot redirect offsite, including URL-normalized double slashes', () => {
  for (const value of ['https://evil.test', '//evil.test', '/\\evil.test', '/%2f%2fevil.test', '/a/..//evil.test', '/a/%2e%2e//evil.test', '/api/community-auth/google', '/\n/evil.test', '/%00evil', '/?q=' + 'a'.repeat(1024)]) {
    assert.equal(auth.safeCommunityReturnTo(value), '/', value);
  }
  assert.equal(auth.safeCommunityReturnTo('/?board=free#latest'), '/?board=free#latest');
});

test('authorization binds random state to browser and uses Google/Kakao S256 PKCE', async () => {
  for (const provider of ['google', 'kakao']) {
    const flow = await start(provider, '/?board=free');
    assert.match(flow.state, /^[A-Za-z0-9_-]{43}$/);
    assert.notEqual(flow.stored.state_hash, flow.state);
    assert.equal(flow.stored.return_to, '/?board=free');
    assert.equal(flow.location.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(flow.location.searchParams.get('code_challenge'), Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(flow.stored.code_verifier))).toString('base64url'));
    assert.match(setCookies(flow.response)[0], /__Host-community_oauth_.*Path=\/; HttpOnly; Secure; SameSite=Lax; Max-Age=600/);
    assert.equal(flow.location.searchParams.has('client_secret'), false);
  }
  const rows = sqlite.prepare('SELECT state_hash, browser_hash, nonce FROM community_oauth_flows').all();
  assert.notEqual(rows[0].state_hash, rows[1].state_hash);
  assert.notEqual(rows[0].browser_hash, rows[1].browser_hash);
});

test('state rejects missing browser, wrong browser/provider, expiration and replay before exchanging credentials', async () => {
  const flow = await start('kakao');
  configure('naver');
  const url = `/api/community-auth/kakao/callback?code=test-code&state=${flow.state}`;
  for (const headers of [{}, { Cookie: '__Host-community_oauth_kakao=' + 'a'.repeat(43) }]) {
    assert.equal(errorCode(await auth.finishCommunityOAuth(request(url, { headers }), env, 'kakao')), 'invalid_state');
  }
  const wrongProvider = request(`/api/community-auth/naver/callback?code=test-code&state=${flow.state}`, { headers: { Cookie: flow.cookie.replace('oauth_kakao', 'oauth_naver') } });
  assert.equal(errorCode(await auth.finishCommunityOAuth(wrongProvider, env, 'naver')), 'invalid_state');
  assert.equal(calls.length, 0);
  mockUserinfo('kakao');
  const success = await auth.finishCommunityOAuth(callback(flow), env, 'kakao');
  assert.ok(sessionCookie(success));
  const count = calls.length;
  assert.equal(errorCode(await auth.finishCommunityOAuth(callback(flow), env, 'kakao')), 'invalid_state');
  assert.equal(calls.length, count);
  const expired = await start('kakao');
  sqlite.prepare('UPDATE community_oauth_flows SET expires_at = ?').run(Date.now() - 1);
  assert.equal(errorCode(await auth.finishCommunityOAuth(callback(expired), env, 'kakao')), 'invalid_state');
  assert.equal(calls.length, count);
});

test('userinfo login hashes sessions and keeps providers separate even with identical email and subject', async () => {
  const ids = [];
  for (const provider of ['kakao', 'naver']) {
    const flow = await start(provider, '/?board=free');
    mockUserinfo(provider);
    const response = await auth.finishCommunityOAuth(callback(flow), env, provider);
    assert.equal(response.headers.get('Location'), '/?board=free');
    const session = sessionCookie(response);
    assert.ok(session);
    assert.match(setCookies(response)[0], /Path=\/; HttpOnly; Secure; SameSite=Lax/);
    const me = await (await auth.communityMe(request('/api/community-auth/me', { headers: { Cookie: session } }), env)).json();
    assert.equal(me.signedIn, true);
    assert.match(me.user.nickname, /^퇴근러/);
    ids.push(me.user.id);
    assert.equal(await auth.getCommunityIdentity(request('/', { headers: { Cookie: session } }), env), me.user.id);
    const stored = sqlite.prepare('SELECT * FROM community_sessions WHERE user_id = ?').get(me.user.id);
    assert.notEqual(stored.token_hash, session.split('=')[1]);
    assert.equal(JSON.stringify(me).includes('same@example.test'), false);
    const tokenRequest = new URLSearchParams(calls.find(([url]) => url.includes('/token'))[1].body);
    assert.equal(tokenRequest.get('state'), flow.state);
    if (provider === 'kakao') assert.equal(tokenRequest.get('code_verifier'), flow.stored.code_verifier);
    calls = [];
  }
  assert.notEqual(ids[0], ids[1]);
  assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM community_accounts').get().n, 2);
});

test('Google verifies signature, issuer, audience, nonce and expiry before creating any session', async () => {
  const invalid = [
    [{}, wrongKey.privateKey],
    [{ iss: 'https://evil.test' }],
    [{ aud: 'other-client' }],
    [{ nonce: 'wrong-nonce' }],
    [{ exp: Math.floor(Date.now() / 1000) - 120 }],
    [{ azp: 'other-client' }],
  ];
  for (const [changes, key] of invalid) {
    const flow = await start('google');
    mockOidc(await signedIdToken(flow, changes, key));
    assert.equal(errorCode(await auth.finishCommunityOAuth(callback(flow), env, 'google')), 'login_failed');
    assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM community_sessions').get().n, 0);
    assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM community_users').get().n, 0);
  }
  const flow = await start('google');
  mockOidc(await signedIdToken(flow), (body) => {
    assert.equal(body.get('code_verifier'), flow.stored.code_verifier);
    assert.equal(body.get('redirect_uri'), 'https://workfolio.life/api/community-auth/google/callback');
    assert.equal(body.get('client_secret'), 'google-test-secret');
  });
  const success = await auth.finishCommunityOAuth(callback(flow), env, 'google');
  assert.ok(sessionCookie(success));
});

test('Apple uses form_post with a secure cross-site transaction cookie and signs its client secret', async () => {
  const key = await generateKeyPair('ES256', { extractable: true });
  const flow = await start('apple');
  delete env.APPLE_CLIENT_SECRET;
  Object.assign(env, { APPLE_TEAM_ID: 'TESTTEAM01', APPLE_KEY_ID: 'TESTKEY001', APPLE_PRIVATE_KEY: await exportPKCS8(key.privateKey) });
  assert.equal(auth.communityProviders(env).find((item) => item.id === 'apple').configured, true);
  assert.equal(flow.location.searchParams.get('response_mode'), 'form_post');
  assert.equal(flow.location.searchParams.get('nonce'), flow.stored.nonce);
  assert.match(setCookies(flow.response)[0], /HttpOnly; Secure; SameSite=None/);
  const wrongMethod = request(`/api/community-auth/apple/callback?state=${flow.state}&code=test-code`, { headers: { Cookie: flow.cookie } });
  assert.equal(errorCode(await auth.finishCommunityOAuth(wrongMethod, env, 'apple')), 'invalid_state');
  assert.equal(calls.length, 0);
  mockOidc(await signedIdToken(flow), async (body) => {
    const { payload, protectedHeader } = await jwtVerify(body.get('client_secret'), key.publicKey, { issuer: 'TESTTEAM01', audience: 'https://appleid.apple.com', subject: 'apple-client', algorithms: ['ES256'] });
    assert.equal(protectedHeader.kid, 'TESTKEY001');
    assert.ok(payload.exp - payload.iat <= 300);
    assert.equal(body.get('redirect_uri'), 'https://workfolio.life/api/community-auth/apple/callback');
  });
  const success = await auth.finishCommunityOAuth(callback(flow, { user: '{"email":"untrusted@example.test"}' }), env, 'apple');
  assert.ok(sessionCookie(success));
  const local = await auth.startCommunityOAuth(new Request('http://localhost:8788/api/community-auth/apple'), env, 'apple');
  assert.equal((await local.json()).code, 'insecure_origin');
});

test('legacy cookies/identity headers are untrusted; duplicate, expired and insecure cookies fail closed; logout checks origin', async () => {
  const flow = await start('naver');
  mockUserinfo('naver');
  const response = await auth.finishCommunityOAuth(callback(flow), env, 'naver');
  const session = sessionCookie(response);
  const token = session.split('=')[1];
  for (const headers of [
    { Cookie: `session=${token}`, 'oai-authenticated-user-id': 'forged' },
    { Cookie: `${session}; ${session}` },
    { Cookie: 'community_session=' + token },
    { 'oai-authenticated-user-id': 'forged', 'X-User-Id': 'forged' },
  ]) assert.equal(await auth.getCommunityIdentity(request('/', { headers }), env), null);
  assert.equal(await auth.getCommunityIdentity(new Request('http://workfolio.life/', { headers: { Cookie: session } }), env), null);
  const bad = await auth.logoutCommunity(request('/api/community-auth/logout', { method: 'POST', headers: { Cookie: session, Origin: 'https://evil.test' } }), env);
  assert.equal(bad.status, 403);
  assert.ok(await auth.getCommunityIdentity(request('/', { headers: { Cookie: session } }), env));
  const good = await auth.logoutCommunity(request('/api/community-auth/logout', { method: 'POST', headers: { Cookie: session, Origin: 'https://workfolio.life' } }), env);
  assert.equal(good.status, 200);
  assert.match(setCookies(good)[0], /Max-Age=0/);
  assert.equal(await auth.getCommunityIdentity(request('/', { headers: { Cookie: session } }), env), null);
  const expiredFlow = await start('naver');
  const expiredSession = sessionCookie(await auth.finishCommunityOAuth(callback(expiredFlow), env, 'naver'));
  sqlite.prepare('UPDATE community_sessions SET expires_at = ?').run(Date.now() - 1);
  assert.equal(await auth.getCommunityIdentity(request('/', { headers: { Cookie: expiredSession } }), env), null);
});

test('provider cancellation never reflects error descriptions and consumes the flow once', async () => {
  const flow = await start('google', '/?board=free');
  const denied = await auth.finishCommunityOAuth(callback(flow, { error: 'access_denied', error_description: '<script>untrusted</script>' }), env, 'google');
  assert.equal(errorCode(denied), 'provider_denied');
  assert.equal(denied.headers.get('Location').includes('untrusted'), false);
  assert.equal(denied.headers.get('Location').includes('board=free'), true);
  assert.equal(calls.length, 0);
  assert.equal(errorCode(await auth.finishCommunityOAuth(callback(flow), env, 'google')), 'invalid_state');
});
