import assert from 'node:assert/strict';
import test from 'node:test';
import { diagnose, classifyMailgun, summarizeChallenges } from '../scripts/diagnose-company-mail.mjs';

const env = { CLOUDFLARE_API_TOKEN: 'cf-secret-sentinel' };
const secret = 'mailgun-secret-sentinel';
const privateText = 'private-person@example.test';
const reply = (data, status = 200) => new Response(JSON.stringify(data), { status });
function mockFetch(value, calls, mailgunStatus = 200) {
  return async (url, options) => {
    calls.push({ url, options });
    if (url.includes('/pages/projects/')) return reply({ success: true, result: {
      name: 'workfolio', production_branch: 'main', deployment_configs: { production: { env_vars: {
        MAILGUN_API_KEY: { type: 'secret_text', ...(value === undefined ? {} : { value }) },
      } } },
    } });
    if (url.includes('/d1/')) {
      const { sql } = JSON.parse(options.body);
      assert.match(sql, /^SELECT /);
      assert.doesNotMatch(sql, /INSERT|UPDATE|DELETE|ALTER|DROP/);
      return reply({ success: true, result: [{ success: true, results: sql.includes('GROUP BY')
        ? [{ status: 'failed', count: 2, latest_created_at: 1700000000000, email_hash: privateText }]
        : [{ mapping_exists: 1 }] }] });
    }
    assert.equal(options.method, 'GET');
    assert.equal(options.redirect, 'manual');
    assert.match(url, /^https:\/\/api(?:\.eu)?\.mailgun\.net\/v4\/domains\/workfolio\.life$/);
    assert.equal(options.headers.Authorization, `Basic ${Buffer.from(`api:${secret}`).toString('base64')}`);
    return reply({ domain: { state: 'active', smtp_login: privateText, password: secret }, message: privateText }, mailgunStatus);
  };
}

test('readable secret stays internal; only GET domain metadata and fixed SELECT queries run', async () => {
  const calls = [];
  const result = await diagnose({ env, fetchImpl: mockFetch(secret, calls) });
  assert.equal(result.secretReadable, true);
  assert.equal(result.mapping.mappingExists, true);
  assert.equal(result.challenges.statuses.find(row => row.status === 'failed').count, 2);
  assert.equal(result.mailgun.us.domainState, 'active');
  assert.equal(calls.length, 5);
  const serialized = JSON.stringify(result);
  for (const value of [secret, env.CLOUDFLARE_API_TOKEN, privateText, 'email_hash', 'smtp_login', 'password']) assert.ok(!serialized.includes(value));
});

test('unreadable and redacted secrets skip Mailgun normally while returning D1 summaries', async () => {
  for (const value of [undefined, '', '   ', '********', '[REDACTED]']) {
    const calls = [];
    const result = await diagnose({ env, fetchImpl: mockFetch(value, calls) });
    assert.equal(result.secretReadable, false);
    assert.equal(result.mailgun, undefined);
    assert.equal(result.mapping.mappingExists, true);
    assert.equal(calls.length, 3);
  }
});

test('metadata 403 leaves sending-key validity unknown and response content is discarded', async () => {
  const result = await diagnose({ env, fetchImpl: mockFetch(secret, [], 403) });
  assert.deepEqual(result.mailgun.us, { httpStatus: 403, classification: 'metadata_forbidden_key_scope_unknown' });
  assert.ok(!JSON.stringify(result).includes(privateText));
  assert.equal(classifyMailgun(401), 'metadata_authentication_rejected');
  assert.equal(classifyMailgun(404), 'domain_not_found_or_inaccessible_in_region');
  assert.equal(classifyMailgun(302), 'metadata_redirect_not_followed');
});

test('arbitrary database strings and request error details never reach output', async () => {
  const result = await diagnose({ env, fetchImpl: async () => { throw new Error(`${secret} ${privateText}`); } });
  assert.equal(result.pages.classification, 'cloudflare_network_error');
  const summaries = summarizeChallenges([{ status: privateText, count: 1 }, { status: 'failed', count: privateText, latest_created_at: privateText }]);
  assert.ok(!JSON.stringify({ result, summaries }).includes(privateText));
  assert.ok(!JSON.stringify(result).includes(secret));
});
