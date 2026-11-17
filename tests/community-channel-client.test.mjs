import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

function moduleUrl(path, replace = value => value) {
  const compiled = ts.transpileModule(readFileSync(path, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  return `data:text/javascript;base64,${Buffer.from(replace(compiled)).toString('base64')}`;
}
const { readChannelNavigation, channelPanelUrl, channelFeedUrl, channelApi, ChannelApiError, canManageChannel, canRestoreChannelPost } = await import(moduleUrl('src/lib/community/channel-client.ts'));
const seoUrl = moduleUrl('src/lib/community/seo.ts');
const { readFeedNavigation, feedNavigationUrl } = await import(moduleUrl('src/components/community/navigation.ts', value => value.replace('../../lib/community/seo', seoUrl)));
const plain = new URL('https://workfolio.life/?board=brain-off&source=bookmark&story=old');

test('all panel intents and owner manager survive a provider return, reload and history restoration', () => {
  for (const tab of ['browse', 'mine', 'apply', 'review']) {
    const opened = channelPanelUrl(plain, tab, tab === 'mine' ? 'owner-channel' : '');
    const returnTo = opened.pathname + opened.search + opened.hash;
    const loginUrl = new URL(`/api/community-auth/google?return_to=${encodeURIComponent(returnTo)}&remember_me=1`, opened.origin);
    const callback = new URL(loginUrl.searchParams.get('return_to'), opened.origin);
    assert.deepEqual(readChannelNavigation(callback), { tab, channelId: '', manageId: tab === 'mine' ? 'owner-channel' : '' });
    assert.deepEqual(readChannelNavigation(new URL(opened)), readChannelNavigation(callback));
    assert.equal(opened.searchParams.has('story'), false);
    assert.equal(opened.searchParams.get('source'), 'bookmark');
  }
  assert.equal(plain.searchParams.get('story'), 'old', 'earlier history remains unchanged');
});

test('repeated open, close, back and forward preserve the appropriate panel and channel context', () => {
  const channel = channelFeedUrl(plain, 'test-channel');
  const first = channelPanelUrl(channel, 'browse');
  const repeat = channelPanelUrl(first, 'browse');
  assert.equal(first.href, repeat.href, 'repeated opening need not push another history entry');
  const mine = channelPanelUrl(first, 'mine', 'test-channel');
  const closed = channelPanelUrl(mine, null);
  assert.deepEqual(readChannelNavigation(closed), { tab: null, channelId: 'test-channel', manageId: '' });
  assert.deepEqual(readChannelNavigation(new URL(first)), { tab: 'browse', channelId: 'test-channel', manageId: '' });
  assert.deepEqual(readChannelNavigation(new URL(mine)), { tab: 'mine', channelId: 'test-channel', manageId: 'test-channel' });
  const other = channelFeedUrl(mine, 'different-channel');
  assert.deepEqual(readChannelNavigation(other), { tab: null, channelId: 'different-channel', manageId: '' });
  assert.equal(other.searchParams.has('board'), false);
  assert.equal(other.searchParams.has('sort'), false);
  assert.equal(other.hash, '#feed');
});

test('channel sorts retain the selected channel and invalid query intents do not become actions', () => {
  const channel = channelFeedUrl(plain, 'test-channel');
  for (const sort of ['latest', 'popular', 'trending']) {
    const next = feedNavigationUrl(channel, '전체 이야기', sort);
    assert.equal(readChannelNavigation(next).channelId, 'test-channel');
    assert.equal(readFeedNavigation(next).sort, sort);
  }
  assert.deepEqual(readChannelNavigation(new URL('https://workfolio.life/?channels=approve&channel=https://evil.example/&manage=x')), { tab: null, channelId: '', manageId: '' });
  assert.equal(readChannelNavigation(channelPanelUrl(plain, 'review', 'admin')).manageId, '');
  assert.equal(readChannelNavigation(channelFeedUrl(plain, '../bad')).channelId, '');
});

test('old board bookmarks resolve into the three merged categories', () => {
  for (const slug of ['office-people', 'funny-mistakes', 'absurd-moments']) {
    assert.equal(readFeedNavigation(new URL(`https://workfolio.life/?board=${slug}`)).topic, '빡대가리 게시판');
  }
  assert.equal(readFeedNavigation(new URL('https://workfolio.life/?board=daily-life')).topic, '월급루팡');
  assert.equal(readFeedNavigation(new URL('https://workfolio.life/?board=quit-advice')).topic, '퇴사각 상담소');
});

test('channel mutations are sent once; failed and uncertain outcomes never automatically retry', async () => {
  const previous = globalThis.fetch;
  let calls = 0;
  try {
    globalThis.fetch = async (_url, options) => { calls++; assert.equal(options.method, 'POST'); return new Response(JSON.stringify({ error: '이미 신청했어요.' }), { status: 409 }); };
    await assert.rejects(channelApi('', { action: 'request' }), error => error instanceof ChannelApiError && error.status === 409);
    assert.equal(calls, 1);
    globalThis.fetch = async () => { calls++; throw new Error('response lost'); };
    await assert.rejects(channelApi('', { action: 'approve', channelId: 'c' }), /response lost/);
    assert.equal(calls, 2);
  } finally { globalThis.fetch = previous; }
});

test('channel reads accept cancellation without replaying a cancelled navigation', async () => {
  const previous = globalThis.fetch;
  const controller = new AbortController();
  let calls = 0;
  try {
    globalThis.fetch = async (_url, options) => {
      calls++; assert.equal(options.signal, controller.signal); assert.equal(options.cache, 'no-store');
      return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(new DOMException('Cancelled', 'AbortError')), { once: true }));
    };
    const request = channelApi('?mine=1', undefined, controller.signal);
    controller.abort();
    await assert.rejects(request, { name: 'AbortError' });
    assert.equal(calls, 1);
  } finally { globalThis.fetch = previous; }
});

