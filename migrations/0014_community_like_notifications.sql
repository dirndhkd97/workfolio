CREATE TABLE IF NOT EXISTS community_like_notifications (
  id TEXT PRIMARY KEY NOT NULL,
  post_id TEXT NOT NULL REFERENCES community_posts(id) ON DELETE CASCADE,
  recipient_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  read_at INTEGER,
  like_count INTEGER NOT NULL DEFAULT 0 CHECK (like_count >= 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS community_like_notifications_open_idx
  ON community_like_notifications (post_id) WHERE read_at IS NULL;
CREATE INDEX IF NOT EXISTS community_like_notifications_post_read_idx
  ON community_like_notifications (post_id, read_at);
CREATE INDEX IF NOT EXISTS community_like_notifications_inbox_idx
  ON community_like_notifications (recipient_id, created_at DESC, id DESC) WHERE like_count > 0;
CREATE INDEX IF NOT EXISTS community_like_notifications_unread_idx
  ON community_like_notifications (recipient_id) WHERE read_at IS NULL AND like_count > 0;

CREATE TABLE IF NOT EXISTS community_like_notification_members (
  notification_id TEXT NOT NULL REFERENCES community_like_notifications(id) ON DELETE CASCADE,
  actor_id TEXT NOT NULL,
  added_at INTEGER NOT NULL,
  PRIMARY KEY (notification_id, actor_id)
);

CREATE TRIGGER IF NOT EXISTS community_like_notification_member_added
AFTER INSERT ON community_like_notification_members
BEGIN
  UPDATE community_like_notifications
    SET like_count = like_count + 1, created_at = MAX(created_at, NEW.added_at)
    WHERE id = NEW.notification_id;
END;

CREATE TRIGGER IF NOT EXISTS community_like_notification_member_removed
AFTER DELETE ON community_like_notification_members
BEGIN
  UPDATE community_like_notifications SET like_count = like_count - 1 WHERE id = OLD.notification_id;
  -- A read group with zero likes stays hidden and can absorb another like on the same day.
  DELETE FROM community_like_notifications WHERE id = OLD.notification_id AND like_count = 0 AND read_at IS NULL;
END;
