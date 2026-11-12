import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { runInNewContext } from 'node:vm';

const seo = `data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(readFileSync('src/lib/community/seo.ts','utf8'))).toString('base64')}`;
const sharing = stripTypeScriptTypes(readFileSync('src/lib/community/sharing.ts','utf8')).replace("'./seo'", JSON.stringify(seo));
const { postShareUrl, postShareLinks, shareWasCancelled } = await import(`data:text/javascript;base64,${Buffer.from(sharing).toString('base64')}`);

test('share links preserve Korean and reserved characters without leaking a page query or session', () => {
  const id = 'post-123';
  const title = '회의 & 사진 #1? "끝"';
  const canonical = 'https://workfolio.life/posts/post-123';
  assert.equal(postShareUrl(id), canonical);
  const links = postShareLinks(id,title).map(item => ({ ...item, url: new URL(item.href) }));
  assert.equal(links[0].url.searchParams.get('text'),title);
  assert.equal(links[0].url.searchParams.get('url'),canonical);
  assert.equal(links[1].url.searchParams.get('u'),canonical);
  assert.equal(links[2].url.searchParams.get('text'),`${title}\n${canonical}`);
  assert.equal(links[3].url.searchParams.get('text'),title);
  assert.equal(links[3].url.searchParams.get('url'),canonical);
  for(const {url} of links) { assert.equal(url.protocol,'https:'); assert.equal(url.hash,''); }
  assert.equal(postShareUrl('abc/?token=secret'), 'https://workfolio.life/posts/abc%2F%3Ftoken%3Dsecret');
});

test('cancelling a native share is distinct from permission failures', () => {
  assert.equal(shareWasCancelled(new DOMException('User cancelled','AbortError')),true);
  assert.equal(shareWasCancelled(new DOMException('Denied','NotAllowedError')),false);
  assert.equal(shareWasCancelled(undefined),false);
});

function reader(navigator) {
  const handlers = {};
  const state = { focused: false, selected: false };
  const status = { textContent:'' };
  const field = { addEventListener(){}, focus(){state.focused=true}, select(){state.selected=true} };
  const copy = { hidden:true, addEventListener(_event, callback){handlers.copy=callback} };
  const native = { hidden:true, addEventListener(_event, callback){handlers.share=callback} };
  const section = { dataset:{shareUrl:'https://workfolio.life/posts/photo-post',shareTitle:'오늘 사진'}, querySelector(selector){return ({'[data-share-status]':status,input:field,'[data-copy-share]':copy,'[data-native-share]':native})[selector]} };
  runInNewContext(readFileSync('public/community-share.js','utf8'), { document:{querySelectorAll(){return [section]}},navigator });
  return {handlers,state,status,copy,native};
}

test('reader copy reports success only after completion and offers a selectable link when denied', async () => {
  const copied=[];
  const ok=reader({clipboard:{async writeText(text){copied.push(text)}}});
  assert.equal(ok.copy.hidden,false);
  assert.equal(ok.native.hidden,true);
  await ok.handlers.copy();
  assert.deepEqual(copied,['https://workfolio.life/posts/photo-post']);
  assert.equal(ok.status.textContent,'링크를 복사했어요.');
  for(const navigator of [{}, {clipboard:{async writeText(){throw new Error('Denied')}}}]) {
    const fail=reader(navigator);
    await fail.handlers.copy();
    assert.match(fail.status.textContent,/선택해서 복사/);
    assert.equal(fail.state.focused,true);
    assert.equal(fail.state.selected,true);
  }
});

test('reader native sharing is available on capable devices and cancellation remains silent', async () => {
  const attempts=[];
  const ok=reader({async share(value){attempts.push(value)}});
  assert.equal(ok.native.hidden,false);
  await ok.handlers.share();
  assert.equal(attempts[0].url,'https://workfolio.life/posts/photo-post');
  const cancelled=reader({async share(){throw new DOMException('Cancelled','AbortError')}});
  await cancelled.handlers.share();
  assert.equal(cancelled.status.textContent,'');
  const denied=reader({async share(){throw new DOMException('Denied','NotAllowedError')}});
  await denied.handlers.share();
  assert.match(denied.status.textContent,/열지 못했어요/);
});
