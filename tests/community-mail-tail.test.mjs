import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { createObjectParser, safeFailures, productionDeployment, tailProcess } from '../scripts/tail-company-mail.mjs';

const marker = 'community_company_mail_failure';
const privateText = 'SENSITIVE-cookie-email-IP-url-header-useragent';
const event = {
  event: { request: { url: privateText, headers: { cookie: privateText, 'user-agent': privateText }, cf: { ip: privateText } } },
  logs: [
    { level: 'error', message: [marker, { kind: 'provider_rejected', status: 401, secret: privateText }] },
    { level: 'error', message: ['unrelated', privateText] },
  ],
  exceptions: [{ message: privateText }],
};

test('only known error marker kind and valid HTTP status are copied', () => {
  assert.deepEqual(safeFailures(event), [{ kind: 'provider_rejected', status: 401 }]);
  for (const details of [
    { kind: privateText, status: 401 }, { kind: 'provider_rejected', status: privateText },
    { kind: 'provider_rejected', status: 999 }, { kind: 'provider_rejected', status: 401.5 },
    { kind: 'network', status: 401 }, { kind: 'network' },
  ]) assert.deepEqual(safeFailures({ logs: [{ level: 'error', message: [marker, details] }] }), []);
  assert.deepEqual(safeFailures({ logs: [{ level: 'info', message: [marker, { kind: 'network', status: null }] }] }), []);
  assert.deepEqual(safeFailures({ logs: [{ level: 'error', message: [marker, '{"kind":"timeout","status":null}'] }] }), [{ kind: 'timeout', status: null }]);
  assert.deepEqual(safeFailures({ logs: [{ level: 'error', message: [`${marker} { kind: 'configuration_encoding', status: null }`] }] }), [{ kind: 'configuration_encoding', status: null }]);
});

test('pretty JSON objects survive arbitrary chunk boundaries, braces and escaped strings', () => {
  const output = [];
  const parser = createObjectParser(object => output.push(...safeFailures(object)));
  const source = `CLI startup banner\n${JSON.stringify({ ...event, ignored: 'a { brace } and \\" quote' }, null, 4)}\n${JSON.stringify(event)}\n`;
  // One-character writes exercise every possible boundary including escapes.
  for (const char of source) parser.write(char);
  assert.deepEqual(output, [{ kind: 'provider_rejected', status: 401 }, { kind: 'provider_rejected', status: 401 }]);
  assert.ok(!JSON.stringify(output).includes(privateText));
});

test('invalid, incomplete and oversized frames are discarded and parsing recovers', () => {
  const output = [];
  const parser = createObjectParser(object => output.push(...safeFailures(object)), 250);
  parser.write('{not-json}\n');
  parser.write(JSON.stringify({ content: 'x'.repeat(500), logs: event.logs }));
  parser.write(JSON.stringify({ logs: [event.logs[0]] }));
  parser.write('{"unfinished":');
  parser.clear();
  assert.deepEqual(output, [{ kind: 'provider_rejected', status: 401 }]);
});

test('deployment resolution only uses official read-only API and successful production deployments', async () => {
  const goodId = '00000000-0000-0000-0000-000000000001';
  const badId = '00000000-0000-0000-0000-000000000002';
  const result = await productionDeployment('test-token', async (url, options) => {
    assert.equal(options.method, 'GET');
    assert.equal(options.redirect, 'error');
    assert.match(url, /^https:\/\/api.cloudflare.com\/client\/v4\/accounts\/[a-f\d]+\/pages\/projects\/workfolio\/deployments\?env=production&per_page=25$/);
    return Response.json({ success: true, result: [
      { id: badId, environment: 'production', created_on: '2026-11-12T01:00:00Z', latest_stage: { name: 'deploy', status: 'failure' } },
      { id: goodId, environment: 'production', created_on: '2026-11-11T01:00:00Z', latest_stage: { name: 'deploy', status: 'success' } },
    ] });
  });
  assert.equal(result, goodId);
  assert.equal(await productionDeployment('test-token', async () => { throw new Error(privateText); }), null);
});

test('CLI stdout is filtered, stderr discarded, and raw debug logs are redirected', async () => {
  const output = [];
  const ok = await tailProcess({
    deployment: 'deployment-id', env: { CLOUDFLARE_API_TOKEN: 'test-token' }, logPath: '/tmp/test/discard.log', durationMs: 1000,
    write: text => output.push(text),
    spawnImpl(command, args, options) {
      assert.equal(command, 'npx');
      assert.deepEqual(args, ['--no-install', 'wrangler', 'pages', 'deployment', 'tail', 'deployment-id', '--project-name', 'workfolio', '--environment', 'production', '--format', 'json', '--search', marker]);
      assert.deepEqual(options.stdio, ['ignore', 'pipe', 'pipe']);
      assert.equal(options.detached, true);
      assert.equal(options.env.WRANGLER_LOG_PATH, '/tmp/test/discard.log');
      assert.equal(options.env.WRANGLER_SEND_METRICS, 'false');
      assert.equal(options.env.npm_config_logs_max, '0');
      const child = new EventEmitter();
      child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.pid = 1234;
      queueMicrotask(() => {
        child.stderr.write(privateText);
        child.stdout.write(JSON.stringify(event, null, 4));
        child.stdout.end(); child.stderr.end(); child.emit('close', 0);
      });
      return child;
    },
  });
  assert.equal(ok, true);
  assert.deepEqual(output, ['{"kind":"provider_rejected","status":401}\n']);
});

test('time limit terminates the process group without printing raw messages', async () => {
  const signals = [];
  const output = [];
  const ok = await tailProcess({
    deployment: 'deployment-id', env: {}, logPath: '/tmp/test/discard.log', durationMs: 20,
    write: text => output.push(text), killImpl: (pid, signal) => signals.push({ pid, signal }),
    spawnImpl() {
      const child = new EventEmitter();
      child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.pid = 4321;
      return child;
    },
  });
  assert.equal(ok, true);
  assert.deepEqual(signals, [{ pid: -4321, signal: 'SIGTERM' }, { pid: -4321, signal: 'SIGKILL' }]);
  assert.deepEqual(output, []);
});
