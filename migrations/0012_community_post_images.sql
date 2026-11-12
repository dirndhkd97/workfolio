-- Uploads remain owner-only until atomically attached to a published post.
CREATE TABLE IF NOT EXISTS community_post_images (
  id TEXT PRIMARY KEY NOT NULL,
  owner_id TEXT NOT NULL,
  object_key TEXT NOT NULL UNIQUE,
  post_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('uploading', 'pending', 'attached', 'deleted')),
  position INTEGER NOT NULL DEFAULT 0,
  content_type TEXT NOT NULL CHECK (content_type IN ('image/jpeg', 'image/png', 'image/webp')),
  byte_size INTEGER NOT NULL,
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS community_post_images_post ON community_post_images(post_id, status, position);
CREATE INDEX IF NOT EXISTS community_post_images_owner ON community_post_images(owner_id, status, expires_at);
CREATE INDEX IF NOT EXISTS community_post_images_expiry ON community_post_images(status, expires_at);
CREATE TABLE IF NOT EXISTS community_image_upload_limits (
  owner_id TEXT PRIMARY KEY NOT NULL,
  window_started_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL
);
