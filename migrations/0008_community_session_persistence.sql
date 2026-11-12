-- Existing 14-day cookies remain eligible for renewal; new logins choose explicitly.
ALTER TABLE community_sessions ADD COLUMN remember_me INTEGER NOT NULL DEFAULT 1 CHECK (remember_me IN (0, 1));
ALTER TABLE community_oauth_flows ADD COLUMN remember_me INTEGER NOT NULL DEFAULT 0 CHECK (remember_me IN (0, 1));
