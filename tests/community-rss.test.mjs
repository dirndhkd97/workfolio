import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { stripTypeScriptTypes } from 'node:module';
import sax from 'sax';

const root = new URL('../', import.meta.url);
const directory = mkdtempSync(join(tmpdir(), 'workfolio-rss-'));
for (const [source, target] of [
  ['src/lib/community/seo.ts', 'seo.mjs'],
  ['src/lib/community/sharing.ts', 'sharing.mjs'],
  ['functions/_lib/community-seo.ts', 'helper.mjs'],
  ['functions/rss.xml.ts', 'rss.mjs'],
]) {
  const compiled = stripTypeScriptTypes(readFileSync(new URL(source, root), 'utf8'))
    .replace(/(['"])(?:\.\.\/)+src\/lib\/community\/seo\1/g, "'./seo.mjs'")
    .replace(/(['"])\.\/seo\1/g, "'./seo.mjs'")
    .replace(/(['"])(?:\.\.\/)+src\/lib\/community\/sharing\1/g, "'./sharing.mjs'")
    .replace(/(['"])(?:\.\.\/|\.\/)\_lib\/community-seo\1/g, "'./helper.mjs'");
  writeFileSync(join(directory, target), compiled);
}
const { onRequest } = await import(pathToFileURL(join(directory, 'rss.mjs')).href);
const metadata = await import(pathToFileURL(join(directory, 'seo.mjs')).href);

let sqlite;
let statements;
let env;
beforeEach(() => {
  sqlite?.close();
  sqlite = new DatabaseSync(':memory:');
  // No account or session tables exist: the feed must work with only public board data.
  sqlite.exec(readFileSync(new URL('migrations/0006_community_board.sql', root), 'utf8'));
  statements = [];
  env = { DB: { prepare(sql) {
    assert.match(sql, /^SELECT\b/i, 'RSS must only read D1');
    assert.doesNotMatch(sql, /owner_id|community_(?:users|accounts|sessions|reports|write_limits)/i);
    statements.push(sql);
    return { async all() { return { results: sqlite.prepare(sql).all() }; } };
  } } };
});
after(() => { sqlite?.close(); rmSync(directory, { recursive: true, force: true }); });

const createdAt = Date.UTC(2026, 10, 12, 12, 34, 56);
function seed(id, values = {}) {
  const row = { title: '퇴근 후 이야기', body: '첫 줄 이야기\n둘째 줄 이야기', category: '회사 사람들', nickname: '익명의 동료', createdAt, ...values };
  sqlite.prepare('INSERT INTO community_posts (id, owner_id, title, body, category, nickname, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, 'private-owner-never-publish', row.title, row.body, row.category, row.nickname, row.createdAt);
  return row;
}
const request = (method = 'GET') => onRequest({ env, request: new Request('https://untrusted-host.invalid/rss.xml?limit=9999', {
  method, headers: { Cookie: '__Host-community_session=ignored-session', 'oai-authenticated-user-id': 'private-owner-never-publish' },
}) });

function parse(xml) {
  const parser = sax.parser(true);
  const stack = [];
  let document;
  parser.onopentag = ({ name, attributes }) => {
    const element = { name, attributes, text: '', children: [] };
    if (stack.length) stack.at(-1).children.push(element);
    else document = element;
    stack.push(element);
  };
  parser.ontext = text => { if (stack.length) stack.at(-1).text += text; };
  parser.onclosetag = () => stack.pop();
  parser.write(xml).close();
  return document;
}
const child = (element, name) => element.children.find(item => item.name === name);

test('RSS exposes complete escaped public text, canonical permalinks and publication dates', async () => {
  const title = '회의 <img src=x> & "퇴근"';
  const body = '첫 줄\n</description><script>위조 항목</script> & 따옴표 \' "\n' + '마지막까지 읽는 이야기 '.repeat(150);
  seed('public-post', { title, body });
  const response = await request();
  const xml = await response.text();
  const rss = parse(xml);
  const channel = child(rss, 'channel');
  const item = child(channel, 'item');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Content-Type'), 'application/rss+xml; charset=utf-8');
  assert.equal(response.headers.get('Set-Cookie'), null);
  assert.equal(rss.name, 'rss');
  assert.equal(rss.attributes.version, '2.0');
  assert.equal(child(channel, 'title').text, metadata.HOME_TITLE);
  assert.equal(child(channel, 'link').text, metadata.SITE_ORIGIN + '/');
  assert.equal(child(channel, 'description').text, metadata.HOME_DESCRIPTION);
  assert.equal(child(channel, 'language').text, 'ko-KR');
  assert.equal(child(channel, 'atom:link').attributes.href, metadata.SITE_ORIGIN + '/rss.xml');
  assert.equal(child(item, 'title').text, title);
  assert.equal(child(item, 'description').text, body);
  assert.equal(child(item, 'description').children.length, 0);
  assert.equal(child(item, 'link').text, 'https://workfolio.life/posts/public-post');
  assert.equal(child(item, 'guid').text, child(item, 'link').text);
  assert.equal(child(item, 'guid').attributes.isPermaLink, 'true');
  assert.equal(Date.parse(child(item, 'pubDate').text), createdAt);
  assert.doesNotMatch(xml, /<script>|<img|private-owner|owner_id|ignored-session|untrusted-host/);
  assert.equal(statements.length, 1);
});

test('RSS includes the latest 30 real posts in stable order and excludes stored samples', async () => {
  for (let number = 1; number <= 31; number++) seed(`post-${String(number).padStart(2, '0')}`, { createdAt: createdAt + number * 1000 });
  seed('sample-hidden', { createdAt: createdAt + 100000 });
  seed('sample-01', { createdAt: createdAt + 200000 });
  const channel = child(parse(await (await request()).text()), 'channel');
  const links = channel.children.filter(item => item.name === 'item').map(item => child(item, 'link').text);
  assert.equal(links.length, 30);
  assert.deepEqual(links, Array.from({ length: 30 }, (_, index) => `https://workfolio.life/posts/post-${String(31 - index).padStart(2, '0')}`));
  sqlite.prepare('DELETE FROM community_posts WHERE id = ?').run('post-31');
  const updated = await (await request()).text();
  assert.doesNotMatch(updated, /posts\/post-31/);
  assert.match(updated, /posts\/post-01/);
});

test('no real posts produce a valid empty RSS channel', async () => {
  seed('sample-only');
  const response = await request();
  const rss = parse(await response.text());
  assert.equal(response.status, 200);
  assert.equal(rss.name, 'rss');
  assert.equal(child(rss, 'channel').children.filter(item => item.name === 'item').length, 0);
  assert.equal(child(child(rss, 'channel'), 'title').text, metadata.HOME_TITLE);
});

test('RSS accepts GET and HEAD, rejects mutations before D1 access, and never establishes a session', async () => {
  seed('public-post');
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
    const response = await request(method);
    assert.equal(response.status, 405);
    assert.equal(response.headers.get('Allow'), 'GET, HEAD');
  }
  assert.equal(statements.length, 0);
  const get = await request();
  const head = await request('HEAD');
  assert.equal(head.status, get.status);
  assert.deepEqual([...head.headers], [...get.headers]);
  assert.equal(await head.text(), '');
  assert.equal(head.headers.get('Cache-Control'), 'no-store');
  assert.equal(head.headers.get('Set-Cookie'), null);
});

test('D1 failures return retryable noindex 503 XML without storage diagnostics', async () => {
  env.DB = { prepare() { throw new Error('private database diagnostic'); } };
  for (const method of ['GET', 'HEAD']) {
    const response = await request(method);
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('Retry-After'), '60');
    assert.equal(response.headers.get('X-Robots-Tag'), 'noindex');
    const body = await response.text();
    assert.doesNotMatch(body, /private database/);
    if (method === 'HEAD') assert.equal(body, '');
    else assert.equal(parse(body).name, 'error');
  }
});
