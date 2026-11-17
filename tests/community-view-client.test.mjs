import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
const source = ts.transpileModule(readFileSync('src/lib/community/view-client.ts', 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
const { recordView, watchVisibleView } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const response = data => new Response(JSON.stringify(data));
class Visibility extends EventTarget {
  visibilityState = 'visible';
  set(value) { this.visibilityState = value; this.dispatchEvent(new Event('visibilitychange')); }
}

test('view counting uses POST, only one successful cookie-handshake retry, and same-origin credentials', async () => {
  const calls = [];
  const result = await recordView('post-1', new AbortController().signal, async (url, options) => {
    calls.push({ url, options });
    return response(calls.length === 1 ? { viewCount: 7, counted: false, retry: true } : { viewCount: 8, counted: true, retry: false });
  });
  assert.deepEqual(result, { viewCount: 8, counted: true, retry: false });
  assert.equal(calls.length, 2);
  for (const { url, options } of calls) {
    assert.equal(url, '/api/views'); assert.equal(options.method, 'POST'); assert.equal(options.credentials, 'same-origin');
    assert.deepEqual(JSON.parse(options.body), { postId: 'post-1' });
  }
});

test('a blocked cookie handshake has a strict two-request maximum', async () => {
  let calls = 0;
  assert.equal(await recordView('post-1', new AbortController().signal, async () => { calls++; return response({ viewCount: 7, counted: false, retry: true }); }), null);
  assert.equal(calls, 2);
});

test('HTTP failures, network uncertainty and aborts do not retry view mutations', async () => {
  let calls = 0;
  assert.equal(await recordView('post-1', new AbortController().signal, async () => { calls++; return new Response('{}', { status: 503 }); }), null);
  assert.equal(calls, 1);
  await assert.rejects(recordView('post-1', new AbortController().signal, async () => { calls++; throw new Error('lost response'); }), /lost response/);
  assert.equal(calls, 2);
  const controller = new AbortController(); controller.abort();
  assert.equal(await recordView('post-1', controller.signal, async () => { calls++; }), null);
  assert.equal(calls, 2);
});

test('default viewing threshold is one uninterrupted visible second', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const document = new Visibility(); let calls = 0;
  const stop = watchVisibleView('post-1', () => {}, { document, fetcher: async () => { calls++; return response({ viewCount: 1, counted: true }); } });
  t.mock.timers.tick(999); assert.equal(calls, 0);
  t.mock.timers.tick(1); assert.equal(calls, 1);
  stop();
});

test('closing or navigating before the threshold never records the abandoned detail', async () => {
  const document = new Visibility(); let calls = 0;
  const stop = watchVisibleView('abandoned', () => assert.fail('stale result'), { document, delayMs: 20, fetcher: async () => { calls++; return response({ viewCount: 1, counted: true }); } });
  stop(); await delay(40); assert.equal(calls, 0);
});

test('hidden tabs cancel the timer and require a fresh continuous visible interval', async () => {
  const document = new Visibility(); let calls = 0, results = [];
  const stop = watchVisibleView('post-1', value => results.push(value), { document, delayMs: 25, fetcher: async () => { calls++; return response({ viewCount: 9, counted: true }); } });
  document.set('hidden'); await delay(35); assert.equal(calls, 0);
  document.set('visible'); await delay(10); assert.equal(calls, 0);
  await delay(40); assert.equal(calls, 1); assert.equal(results[0].viewCount, 9);
  document.set('hidden'); document.set('visible'); await delay(40); assert.equal(calls, 1);
  stop();
});

test('visibility loss aborts an in-flight handshake and does not issue a stale retry', async () => {
  const document = new Visibility(); let calls = 0, signal, complete;
  const stop = watchVisibleView('post-1', () => assert.fail('stale callback'), { document, delayMs: 0, fetcher: async (_url, options) => {
    calls++; signal = options.signal;
    return new Promise(resolve => { complete = () => resolve(response({ viewCount: 1, counted: false, retry: true })); });
  } });
  await delay(10); assert.equal(calls, 1);
  document.set('hidden'); assert.equal(signal.aborted, true); complete(); await delay(10);
  assert.equal(calls, 1); stop();
});

test('close after sending aborts the request and ignores late results', async () => {
  const document = new Visibility(); let signal, complete;
  const stop = watchVisibleView('post-1', () => assert.fail('closed detail updated'), { document, delayMs: 0, fetcher: async (_url, options) => {
    signal = options.signal; return new Promise(resolve => { complete = () => resolve(response({ viewCount: 1, counted: true })); });
  } });
  await delay(10); stop(); assert.equal(signal.aborted, true); complete(); await delay(10);
});
