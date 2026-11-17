import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const script = readFileSync(new URL('../public/community-views.js',import.meta.url),'utf8');
function harness(responses=[{viewCount:1,counted:true}]) {
  const events={}, timers=new Map(), calls=[], label={textContent:'조회 0'};
  let serial=0;
  const document={visibilityState:'visible',querySelector(){return {querySelector:()=>label,getAttribute:()=> 'post-1'}},addEventListener:(key,fn)=>events[key]=fn};
  vm.runInNewContext(script,{document,window:{addEventListener:(key,fn)=>events[key]=fn},AbortController,
    setTimeout(fn,delay){assert.equal(delay,1000);timers.set(++serial,fn);return serial},clearTimeout(id){timers.delete(id)},
    fetch:async(url,options)=>{calls.push({url,options});const next=responses.shift();if(next instanceof Error)throw next;return {ok:next?.ok!==false,json:async()=>next}},
  });
  return {events,timers,calls,label,document,async tick(){const batch=[...timers.values()];timers.clear();for(const fn of batch)await fn()}};
}
test('public reader waits for visible detail, issues at most one cookie-handshake retry',async()=>{
  const h=harness([{viewCount:0,retry:true},{viewCount:17,counted:true}]);assert.equal(h.calls.length,0);
  await h.tick();assert.equal(h.calls.length,2);assert.equal(h.label.textContent,'조회 17');
  for(const {url,options} of h.calls){assert.equal(url,'/api/views');assert.equal(options.method,'POST');assert.equal(options.credentials,'same-origin');assert.deepEqual(JSON.parse(options.body),{postId:'post-1'})}
  h.events.visibilitychange();await h.tick();assert.equal(h.calls.length,2);
});
test('reader hidden before dwell does not count until visible again',async()=>{
  const h=harness();h.document.visibilityState='hidden';h.events.visibilitychange();await h.tick();assert.equal(h.calls.length,0);
  h.document.visibilityState='visible';h.events.visibilitychange();await h.tick();assert.equal(h.calls.length,1);
});
test('page exit cancels pending dwell and an uncertain network request is not retried',async()=>{
  const h=harness();h.events.pagehide();await h.tick();assert.equal(h.calls.length,0);
  const failure=harness([new Error('network')]);await failure.tick();failure.events.visibilitychange();await failure.tick();assert.equal(failure.calls.length,1);assert.equal(failure.label.textContent,'조회 0');
});
test('untrusted count is ignored and repeated handshake is bounded',async()=>{
  const h=harness([{viewCount:-10,retry:true},{viewCount:'1000',retry:true},{viewCount:99}]);await h.tick();assert.equal(h.calls.length,2);assert.equal(h.label.textContent,'조회 0');
});
