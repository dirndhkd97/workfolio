import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Log, LogLevel, Miniflare } from 'miniflare';
import { splitSql } from '../scripts/release-community.mjs';

test('real workerd+D1 uses verified sessions, transactional audit, and exactly-once parallel view claims', async () => {
  const root = new URL('../', import.meta.url);
  const bundled = await build({ stdin: { contents: `
    import * as board from './functions/api/board.ts';
    import * as channels from './functions/api/channels.ts';
    import * as views from './functions/api/views.ts';
    export default { fetch(request,env) {
      const name = new URL(request.url).pathname.split('/').at(-1);
      const route = { board, channels, views }[name];
      return route[request.method === 'POST' ? 'onRequestPost' : 'onRequestGet']({request,env});
    }};
  `, resolveDir: fileURLToPath(root), loader: 'ts' }, bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022' });
  const runtime = new Miniflare({ modules: true, script: bundled.outputFiles[0].text, compatibilityDate: '2024-12-01', d1Databases: ['DB'], bindings: { COMMUNITY_MODERATOR_USER_IDS: 'platform' }, log: new Log(LogLevel.NONE), outboundService: () => new Response(null, {status: 500}) });
  try {
    const db = await runtime.getD1Database('DB');
    for (const name of ['0005_community_auth.sql','0006_community_board.sql','0008_community_session_persistence.sql','0009_community_company_verification.sql','0010_community_post_company.sql','0011_community_admin_author.sql','0012_community_post_images.sql','0014_community_boards_channels_views.sql']) await db.batch(splitSql(readFileSync(new URL(`migrations/${name}`, root), 'utf8')).map(sql => db.prepare(sql)));
    const cookies = {};
    for (const [user, char] of [['owner','a'],['platform','b'],['reader','c']]) {
      const token = char.repeat(43), hash = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))).toString('base64url');
      await db.batch([db.prepare('INSERT INTO community_users VALUES (?,?,?)').bind(user, '익명', Date.now()), db.prepare('INSERT INTO community_sessions (token_hash,user_id,created_at,expires_at) VALUES (?,?,?,?)').bind(hash, user, Date.now(), Date.now() + 3600000)]);
      cookies[user] = `__Host-community_session=${token}`;
    }
    function fetch(path, data, user, extraCookie = '') {
      return runtime.dispatchFetch(`https://workfolio.life/api/${path}`, { credentials: 'omit', method: data ? 'POST' : 'GET', headers: { Cookie: [cookies[user], extraCookie].filter(Boolean).join('; '), ...(data ? { Origin: 'https://workfolio.life', 'Content-Type': 'application/json' } : {}) }, ...(data ? {body: JSON.stringify(data)} : {}) });
    }
    const applied = await fetch('channels', {action:'request',name:'실제 런타임 채널',description:'실제 실행 환경에서 채널 생성과 검증을 확인합니다.',rules:'이 채널에서는 개인정보를 올리지 말고 서로를 존중합니다.',originalConfirmed:true}, 'owner');
    assert.equal(applied.status, 201); const channel = (await applied.json()).channel;
    assert.equal((await fetch('channels', {action:'approve',channelId:channel.id}, 'owner')).status,403);
    assert.equal((await fetch('channels', {action:'approve',channelId:channel.id}, 'platform')).status,200);
    const audit = (await db.prepare('SELECT action,actor_id,applicant_id FROM community_channel_audit ORDER BY created_at').all()).results;
    assert.equal(audit.length, 2); assert.equal(audit[1].actor_id, 'platform'); assert.equal(audit[1].applicant_id, 'owner');
    const created = await fetch('board', {action:'create',title:'실제 런타임 이야기',body:'실제 실행 환경에서 조회수가 한 번만 오르는지 확인합니다.',category:'월급루팡',channelId:channel.id,channelModerationConfirmed:true}, 'owner');
    assert.equal(created.status,201); const post = (await created.json()).post;
    const responses = await Promise.all(Array.from({length:12}, () => fetch('views', {postId:post.id}, 'reader')));
    const values = await Promise.all(responses.map(response => response.json()));
    assert.equal(values.filter(value=>value.counted).length,1);
    assert.equal((await db.prepare('SELECT view_count FROM community_posts WHERE id=?').bind(post.id).first()).view_count,1);
    const issue = await fetch('views', {postId:post.id}); assert.equal((await issue.clone().json()).retry,true);
    const viewer = issue.headers.get('Set-Cookie').split(';')[0];
    assert.equal((await (await fetch('views', {postId:post.id}, undefined, viewer)).json()).counted,true);
    assert.equal((await (await fetch('views', {postId:post.id}, 'reader', viewer)).json()).counted,false);
    const hidden = await fetch('channels', {action:'hide',channelId:channel.id,postId:post.id,note:'운영 규칙 확인을 위한 숨김입니다.'}, 'owner');
    assert.equal(hidden.status,200);
    assert.equal((await fetch(`board?id=${post.id}`)).status,404);
    assert.equal((await fetch('views',{postId:post.id},'reader')).status,404);
  } finally { await runtime.dispose(); }
});