test('UI keeps real channel entry points, separate authority and explicit moderation consent', () => {
  const board = readFileSync('src/components/community/Board.tsx', 'utf8');
  const panel = readFileSync('src/components/community/ChannelsPanel.tsx', 'utf8');
  const login = readFileSync('src/components/community/LoginContent.tsx', 'utf8');
  const mobileBar = board.match(/<nav className="channel-mobile-entry"[^>]*>([\s\S]*?)<\/nav>/)?.[1];
  assert.match(mobileBar, /href="\/\?channels=browse"/);
  assert.match(mobileBar, /href="\/\?channels=apply"/);
  assert.match(mobileBar, /href="#basic-boards"/);
  assert.match(board, /id="basic-boards"/);
  assert.match(board, /channel-entry-card/);
  assert.match(board, /selected-channel-context/);
  assert.match(board, /기본 게시판 3개/);
  assert.match(board, /channelModerationConfirmed:channelConsent/);
  assert.match(board, /\[shareWithChannel,setShareWithChannel\]=useState\(false\)/);
  assert.match(panel, /setModerator\(data.isModerator === true\)/);
  assert.match(panel, /channel-confirm/);
  assert.match(panel, /mutation.current/);
  assert.match(panel, /startedIn !== context.current/);
  assert.match(panel, /ownAccountId.*readOnly/s);
  assert.match(login, /encodeURIComponent\(returnTo\)/);
  assert.doesNotMatch(panel, /company.*isAdmin|isAdmin.*company/);
});


test('management UI uses explicit API authority: owner only for own active channel, moderator for any active channel', () => {
  for (const status of ['pending', 'rejected']) {
    assert.equal(canManageChannel({ status, mine: true }, false), false);
    assert.equal(canManageChannel({ status, mine: false }, true), false);
  }
  assert.equal(canManageChannel({ status: 'active', mine: true }, false), true);
  assert.equal(canManageChannel({ status: 'active', mine: false }, false), false);
  assert.equal(canManageChannel({ status: 'active', mine: false }, true), true);
  const panel = readFileSync('src/components/community/ChannelsPanel.tsx', 'utf8');
  assert.match(panel, /canManageChannel\(channel, moderator\)/);
  assert.match(panel, /운영자 관리/);
  assert.match(panel, /setModerator\(data.isModerator === true\)/);
});

test('owner cannot restore platform-hidden or unknown-scope posts; explicit platform moderator can', () => {
  assert.equal(canRestoreChannelPost({ status: 'hidden', hiddenByScope: 'channel' }, false), true);
  assert.equal(canRestoreChannelPost({ status: 'hidden', hiddenByScope: 'platform' }, false), false);
  assert.equal(canRestoreChannelPost({ status: 'hidden', hiddenByScope: null }, false), false);
  assert.equal(canRestoreChannelPost({ status: 'hidden', hiddenByScope: 'platform' }, true), true);
  assert.equal(canRestoreChannelPost({ status: 'published', hiddenByScope: null }, true), false);
  const panel = readFileSync('src/components/community/ChannelsPanel.tsx', 'utf8');
  assert.match(panel, /!canRestoreChannelPost\(post, moderator\)/);
  assert.match(panel, /channel-confirm/);
  assert.match(panel, /required=\{action.kind !== 'approve'\}/);
});
