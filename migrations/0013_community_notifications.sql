CREATE TABLE IF NOT EXISTS community_notifications (
  comment_id TEXT PRIMARY KEY NOT NULL REFERENCES community_comments(id) ON DELETE CASCADE,
  post_id TEXT NOT NULL REFERENCES community_posts(id) ON DELETE CASCADE,
  recipient_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  read_at INTEGER
);
CREATE INDEX IF NOT EXISTS community_notifications_inbox_idx
  ON community_notifications (recipient_id, created_at DESC, comment_id DESC);
CREATE INDEX IF NOT EXISTS community_notifications_unread_idx
  ON community_notifications (recipient_id) WHERE read_at IS NULL;
CREATE INDEX IF NOT EXISTS community_notifications_post_idx ON community_notifications (post_id);

-- A new comment and its notification commit together. Editorial samples have no post row.
CREATE TRIGGER IF NOT EXISTS community_comment_notify_author
AFTER INSERT ON community_comments
BEGIN
  INSERT INTO community_notifications (comment_id, post_id, recipient_id, created_at)
    SELECT NEW.id, p.id, p.owner_id, NEW.created_at
    FROM community_posts AS p
    WHERE p.id = NEW.post_id AND p.owner_id <> NEW.owner_id;
END;
