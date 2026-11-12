import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Log, LogLevel, Miniflare } from 'miniflare';

// Run actual auth code + D1 in the same workerd runtime as Wrangler, with no external network.
// Node's fetch mock alone does not catch Workers' unsupported redirect:'error' option.
const root = new URL('../', import.meta.url);
let runtime;
let db;
let followedRedirects = 0;
const expectedRequests = [];
const outboundFailures = [];
const endpoints = {
  kakao: { tokenOrigin: 'https://kauth.kakao.com', tokenPath: '/oauth/token', userOrigin: 'https://kapi.kakao.com', userPath: '/v2/user/me', profile: { id: 123456789 } },
  naver: { tokenOrigin: 'https://nid.naver.com', tokenPath: '/oauth2.0/token', userOrigin: 'https://openapi.naver.com', userPath: '/v1/nid/me', profile: { resultcode: '00', response: { id: 'naver-runtime-subject' } } },
};

before(async () => {
  const bundled = await build({
    stdin: { contents: `
      import { startCommunityOAuth, finishCommunityOAuth, communityMe } from './functions/_lib/community-auth.ts';
      console.warn = () => {}; // Expected denial cases; diagnostic field safety is tested separately.
      export default { fetch(request, env) {
        const path = new URL(request.url).pathname.split('/');
        if (path[3] === 'me') return communityMe(request, env);
        return path[4] === 'callback' ? finishCommunityOAuth(request, env, path[3]) : startCommunityOAuth(request, env, path[3]);
      } };
    `, resolveDir: fileURLToPath(root), loader: 'ts' },
    bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022',
  });
  runtime = new Miniflare({
    modules: true, script: bundled.outputFiles[0].text, compatibilityDate: '2024-12-01',
    d1Databases: ['DB'], log: new Log(LogLevel.NONE),
    // A response-only service avoids any Node fetch redirect handling in the mock transport.
    // The actual redirect policy is exercised exclusively by workerd and production auth code.
    outboundService: async (request) => {
      const url = new URL(request.url);
      if (url.origin === 'https://capture.invalid') {
        followedRedirects++;
        return Response.json({ access_token: 'dummy-redirect-token', token_type: 'bearer' });
      }
      const expected = expectedRequests.shift();
      if (!expected || request.url !== expected.url || request.method !== expected.method) {
        outboundFailures.push('Unexpected outgoing request');
        return new Response(null, { status: 500 });
      }
      return new Response(JSON.stringify(expected.data), { status: expected.status, headers: expected.headers });
    },
    bindings: { KAKAO_CLIENT_ID: 'dummy-kakao-client', KAKAO_CLIENT_SECRET: 'dummy-kakao-secret', NAVER_CLIENT_ID: 'dummy-naver-client', NAVER_CLIENT_SECRET: 'dummy-naver-secret' },
  });
  db = await runtime.getD1Database('DB');
  for (const file of ['0005_community_auth.sql', '0007_community_kakao_events.sql']) {
    const statements = readFileSync(new URL(`migrations/${file}`, root), 'utf8').replace(/--[^\n]*/g, '').split(';').map((sql) => sql.trim()).filter(Boolean);
    await db.batch(statements.map((sql) => db.prepare(sql)));
  }
});
after(async () => { await runtime?.dispose(); });

async function callback(provider) {
  const start = await runtime.dispatchFetch(`https://workfolio.life/api/community-auth/${provider}`, { redirect: 'manual' });
  assert.equal(start.status, 303);
  const state = new URL(start.headers.get('Location')).searchParams.get('state');
  const cookie = start.headers.getSetCookie()[0].split(';')[0];
  return runtime.dispatchFetch(`https://workfolio.life/api/community-auth/${provider}/callback?code=dummy-authorization-code&state=${state}`, { headers: { Cookie: cookie }, redirect: 'manual' });
}
function tokenResponse(provider, status = 200) {
  const endpoint = endpoints[provider];
  expectedRequests.push({ url: endpoint.tokenOrigin + endpoint.tokenPath, method: 'POST', status, data: { access_token: 'dummy-runtime-token', token_type: 'bearer' } });
}

test('Kakao and Naver complete token fetch, userinfo and session creation in real workerd', async () => {
  for (const [provider, endpoint] of Object.entries(endpoints)) {
    tokenResponse(provider);
    expectedRequests.push({ url: endpoint.userOrigin + endpoint.userPath, method: 'GET', status: 200, data: endpoint.profile });
    const response = await callback(provider);
    assert.equal(response.status, 303);
    assert.equal(response.headers.get('Location'), '/', provider);
    const cookie = response.headers.getSetCookie().find((value) => value.startsWith('__Host-community_session=')).split(';')[0];
    const me = await runtime.dispatchFetch('https://workfolio.life/api/community-auth/me', { headers: { Cookie: cookie } });
    assert.equal((await me.json()).signedIn, true, provider);
  }
  assert.deepEqual(outboundFailures, []);
  assert.equal(expectedRequests.length, 0);
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM community_sessions').first()).n, 2);
});

test('workerd rejects all provider redirect responses without forwarding tokens or client credentials', async () => {
  for (const provider of ['kakao', 'naver']) {
    const endpoint = endpoints[provider];
    for (const kind of ['token', 'userinfo']) {
      for (const status of [301, 302, 303, 307, 308]) {
        if (kind === 'userinfo') tokenResponse(provider);
        expectedRequests.push({ url: kind === 'token' ? endpoint.tokenOrigin + endpoint.tokenPath : endpoint.userOrigin + endpoint.userPath, method: kind === 'token' ? 'POST' : 'GET', status, data: '', headers: { Location: 'https://capture.invalid/capture' } });
        const response = await callback(provider);
        assert.equal(new URL(response.headers.get('Location'), 'https://workfolio.life').searchParams.get('auth_error'), 'login_failed', `${provider} ${kind} ${status}`);
        assert.equal(followedRedirects, 0, `${provider} ${kind} ${status} followed a redirect`);
      }
    }
  }
  assert.deepEqual(outboundFailures, []);
  assert.equal(expectedRequests.length, 0);
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM community_sessions').first()).n, 2);
});
