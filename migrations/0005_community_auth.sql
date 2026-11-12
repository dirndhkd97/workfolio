-- Community accounts intentionally do not trust or share legacy email-code sessions.
CREATE TABLE IF NOT EXISTS community_users (
  id TEXT PRIMARY KEY,
  nickname TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS community_accounts (
  provider TEXT NOT NULL CHECK (provider IN ('kakao', 'naver', 'google', 'apple')),
  subject TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES community_users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (provider, subject)
);
CREATE INDEX IF NOT EXISTS community_accounts_user ON community_accounts(user_id);

CREATE TABLE IF NOT EXISTS community_sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES community_users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS community_sessions_expiry ON community_sessions(expires_at);

CREATE TABLE IF NOT EXISTS community_oauth_flows (
  state_hash TEXT PRIMARY KEY,
  provider TEXT NOT NULL CHECK (provider IN ('kakao', 'naver', 'google', 'apple')),
  browser_hash TEXT NOT NULL,
  nonce TEXT NOT NULL,
  code_verifier TEXT,
  redirect_uri TEXT NOT NULL,
  return_to TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS community_oauth_expiry ON community_oauth_flows(expires_at);
