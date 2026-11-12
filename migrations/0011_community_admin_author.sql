-- Keep the exact verified mailbox domain; unproven legacy proofs remain unknown.
ALTER TABLE community_company_verifications ADD COLUMN domain TEXT;

-- Display-only snapshot, set only when the author explicitly shares their verified company.
-- Existing posts stay unlabelled, and private posts never reveal this flag through public responses.
ALTER TABLE community_posts ADD COLUMN is_admin_author INTEGER NOT NULL DEFAULT 0 CHECK (is_admin_author IN (0, 1));

-- Recover a recent legacy proof only from its successfully consumed email challenge.
-- Conflicting or absent evidence stays unknown; company IDs/names alone prove no mailbox domain.
WITH proven_company_domains AS (
  SELECT v.user_id, MIN(c.domain) AS domain
  FROM community_company_verifications AS v
  JOIN community_company_challenges AS c
    ON c.user_id = v.user_id AND c.company_id = v.company_id AND c.email_hash = v.email_hash
  WHERE v.domain IS NULL AND c.status = 'used'
    AND c.created_at <= v.verified_at AND v.verified_at < c.expires_at
  GROUP BY v.user_id
  HAVING COUNT(DISTINCT c.domain) = 1
)
UPDATE community_company_verifications
SET domain = (SELECT domain FROM proven_company_domains WHERE user_id = community_company_verifications.user_id)
WHERE domain IS NULL AND user_id IN (SELECT user_id FROM proven_company_domains);
