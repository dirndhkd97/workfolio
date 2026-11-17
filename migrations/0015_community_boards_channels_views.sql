-- Additive migration. Keep all original stories, identities, images, and company snapshots.
ALTER TABLE community_posts ADD COLUMN original_category TEXT;
ALTER TABLE community_posts ADD COLUMN status TEXT NOT NULL DEFAULT 'published' CHECK (status IN ('published','hidden'));
ALTER TABLE community_posts ADD COLUMN channel_id TEXT;
ALTER TABLE community_posts ADD COLUMN hidden_by_scope TEXT CHECK (hidden_by_scope IN ('platform','channel'));
ALTER TABLE community_posts ADD COLUMN view_count INTEGER NOT NULL DEFAULT 0 CHECK (view_count >= 0);
ALTER TABLE community_reports ADD COLUMN share_with_channel INTEGER NOT NULL DEFAULT 0 CHECK (share_with_channel IN (0,1));
ALTER TABLE community_reports ADD COLUMN dismissed_at INTEGER;
ALTER TABLE community_reports ADD COLUMN channel_dismissed_at INTEGER;
-- The previously deployed app can still write legacy categories during the release.
CREATE TRIGGER IF NOT EXISTS community_posts_legacy_insert AFTER INSERT ON community_posts
WHEN NEW.original_category IS NULL
BEGIN
  UPDATE community_posts SET original_category = category, category = CASE
    WHEN category IN ('웃픈 실수','황당한 순간','회사 사람들','웃픈실수','황당한순간','회사사람들') THEN '빡대가리 게시판'
    WHEN category IN ('소소한 일상','소소한일상') THEN '월급루팡'
    ELSE category
  END
  WHERE id = NEW.id;
END;
UPDATE community_posts SET original_category = COALESCE(original_category, category), category = CASE
    WHEN category IN ('웃픈 실수','황당한 순간','회사 사람들','웃픈실수','황당한순간','회사사람들') THEN '빡대가리 게시판'
    WHEN category IN ('소소한 일상','소소한일상') THEN '월급루팡'
    ELSE category
  END
WHERE original_category IS NULL OR category IN ('웃픈 실수','황당한 순간','회사 사람들','웃픈실수','황당한순간','회사사람들','소소한 일상','소소한일상');
CREATE TABLE IF NOT EXISTS community_channels (
  id TEXT PRIMARY KEY NOT NULL,
  owner_id TEXT NOT NULL,
  name TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  description TEXT NOT NULL,
  rules TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','rejected')),
  created_at INTEGER NOT NULL,
  reviewed_at INTEGER,
  reviewed_by TEXT,
  review_note TEXT NOT NULL DEFAULT ''
);
CREATE UNIQUE INDEX IF NOT EXISTS community_channels_name ON community_channels(normalized_name) WHERE status IN ('pending','active');
CREATE UNIQUE INDEX IF NOT EXISTS community_channels_pending_owner ON community_channels(owner_id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS community_channels_owner ON community_channels(owner_id,status,created_at);
CREATE INDEX IF NOT EXISTS community_posts_visible ON community_posts(status,channel_id,created_at);
CREATE TABLE IF NOT EXISTS community_channel_audit (
  id TEXT PRIMARY KEY NOT NULL,
  channel_id TEXT NOT NULL,
  post_id TEXT,
  actor_id TEXT NOT NULL,
  applicant_id TEXT NOT NULL,
  action TEXT NOT NULL,
  previous_state TEXT,
  next_state TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS community_channel_audit_channel ON community_channel_audit(channel_id,created_at);
CREATE TABLE IF NOT EXISTS community_channel_limits (
  key TEXT PRIMARY KEY NOT NULL, window_started_at INTEGER NOT NULL, attempts INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS community_view_visitors (
  visitor_key TEXT PRIMARY KEY NOT NULL, expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS community_view_visitors_expiry ON community_view_visitors(expires_at);
CREATE TABLE IF NOT EXISTS community_view_receipts (
  post_id TEXT NOT NULL, viewer_key TEXT NOT NULL, counted_at INTEGER NOT NULL, claim_id TEXT NOT NULL,
  PRIMARY KEY(post_id,viewer_key)
);
CREATE INDEX IF NOT EXISTS community_view_receipts_expiry ON community_view_receipts(counted_at);
CREATE TABLE IF NOT EXISTS community_view_limits (
  key TEXT PRIMARY KEY NOT NULL, window_started_at INTEGER NOT NULL, attempts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS community_view_limits_expiry ON community_view_limits(window_started_at);
