// Exercise the public HTML/XML routes without reading private account or session data.
import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { stripTypeScriptTypes } from 'node:module';

const root = new URL('../', import.meta.url);
const directory = mkdtempSync(join(tmpdir(), 'workfolio-seo-'));
for (const [source, target] of [
  ['src/lib/community/seo.ts', 'seo.mjs'],
  ['src/lib/community/sample-posts.ts', 'sample-posts.mjs'],
  ['functions/_lib/community-seo.ts', 'helper.mjs'],
  ['functions/posts/[id].ts', 'post.mjs'],
  ['functions/boards/[slug].ts', 'board.mjs'],
  ['functions/sitemap.xml.ts', 'index.mjs'],
  ['functions/sitemap-posts.xml.ts', 'sitemap.mjs'],
]) {
  const compiled = stripTypeScriptTypes(readFileSync(new URL(source, root), 'utf8'))
    .replace(/(['"])(?:\.\.\/)+src\/lib\/community\/seo\1/g, "'./seo.mjs'")
    .replace(/(['"])(?:\.\.\/)+src\/lib\/community\/sample-posts\1/g, "'./sample-posts.mjs'")
    .replace(/(['"])(?:\.\.\/|\.\/)\_lib\/community-seo\1/g, "'./helper.mjs'");
  writeFileSync(join(directory, target), compiled);
}
const load = (name) => import(pathToFileURL(join(directory, name)).href);
const [{ onRequest: post }, { onRequest: board }, { onRequest: index }, { onRequest: sitemap }, helpers, metadata] =
  await Promise.all(['post.mjs', 'board.mjs', 'index.mjs', 'sitemap.mjs', 'helper.mjs', 'seo.mjs'].map(load));

let sqlite;
let statements;
let env;
beforeEach(() => {
  sqlite?.close();
  sqlite = new DatabaseSync(':memory:');
  for (const file of ['0005_community_auth.sql', '0006_community_board.sql', '0009_community_company_verification.sql', '0010_community_post_company.sql', '0011_community_admin_author.sql']) {
    sqlite.exec(readFileSync(new URL(`migrations/${file}`, root), 'utf8'));
  }
  statements = [];
  function prepare(sql, bindings = []) {
    assert.match(sql, /^SELECT\b/i, 'SEO endpoints must only read D1');
    statements.push(sql);
    return {
      bind(...values) { return prepare(sql, values); },
      async first() { return sqlite.prepare(sql).get(...bindings) ?? null; },
      async all() { return { results: sqlite.prepare(sql).all(...bindings) }; },
    };
  }
  env = { DB: { prepare } };
});
after(() => { sqlite?.close(); rmSync(directory, { recursive: true, force: true }); });

const createdAt = Date.UTC(2026, 10, 12);
function seed(id, values = {}) {
  const row = { title: '퇴근 후 이야기', body: '첫 줄 이야기\n둘째 줄 이야기', category: '회사 사람들', nickname: '익명의 동료', createdAt, ...values };
  sqlite.prepare('INSERT INTO community_posts (id, owner_id, title, body, category, nickname, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, 'private-owner-never-publish', row.title, row.body, row.category, row.nickname, row.createdAt);
  return row;
}
const request = (route, path, params = {}, method = 'GET') => route({ env, params,
  request: new Request('https://workfolio.life' + path, { method, headers: { Cookie: '__Host-community_session=ignored-session', 'oai-authenticated-user-id': 'private-owner-never-publish' } }),
});
const locations = (xml) => [...xml.matchAll(/<loc>(.*?)<\/loc>/g)].map(match => match[1]);

test('reader pages display only the per-post company snapshot and escape the public label', async () => {
  seed('public-company');
  seed('private-company');
  sqlite.prepare('UPDATE community_posts SET company_name = ? WHERE id = ?').run('플랙스뉴럴랩스 <회사>', 'public-company');
  const publicHtml = await (await request(post, '/posts/public-company', { id: 'public-company' })).text();
  assert.match(publicHtml, /플랙스뉴럴랩스 &lt;회사&gt;/);
  const privateHtml = await (await request(post, '/posts/private-company', { id: 'private-company' })).text();
  assert.match(privateHtml, /회사 비공개/);
  assert.doesNotMatch(privateHtml, /플랙스뉴럴랩스|email_hash|company_id/);
});

test('article and board readers show 관리자 only for a public admin snapshot, never from the company name alone', async () => {
  const cases = [
    ['public-admin', 'Workfolio', 1, '관리자'],
    ['private-admin', null, 1, '회사 비공개'],
    ['ordinary-workfolio', 'Workfolio', 0, 'Workfolio'],
    ['ordinary-company', '플랙스뉴럴랩스', 0, '플랙스뉴럴랩스'],
  ];
  for (const [id, companyName, admin, label] of cases) {
    seed(id);
    sqlite.prepare('UPDATE community_posts SET company_name = ?, is_admin_author = ? WHERE id = ?').run(companyName,admin,id);
    const html = await (await request(post, `/posts/${id}`, {id})).text();
    const author = html.match(/<div class="reader-meta">([\s\S]*?)<\/div>/)?.[1];
    assert.ok(author, id);
    assert.ok(author.includes(label), id);
    if (label !== '관리자') assert.doesNotMatch(author,/관리자/);
    else assert.doesNotMatch(author,/>Workfolio(?:\s|·|<)/);
    assert.doesNotMatch(html,/private-owner-never-publish|workfolio\.life<\/span>|email_hash|company_id/);
  }
  const html = await (await request(board, '/boards/office-people', {slug:'office-people'})).text();
  for (const [id, , , label] of cases) {
    const card = [...html.matchAll(/<article class="reader-card reader-post-item">([\s\S]*?)<\/article>/g)].find(match=>match[1].includes(`/posts/${id}"`))?.[1];
    assert.ok(card,id);
    assert.ok(card.includes(label),id);
    if (label !== '관리자') assert.doesNotMatch(card,/관리자/);
    else assert.doesNotMatch(card,/>Workfolio(?:\s|·|<)/);
  }
  const sample = await (await request(post,'/posts/sample-01',{id:'sample-01'})).text();
  assert.doesNotMatch(sample,/관리자/);
  assert.ok(statements.every(sql=>!sql.includes('community_company_verifications')&&!sql.includes('community_users')));
});

test('post HTML contains the complete escaped discussion, metadata and real comments without private identities', async () => {
  const title = '회의 <img src=x onerror="alert(1)"> & 퇴근';
  const body = '처음부터 끝까지\n</script><script>alert("bad")</script> & 이야기\u2028';
  const nickname = '<b>우리 팀</b> & 나';
  seed('real-post', { title, body, nickname });
  sqlite.prepare('INSERT INTO community_comments VALUES (?, ?, ?, ?, ?, ?)')
    .run('comment-1', 'real-post', 'private-comment-owner', '<svg onload="alert(2)">댓글</svg>', '댓글 & 친구', createdAt + 1000);
  sqlite.prepare('INSERT INTO community_reactions VALUES (?, ?, ?, ?)').run('real-post', 'private-react-owner', 'same', 1);
  sqlite.prepare('INSERT INTO community_reactions VALUES (?, ?, ?, ?)').run('real-post', 'inactive-owner', 'laugh', 0);
  const response = await request(post, '/posts/real-post?utm_source=test', { id: 'real-post' });
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(html, /<h1[^>]*>회의 &lt;img src=x onerror=&quot;alert\(1\)&quot;&gt; &amp; 퇴근<\/h1>/);
  assert.ok(html.includes(helpers.escapeMarkup(body)));
  assert.ok(html.includes('&lt;svg onload=&quot;alert(2)&quot;&gt;댓글&lt;/svg&gt;'));
  assert.match(html, /rel="canonical" href="https:\/\/workfolio\.life\/posts\/real-post"/);
  assert.match(html, /property="og:title"/);
  assert.match(html, /href="\/\?story=real-post"/);
  assert.match(html, /공감 1/);
  assert.match(html, /댓글 1/);
  assert.doesNotMatch(html, /<script>alert|<svg onload|<img src=x/);
  assert.doesNotMatch(html, /private-owner|private-comment-owner|private-react-owner|owner_id|ignored-session/);
  const script = html.match(/<script type="application\/ld\+json">(.*?)<\/script>/s)?.[1];
  assert.ok(script);
  const data = JSON.parse(script);
  assert.equal(data['@type'], 'DiscussionForumPosting');
  assert.equal(data.headline, title);
  assert.equal(data.text, body);
  assert.equal(data.author.name, nickname);
  assert.equal(data.comment[0].text, '<svg onload="alert(2)">댓글</svg>');
  assert.equal(data.commentCount, 1);
  assert.equal(response.headers.get('Set-Cookie'), null);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.ok(statements.every(sql => !sql.includes('owner_id') && !sql.includes('community_sessions')));
});

test('fictional samples are clearly labelled and excluded from indexing and discussion structured data', async () => {
  const response = await request(post, '/posts/sample-01', { id: 'sample-01' });
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('X-Robots-Tag'), 'noindex, follow');
  assert.match(html, /\[가상 예시\]/);
  assert.match(html, /실제 이용자가 작성한 사연이 아닙니다/);
  assert.doesNotMatch(html, /DiscussionForumPosting|application\/ld\+json/);
});

test('missing pages return 404 while D1 errors return retryable noindex 503 without leaking errors', async () => {
  for (const id of ['missing', '<bad>']) {
    const response = await request(post, '/posts/' + encodeURIComponent(id), { id });
    assert.equal(response.status, 404);
    assert.match(response.headers.get('X-Robots-Tag'), /noindex/);
  }
  assert.equal((await request(board, '/boards/missing', { slug: 'missing' })).status, 404);
  env.DB = { prepare() { throw new Error('secret DB connection diagnostic'); } };
  for (const [route, path, params] of [[post, '/posts/post', { id: 'post' }], [board, '/boards/office-people', { slug: 'office-people' }], [index, '/sitemap.xml', {}], [sitemap, '/sitemap-posts.xml', {}]]) {
    const response = await request(route, path, params);
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('Retry-After'), '60');
    assert.match(response.headers.get('X-Robots-Tag'), /noindex/);
    assert.doesNotMatch(await response.text(), /secret DB/);
  }
});

test('all reader endpoints reject mutations before accessing D1 and support empty HEAD responses', async () => {
  for (const [route, path, params] of [[post, '/posts/sample-01', { id: 'sample-01' }], [board, '/boards/office-people', { slug: 'office-people' }], [index, '/sitemap.xml', {}], [sitemap, '/sitemap-posts.xml', {}]]) {
    const before = statements.length;
    const rejected = await request(route, path, params, 'POST');
    assert.equal(rejected.status, 405);
    assert.equal(rejected.headers.get('Allow'), 'GET, HEAD');
    assert.equal(statements.length, before);
    const response = await request(route, path, params, 'HEAD');
    assert.equal(response.status, 200);
    assert.equal(await response.text(), '');
    assert.equal(response.headers.get('Set-Cookie'), null);
  }
});

test('board pages expose only real category posts with crawlable links and self-canonical pagination', async () => {
  for (let number = 1; number <= 31; number++) seed(`post-${String(number).padStart(2, '0')}`, { createdAt: createdAt + number });
  seed('other-category', { category: '월급루팡' });
  seed('sample-stored');
  const first = await (await request(board, '/boards/office-people', { slug: 'office-people' })).text();
  assert.equal([...first.matchAll(/<h2><a href="\/posts\//g)].length, 30);
  assert.match(first, /href="\/posts\/post-31"/);
  assert.doesNotMatch(first, /\/posts\/(?:other-category|sample-stored|post-01)"/);
  assert.match(first, /href="\/boards\/office-people\?page=2"/);
  const second = await (await request(board, '/boards/office-people?page=2', { slug: 'office-people' })).text();
  assert.equal([...second.matchAll(/<h2><a href="\/posts\//g)].length, 1);
  assert.match(second, /href="\/posts\/post-01"/);
  assert.match(second, /rel="canonical" href="https:\/\/workfolio\.life\/boards\/office-people\?page=2"/);
  assert.match(second, /rel="prev" href="\/boards\/office-people"/);
  for (const query of ['?page=0', '?page=-1', '?page=1.5', '?page=2&page=1', '?page=3']) {
    assert.equal((await request(board, '/boards/office-people' + query, { slug: 'office-people' })).status, 404);
  }
});

test('an empty board retains its own introduction and honestly reports no user posts', async () => {
  const response = await request(board, '/boards/salary-lupin', { slug: 'salary-lupin' });
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.ok(html.includes(metadata.BOARD_PAGES.find(item => item.slug === 'salary-lupin').description));
  assert.match(html, /실제 이용자 글 0개/);
  assert.match(html, /아직 실제 이용자가 남긴 글이 없습니다/);
  assert.match(html, /href="\/\?board=salary-lupin"/);
  assert.doesNotMatch(html, /sample-|DiscussionForumPosting/);
});

test('sitemaps include each real post exactly once in 1000-post chunks and reflect deletion', async () => {
  for (let number = 1; number <= 1001; number++) seed(`post-${String(number).padStart(4, '0')}`, { createdAt: createdAt + number });
  seed('sample-stored');
  const indexXml = await (await request(index, '/sitemap.xml')).text();
  assert.deepEqual(locations(indexXml), ['https://workfolio.life/sitemap-0.xml', 'https://workfolio.life/sitemap-posts.xml?page=1', 'https://workfolio.life/sitemap-posts.xml?page=2']);
  const first = locations(await (await request(sitemap, '/sitemap-posts.xml?page=1')).text());
  const second = locations(await (await request(sitemap, '/sitemap-posts.xml?page=2')).text());
  assert.equal(first.length, 1000);
  assert.equal(second.length, 1);
  assert.equal(new Set([...first, ...second]).size, 1001);
  assert.equal(second[0], 'https://workfolio.life/posts/post-1001');
  assert.ok([...first, ...second].every(url => !/sample|login|admin|api/.test(url)));
  sqlite.prepare('DELETE FROM community_posts WHERE id = ?').run('post-0001');
  assert.equal(locations(await (await request(index, '/sitemap.xml')).text()).length, 2);
  const updated = locations(await (await request(sitemap, '/sitemap-posts.xml?page=1')).text());
  assert.equal(updated.length, 1000);
  assert.ok(!updated.includes('https://workfolio.life/posts/post-0001'));
  assert.equal((await request(sitemap, '/sitemap-posts.xml?page=2')).status, 404);
  assert.equal((await request(post, '/posts/post-0001', { id: 'post-0001' })).status, 404);
});

test('empty and invalid sitemap pages remain well formed, and markup helpers escape HTML, XML and JSON-LD', async () => {
  assert.deepEqual(locations(await (await request(index, '/sitemap.xml')).text()), ['https://workfolio.life/sitemap-0.xml']);
  assert.match(await (await request(sitemap, '/sitemap-posts.xml?page=1')).text(), /<urlset[^>]*><\/urlset>/);
  for (const query of ['?page=0', '?page=01', '?page=bad', '?page=1&page=1', '?page=2']) {
    assert.equal((await request(sitemap, '/sitemap-posts.xml' + query)).status, 404);
  }
  assert.equal(helpers.escapeMarkup('&<>"\''), '&amp;&lt;&gt;&quot;&#39;');
  const unsafe = '</script>&\u2028\u2029';
  const safe = helpers.jsonLd({ text: unsafe });
  assert.doesNotMatch(safe, /[<>&\u2028\u2029]/);
  assert.equal(JSON.parse(safe).text, unsafe);
});
