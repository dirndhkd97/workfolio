-- Replay receipts contain no raw SET or provider member number.
-- Short-lived subject hashes stop OAuth callbacks already in flight at unlink time.
CREATE TABLE IF NOT EXISTS community_kakao_events (
  event_hash TEXT PRIMARY KEY NOT NULL,
  subject_hash TEXT,
  occurred_before INTEGER,
  blocked_until INTEGER,
  processed_at INTEGER,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS community_kakao_events_expiry ON community_kakao_events(expires_at);
CREATE INDEX IF NOT EXISTS community_kakao_events_subject ON community_kakao_events(subject_hash, blocked_until);
