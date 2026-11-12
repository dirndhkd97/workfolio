import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const output = ts.transpileModule(readFileSync('src/components/community/image-utils.ts', 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText;
const { IMAGE_LIMITS, validateImageFile, hasImageSignature, scaledImageDimensions, prepareImageUpload, uploadPostImage, deletePendingImage } = await import(`data:text/javascript;base64,${Buffer.from(output).toString('base64')}`);

const png = () => new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), 'private-exif-example'], 'photo.png', { type: 'image/png' });

test('attachment selection rejects unsupported, empty and oversized files and checks actual image signatures', () => {
  for (const type of ['image/jpeg', 'image/png', 'image/webp']) validateImageFile({ type, size: IMAGE_LIMITS.originalBytes });
  assert.throws(() => validateImageFile({ type: 'image/svg+xml', size: 10 }), /JPG/);
  assert.throws(() => validateImageFile({ type: 'image/png', size: 0 }), /빈 이미지/);
  assert.throws(() => validateImageFile({ type: 'image/png', size: IMAGE_LIMITS.originalBytes + 1 }), /10MB/);
  assert.equal(hasImageSignature(new Uint8Array([255, 216, 255]), 'image/jpeg'), true);
  assert.equal(hasImageSignature(new TextEncoder().encode('RIFF0000WEBP'), 'image/webp'), true);
  assert.equal(hasImageSignature(new TextEncoder().encode('<svg>image</svg>'), 'image/png'), false);
  assert.equal(hasImageSignature(new Uint8Array([137, 80, 78]), 'image/png'), false);
});

test('images keep their aspect ratio, never upscale and fit the 2560 pixel output boundary', () => {
  assert.deepEqual(scaledImageDimensions(6000, 4000), { width: 2560, height: 1707 });
  assert.deepEqual(scaledImageDimensions(4000, 6000), { width: 1707, height: 2560 });
  assert.deepEqual(scaledImageDimensions(640, 480), { width: 640, height: 480 });
  assert.deepEqual(scaledImageDimensions(100000, 1), { width: 2560, height: 1 });
  for (const pair of [[0, 20], [Infinity, 20], [1.2, 20], [100000, 100000]]) assert.throws(() => scaledImageDimensions(...pair), /이미지 크기/);
});

async function browserFixture(run, { webp = true, large = false } = {}) {
  const original = { Image: globalThis.Image, document: globalThis.document, fetch: globalThis.fetch };
  const calls = { encoded: [], draw: 0, fill: 0, fetch: [] };
  const context = { drawImage() { calls.draw++; }, fillRect() { calls.fill++; }, fillStyle: '' };
  const canvas = { width: 0, height: 0, getContext: () => context, toBlob(callback, type, quality) {
    calls.encoded.push({ type, quality, width: canvas.width, height: canvas.height });
    callback(new Blob([large && quality === 0.86 ? new Uint8Array(IMAGE_LIMITS.uploadBytes + 1) : 'pixels-only'], { type: type === 'image/webp' && !webp ? 'image/png' : type }));
  } };
  globalThis.Image = class {
    naturalWidth = 6000; naturalHeight = 4000;
    set src(value) { if (value) queueMicrotask(() => this.onload?.()); }
  };
  globalThis.document = { createElement(name) { assert.equal(name, 'canvas'); return canvas; } };
  try { await run(calls, canvas); }
  finally { for (const [key, value] of Object.entries(original)) if (value === undefined) delete globalThis[key]; else globalThis[key] = value; }
}

test('upload sends re-encoded pixels, never the original file or its metadata, and releases canvas storage', async () => {
  await browserFixture(async (calls, canvas) => {
    const image = { id: 'image-id', url: '/api/community-images/image-id', width: 2560, height: 1707 };
    globalThis.fetch = async (url, options) => {
      calls.fetch.push(url);
      assert.equal(url, '/api/community-images');
      assert.equal(options.method, 'POST');
      assert.equal(options.credentials, 'same-origin');
      assert.equal(options.headers['Content-Type'], 'image/webp');
      assert.equal(await options.body.text(), 'pixels-only');
      return Response.json({ image });
    };
    assert.deepEqual(await uploadPostImage(png(), new AbortController().signal), image);
    assert.deepEqual(calls.encoded, [{ type: 'image/webp', quality: 0.86, width: 2560, height: 1707 }]);
    assert.equal(canvas.width, 0); assert.equal(canvas.height, 0);
  });
});

test('browsers without WebP encoding use a fresh JPEG and large output is reduced before upload', async () => {
  await browserFixture(async calls => {
    const output = await prepareImageUpload(png(), new AbortController().signal);
    assert.equal(output.type, 'image/jpeg');
    assert.equal(calls.fill, 1);
    assert.deepEqual(calls.encoded.map(call => call.type), ['image/webp', 'image/jpeg']);
  }, { webp: false });
  await browserFixture(async calls => {
    const output = await prepareImageUpload(png(), new AbortController().signal);
    assert.ok(output.size <= IMAGE_LIMITS.uploadBytes);
    assert.deepEqual(calls.encoded.map(call => call.quality), [0.86, 0.72]);
  }, { large: true });
});

test('cancelled or mismatched-image requests never reach the upload API', async () => {
  await browserFixture(async () => {
    globalThis.fetch = () => assert.fail('invalid/cancelled file must not be uploaded');
    const controller = new AbortController(); controller.abort();
    await assert.rejects(() => uploadPostImage(png(), controller.signal), { name: 'AbortError' });
    const fake = new File(['<svg>image</svg>'], 'fake.png', { type: 'image/png' });
    await assert.rejects(() => uploadPostImage(fake, new AbortController().signal), /파일 형식/);
  });
});

test('pending-image removal sends a same-origin JSON DELETE and respects already-published rejections', async () => {
  await browserFixture(async () => {
    const image = { id: 'pending-id', url: '/api/community-images/pending-id', width: 10, height: 10 };
    globalThis.fetch = async (url, options) => {
      assert.equal(url, '/api/community-images/pending-id');
      assert.equal(options.method, 'DELETE'); assert.equal(options.headers['Content-Type'], 'application/json');
      assert.equal(options.body, '{}'); assert.equal(options.credentials, 'same-origin');
      return new Response(null, { status: 404 });
    };
    await deletePendingImage(image);
    globalThis.fetch = async () => Response.json({ error: '게시된 이미지예요.' }, { status: 409 });
    await assert.rejects(() => deletePendingImage(image), /게시된 이미지/);
  });
});
