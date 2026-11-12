import type { Post } from "./domain";

const HOUR = 60 * 60 * 1000;
const TRENDING_WINDOW = 7 * 24 * HOUR;

/** The actual number of active reactions, without invented or seeded counts. */
export function engagementCount(post: Post): number {
  return post.reactions.same + post.reactions.laugh + post.reactions.cheer;
}

/**
 * Rank reader activity on real posts from the last seven days.
 * Score = (active reactions + 2 × comments) / (age in hours + 2)^1.2.
 * This is a recency-weighted popularity score, not a measured growth rate.
 * Fictional examples never enter the ranking, even if readers react to them.
 */
export function getTrendingPosts(posts: readonly Post[], now = Date.now()): Post[] {
  const score = (post: Post) =>
    (engagementCount(post) + post.commentCount * 2) /
    Math.pow((now - post.createdAt) / HOUR + 2, 1.2);

  return posts
    .filter((post) => !post.sample && Number.isFinite(post.createdAt) &&
      post.createdAt <= now && post.createdAt >= now - TRENDING_WINDOW &&
      engagementCount(post) + post.commentCount > 0)
    .sort((a, b) => score(b) - score(a) || b.createdAt - a.createdAt ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
