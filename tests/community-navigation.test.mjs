import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

function moduleUrl(path, replace = value => value) {
  const output = ts.transpileModule(readFileSync(path, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText;
  return `data:text/javascript;base64,${Buffer.from(replace(output)).toString('base64')}`;
}
const seo = moduleUrl('src/lib/community/seo.ts');
const { BOARD_PAGES } = await import(seo);
const { readFeedNavigation, feedNavigationUrl, shouldHandleFeedLink } = await import(moduleUrl(
  'src/components/community/navigation.ts', value => value.replace('../../lib/community/seo', seo),
));

test('all board selections and sorts survive refresh and back/forward URL restoration', () => {
  const start = new URL('https://workfolio.life/?source=bookmark&story=previous#old');
  for (const board of BOARD_PAGES) {
    for (const sort of ['latest', 'trending', 'popular']) {
      const url = feedNavigationUrl(start, board.category, sort);
      assert.deepEqual(readFeedNavigation(url), { topic: board.category, sort });
      assert.equal(url.searchParams.get('board'), board.slug);
      assert.equal(url.searchParams.has('story'), false);
      assert.equal(url.searchParams.get('source'), 'bookmark');
      assert.equal(url.hash, '#feed');
    }
  }
  assert.equal(start.searchParams.get('story'), 'previous', 'navigation must not mutate the previous history URL');
});

test('all-feed navigation removes a prior board and invalid URL filters use safe defaults', () => {
  const previous = new URL('https://workfolio.life/?board=salary-lupin&sort=popular&story=old');
  const all = feedNavigationUrl(previous, '전체 이야기', 'latest');
  assert.equal(all.href, 'https://workfolio.life/#feed');
  assert.deepEqual(readFeedNavigation(all), { topic: '전체 이야기', sort: 'latest' });
  assert.deepEqual(readFeedNavigation(previous), { topic: '월급루팡', sort: 'popular' });
  assert.deepEqual(readFeedNavigation(new URL('https://workfolio.life/?board=unknown&sort=invalid')), { topic: '전체 이야기', sort: 'latest' });
});

test('normal taps update the feed while modified clicks, downloads and new windows retain native links', () => {
  const plain = { defaultPrevented: false, button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false };
  assert.equal(shouldHandleFeedLink(plain), true);
  assert.equal(shouldHandleFeedLink(plain, '_self'), true);
  for (const key of ['defaultPrevented', 'metaKey', 'ctrlKey', 'shiftKey', 'altKey']) assert.equal(shouldHandleFeedLink({ ...plain, [key]: true }), false);
  assert.equal(shouldHandleFeedLink({ ...plain, button: 1 }), false);
  assert.equal(shouldHandleFeedLink(plain, '_blank'), false);
  assert.equal(shouldHandleFeedLink(plain, 'another-window'), false);
  assert.equal(shouldHandleFeedLink(plain, '', true), false);
});
