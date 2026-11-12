-- Only operator-reviewed company names and exact email domains may certify a company.
CREATE TABLE community_companies (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL
);
CREATE TABLE community_company_domains (
  domain TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES community_companies(id) ON DELETE CASCADE
);
INSERT INTO community_companies (id, name) VALUES ('workfolio', 'Workfolio');
INSERT INTO community_company_domains (domain, company_id) VALUES ('workfolio.life', 'workfolio');
-- Company/domain pairing provided by the site operator.
INSERT INTO community_companies (id, name) VALUES ('plax-neural-labs', '플랙스뉴럴랩스');
INSERT INTO community_company_domains (domain, company_id) VALUES ('letsplax.com', 'plax-neural-labs');
-- After independently reviewing ownership, operators can register another company:
-- INSERT INTO community_companies (id, name) VALUES ('example-company', 'Example 회사');
-- INSERT INTO community_company_domains (domain, company_id) VALUES ('example.com', 'example-company');

CREATE TABLE community_company_verifications (
  user_id TEXT PRIMARY KEY REFERENCES community_users(id) ON DELETE CASCADE,
  company_id TEXT NOT NULL REFERENCES community_companies(id),
  email_hash TEXT NOT NULL,
  verified_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

-- Retain request metadata for one hour for per-account and per-mailbox limits.
-- Email addresses and plaintext codes are never persisted.
CREATE TABLE community_company_challenges (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES community_users(id) ON DELETE CASCADE,
  company_id TEXT NOT NULL REFERENCES community_companies(id),
  domain TEXT NOT NULL,
  email_hash TEXT NOT NULL,
  code_hash TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK (status IN ('pending', 'sent', 'failed', 'cancelled', 'used')),
  claim_token TEXT
);
CREATE INDEX community_company_requests_user ON community_company_challenges(user_id, created_at);
CREATE INDEX community_company_requests_email ON community_company_challenges(email_hash, created_at);
