-- Community data is isolated from the existing customer and billing tables.
CREATE TABLE IF NOT EXISTS community_posts (
  id TEXT PRIMARY KEY NOT NULL,
  owner_id TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  category TEXT NOT NULL,
  nickname TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS community_posts_created_at_idx ON community_posts (created_at);

-- post_id may also refer to a labelled editorial example (sample-01 ... sample-06).
CREATE TABLE IF NOT EXISTS community_comments (
  id TEXT PRIMARY KEY NOT NULL,
  post_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  body TEXT NOT NULL,
  nickname TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS community_comments_post_idx ON community_comments (post_id, created_at);

CREATE TABLE IF NOT EXISTS community_reactions (
  post_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  reaction TEXT NOT NULL CHECK (reaction IN ('same', 'laugh', 'cheer')),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  PRIMARY KEY (post_id, owner_id, reaction)
);

CREATE TABLE IF NOT EXISTS community_reports (
  post_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (post_id, owner_id)
);

CREATE TABLE IF NOT EXISTS community_write_limits (
  owner_id TEXT PRIMARY KEY NOT NULL,
  window_started_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL
);
