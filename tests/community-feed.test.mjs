import test from 'node:test';
import assert from 'node:assert/strict';
import { engagementCount, getTrendingPosts } from '../src/lib/community/feed.ts';

const hour = 60 * 60 * 1000;
const now = Date.UTC(2026, 10, 12, 9);
const post = (id, patch = {}) => ({
  id, title: '오늘의 실수', body: '오늘도 실수했지만 무사히 퇴근합니다.',
  category: '빡대가리 게시판', nickname: '익명', createdAt: now - hour,
  sample: false, reactions: { same: 0, laugh: 0, cheer: 0 },
  myReactions: [], commentCount: 0, mine: false, ...patch,
});

test('trending contains only real, recent posts with actual activity', () => {
  const candidates = [
    post('empty'),
    post('sample', { sample: true, commentCount: 900 }),
    post('old', { createdAt: now - 7 * 24 * hour - 1, commentCount: 900 }),
    post('future', { createdAt: now + 1, commentCount: 900 }),
    post('invalid', { createdAt: NaN, commentCount: 900 }),
    post('active', { commentCount: 1 }),
    post('boundary', { createdAt: now - 7 * 24 * hour, commentCount: 1 }),
  ];
  assert.deepEqual(getTrendingPosts(candidates, now).map(p => p.id), ['active', 'boundary']);
});

test('fresh activity can outrank older totals, and comments carry two points', () => {
  const candidates = [
    post('older', { createdAt: now - 48 * hour, reactions: { same: 100, laugh: 0, cheer: 0 } }),
    post('newer', { reactions: { same: 4, laugh: 1, cheer: 1 } }),
    post('conversation', { commentCount: 4 }),
  ];
  assert.equal(engagementCount(candidates[1]), 6);
  assert.deepEqual(getTrendingPosts(candidates, now).map(p => p.id), ['conversation', 'newer', 'older']);
});

test('ties are deterministic and sorting does not mutate the feed', () => {
  const candidates = [post('b', { commentCount: 1 }), post('a', { commentCount: 1 })];
  assert.deepEqual(getTrendingPosts(candidates, now).map(p => p.id), ['a', 'b']);
  assert.deepEqual(candidates.map(p => p.id), ['b', 'a']);
  assert.deepEqual(getTrendingPosts([], now), []);
});
