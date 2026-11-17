import test from 'node:test';
import assert from 'node:assert/strict';
import { getTrendingPosts } from '../src/lib/community/feed.ts';

const hour = 60 * 60 * 1000;
const now = Date.UTC(2026, 10, 12, 9);
const post = (id, patch = {}) => ({
  id, title: '오늘의 실수', body: '오늘도 실수했지만 무사히 퇴근합니다.',
  category: '빡대가리 게시판', nickname: '익명', createdAt: now - hour,
  sample: false, likeCount: 0,
  liked: false, commentCount: 0, mine: false, ...patch,
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
    post('older', { createdAt: now - 48 * hour, likeCount: 100 }),
    post('newer', { likeCount: 6 }),
    post('conversation', { commentCount: 4 }),
  ];
  assert.deepEqual(getTrendingPosts(candidates, now).map(p => p.id), ['conversation', 'newer', 'older']);
});

test('ties are deterministic and sorting does not mutate the feed', () => {
  const candidates = [post('b', { commentCount: 1 }), post('a', { commentCount: 1 })];
  assert.deepEqual(getTrendingPosts(candidates, now).map(p => p.id), ['a', 'b']);
  assert.deepEqual(candidates.map(p => p.id), ['b', 'a']);
  assert.deepEqual(getTrendingPosts([], now), []);
});
