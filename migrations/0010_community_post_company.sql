-- Null is private, including every existing post. Later profile changes never disclose old posts.
ALTER TABLE community_posts ADD COLUMN company_name TEXT;
