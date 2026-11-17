#!/usr/bin/env node
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const ACCOUNT = 'ae40d286be880d4faf549a14530875dc';
const DATABASE = '070de128-ce30-40d1-9ba2-bc00e08cc073';
const PROJECT = 'workfolio';
const TABLES = ['community_users', 'community_accounts', 'community_sessions', 'community_oauth_flows', 'community_posts', 'community_comments', 'community_reactions', 'community_reports', 'community_kakao_events', 'community_companies', 'community_company_domains', 'community_company_verifications', 'community_company_challenges', 'community_post_images', 'community_image_upload_limits', 'community_channels', 'community_channel_audit', 'community_channel_limits', 'community_view_visitors', 'community_view_receipts', 'community_view_limits',
  'community_notifications', 'community_like_notifications', 'community_like_notification_members'];
const REQUIRED = {
  community_sessions: ['token_hash', 'user_id', 'created_at', 'expires_at', 'remember_me'],
  community_oauth_flows: ['state_hash', 'provider', 'browser_hash', 'nonce', 'code_verifier', 'redirect_uri', 'return_to', 'expires_at', 'remember_me'],
  community_posts: ['id', 'owner_id', 'title', 'body', 'category', 'nickname', 'created_at', 'company_name', 'is_admin_author', 'original_category', 'status', 'channel_id', 'hidden_by_scope', 'view_count'],
  community_companies: ['id', 'name'],
  community_company_domains: ['domain', 'company_id'],
  community_company_verifications: ['user_id', 'company_id', 'email_hash', 'verified_at', 'expires_at', 'domain'],
  community_company_challenges: ['id', 'user_id', 'company_id', 'domain', 'email_hash', 'code_hash', 'created_at', 'expires_at', 'attempts', 'status', 'claim_token'],
  community_post_images: ['id', 'owner_id', 'object_key', 'post_id', 'status', 'position', 'content_type', 'byte_size', 'width', 'height', 'created_at', 'expires_at'],
  community_image_upload_limits: ['owner_id', 'window_started_at', 'attempts'],
  community_reports: ['post_id', 'owner_id', 'reason', 'created_at', 'share_with_channel', 'dismissed_at', 'channel_dismissed_at'],
  community_notifications: ['comment_id', 'post_id', 'recipient_id', 'created_at', 'read_at'],
  community_like_notifications: ['id', 'post_id', 'recipient_id', 'created_at', 'read_at', 'like_count'],
  community_like_notification_members: ['notification_id', 'actor_id', 'added_at'],
  community_channels: ['id', 'owner_id', 'name', 'normalized_name', 'description', 'rules', 'status', 'created_at', 'reviewed_at', 'reviewed_by', 'review_note'],
  community_channel_audit: ['id', 'channel_id', 'post_id', 'actor_id', 'applicant_id', 'action', 'previous_state', 'next_state', 'note', 'created_at'],
  community_channel_limits: ['key', 'window_started_at', 'attempts'],
  community_view_visitors: ['visitor_key', 'expires_at'],
  community_view_receipts: ['post_id', 'viewer_key', 'counted_at', 'claim_id'],
  community_view_limits: ['key', 'window_started_at', 'attempts'],
};
// Exact reviewed data updates accepted alongside additive schema migrations.
const VERIFIED_DOMAIN_BACKFILL = `WITH proven_company_domains AS (
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
WHERE domain IS NULL AND user_id IN (SELECT user_id FROM proven_company_domains)`;

// These files contain ordinary SQL and line comments. Preserve semicolons inside quoted names.
export function splitSql(sql) {
  const statements = [];
  let statement = '', quote = null, comment = false;
  for (let i = 0; i < sql.length; i++) {
    const char = sql[i];
    if (comment) { if (char === '\n') { comment = false; statement += '\n'; } continue; }
    if (quote) {
      statement += char;
      if (char === quote) {
        if (sql[i + 1] === quote) statement += sql[++i];
        else quote = null;
      }
    } else if (char === '-' && sql[i + 1] === '-') { comment = true; i++; }
    else if (char === "'" || char === '"') { quote = char; statement += char; }
    else if (char === ';') {
      // SQLite trigger bodies terminate their inner statements before the final END.
      if (/^\s*CREATE TRIGGER\b/i.test(statement) && !/;\s*END\s*$/i.test(statement)) statement += char;
      else { if (statement.trim()) statements.push(statement.trim()); statement = ''; }
    }
    else statement += char;
  }
  if (quote) throw new Error('Unterminated SQL literal in release file.');
  if (statement.trim()) statements.push(statement.trim());
  return statements;
}

export function repeatableCompanySql(sql) {
  return splitSql(sql).map(statement => {
    if (/^CREATE (TABLE|INDEX)\b/i.test(statement)) return statement.replace(/^CREATE (TABLE|INDEX) (?!IF NOT EXISTS\b)/i, 'CREATE $1 IF NOT EXISTS ');
    if (/^INSERT INTO community_(companies|company_domains)\b/i.test(statement)) return `${statement} ON CONFLICT DO NOTHING`;
    throw new Error('Unexpected statement in company schema migration.');
  });
}

export function checkProject(project) {
  if (project.name !== PROJECT || project.production_branch !== 'main') throw new Error('Pages project or production branch does not match workfolio/main.');
  const production = project.deployment_configs?.production;
  const mail = production?.env_vars?.MAILGUN_API_KEY;
  const configured = mail?.type === 'secret_text' || (mail?.type === 'plain_text' && typeof mail.value === 'string' && mail.value.trim().length > 0);
  if (!configured) throw new Error('Production MAILGUN_API_KEY is missing. No schema changes or deployment were performed.');
  if (production?.d1_databases?.DB?.id !== DATABASE) throw new Error('Production DB binding does not match the expected D1 database.');
  const moderators = production?.env_vars?.COMMUNITY_MODERATOR_USER_IDS;
  const communityModeratorConfigured = moderators?.type === 'secret_text' || (moderators?.type === 'plain_text' && typeof moderators.value === 'string' && moderators.value.trim().length > 0);
  return { project: PROJECT, productionBranch: 'main', mailgunConfigured: true, databaseBindingMatches: true, communityModeratorConfigured };
}

export async function inspectDatabase(query) {
  const existing = new Set((await query("SELECT name FROM sqlite_master WHERE type = 'table'"))[0].results.map(row => row.name));
  const schema = {}, counts = {};
  for (const table of TABLES.filter(table => existing.has(table))) {
    schema[table] = (await query(`PRAGMA table_info(${table})`))[0].results.map(row => ({ name: row.name, type: row.type }));
    counts[table] = (await query(`SELECT COUNT(*) AS count FROM ${table}`))[0].results[0].count;
  }
  return { schema, counts };
}

const BOARD_ALTERS = new Set([
  "ALTER TABLE community_posts ADD COLUMN original_category TEXT",
  "ALTER TABLE community_posts ADD COLUMN status TEXT NOT NULL DEFAULT 'published' CHECK (status IN ('published','hidden'))",
  "ALTER TABLE community_posts ADD COLUMN channel_id TEXT",
  "ALTER TABLE community_posts ADD COLUMN hidden_by_scope TEXT CHECK (hidden_by_scope IN ('platform','channel'))",
  "ALTER TABLE community_posts ADD COLUMN view_count INTEGER NOT NULL DEFAULT 0 CHECK (view_count >= 0)",
  "ALTER TABLE community_reports ADD COLUMN share_with_channel INTEGER NOT NULL DEFAULT 0 CHECK (share_with_channel IN (0,1))",
  "ALTER TABLE community_reports ADD COLUMN dismissed_at INTEGER",
  "ALTER TABLE community_reports ADD COLUMN channel_dismissed_at INTEGER",
]);
const BOARD_UPDATES = new Set([
  "UPDATE community_posts SET original_category = COALESCE(original_category, category), category = CASE WHEN category IN ('웃픈 실수','황당한 순간','회사 사람들','웃픈실수','황당한순간','회사사람들') THEN '빡대가리 게시판' WHEN category IN ('소소한 일상','소소한일상') THEN '월급루팡' ELSE category END WHERE original_category IS NULL OR category IN ('웃픈 실수','황당한 순간','회사 사람들','웃픈실수','황당한순간','회사사람들','소소한 일상','소소한일상')",
]);
const BOARD_CREATES = new Set([
  "CREATE TRIGGER IF NOT EXISTS community_posts_legacy_insert AFTER INSERT ON community_posts WHEN NEW.original_category IS NULL BEGIN UPDATE community_posts SET original_category = category, category = CASE WHEN category IN ('웃픈 실수','황당한 순간','회사 사람들','웃픈실수','황당한순간','회사사람들') THEN '빡대가리 게시판' WHEN category IN ('소소한 일상','소소한일상') THEN '월급루팡' ELSE category END WHERE id = NEW.id; END",
  "CREATE TABLE IF NOT EXISTS community_channels ( id TEXT PRIMARY KEY NOT NULL, owner_id TEXT NOT NULL, name TEXT NOT NULL, normalized_name TEXT NOT NULL, description TEXT NOT NULL, rules TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','rejected')), created_at INTEGER NOT NULL, reviewed_at INTEGER, reviewed_by TEXT, review_note TEXT NOT NULL DEFAULT '' )",
  "CREATE UNIQUE INDEX IF NOT EXISTS community_channels_name ON community_channels(normalized_name) WHERE status IN ('pending','active')",
  "CREATE UNIQUE INDEX IF NOT EXISTS community_channels_pending_owner ON community_channels(owner_id) WHERE status = 'pending'",
  "CREATE INDEX IF NOT EXISTS community_channels_owner ON community_channels(owner_id,status,created_at)",
  "CREATE INDEX IF NOT EXISTS community_posts_visible ON community_posts(status,channel_id,created_at)",
  "CREATE TABLE IF NOT EXISTS community_channel_audit ( id TEXT PRIMARY KEY NOT NULL, channel_id TEXT NOT NULL, post_id TEXT, actor_id TEXT NOT NULL, applicant_id TEXT NOT NULL, action TEXT NOT NULL, previous_state TEXT, next_state TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL )",
  "CREATE INDEX IF NOT EXISTS community_channel_audit_channel ON community_channel_audit(channel_id,created_at)",
  "CREATE TABLE IF NOT EXISTS community_channel_limits ( key TEXT PRIMARY KEY NOT NULL, window_started_at INTEGER NOT NULL, attempts INTEGER NOT NULL )",
  "CREATE TABLE IF NOT EXISTS community_view_visitors ( visitor_key TEXT PRIMARY KEY NOT NULL, expires_at INTEGER NOT NULL )",
  "CREATE INDEX IF NOT EXISTS community_view_visitors_expiry ON community_view_visitors(expires_at)",
  "CREATE TABLE IF NOT EXISTS community_view_receipts ( post_id TEXT NOT NULL, viewer_key TEXT NOT NULL, counted_at INTEGER NOT NULL, claim_id TEXT NOT NULL, PRIMARY KEY(post_id,viewer_key) )",
  "CREATE INDEX IF NOT EXISTS community_view_receipts_expiry ON community_view_receipts(counted_at)",
  "CREATE TABLE IF NOT EXISTS community_view_limits ( key TEXT PRIMARY KEY NOT NULL, window_started_at INTEGER NOT NULL, attempts INTEGER NOT NULL )",
  "CREATE INDEX IF NOT EXISTS community_view_limits_expiry ON community_view_limits(window_started_at)"
]);
export async function applyBoardSchema(query, sql) {
  const statements = splitSql(sql);
  // Validate the complete migration before the first write. No arbitrary UPDATE or destructive SQL.
  for (const statement of statements) {
    const normalized = statement.replace(/\s+/g, ' ');
    if (!BOARD_ALTERS.has(normalized) && !BOARD_UPDATES.has(normalized)
        && !BOARD_CREATES.has(normalized)) throw new Error('Unexpected statement in board/channel migration.');
  }
  const before = (await query('SELECT COUNT(*) AS count FROM community_posts'))[0].results[0].count;
  for (const statement of statements) {
    const alter = /^ALTER TABLE (community_posts|community_reports) ADD COLUMN (\w+)\b/.exec(statement);
    if (alter) {
      const columns = (await query(`PRAGMA table_info(${alter[1]})`))[0].results;
      if (columns.some(row => row.name === alter[2])) continue;
    }
    await query(statement);
  }
  const after = (await query('SELECT COUNT(*) AS count FROM community_posts'))[0].results[0].count;
  if (after < before) throw new Error('Community post count decreased during migration; investigate before deploying.');
  const legacy = (await query("SELECT COUNT(*) AS count FROM community_posts WHERE category IN ('웃픈 실수','황당한 순간','회사 사람들','웃픈실수','황당한순간','회사사람들','소소한 일상','소소한일상') OR original_category IS NULL"))[0].results[0].count;
  if (legacy) throw new Error('Community category backfill is incomplete.');
}

export async function applySchema(query, readMigration = name => readFile(`migrations/${name}`, 'utf8')) {
  for (const name of ['0005_community_auth.sql', '0006_community_board.sql', '0007_community_kakao_events.sql']) await query(await readMigration(name));
  await query(repeatableCompanySql(await readMigration('0009_community_company_verification.sql')).join(';\n'));
  for (const name of ['0008_community_session_persistence.sql', '0010_community_post_company.sql', '0011_community_admin_author.sql']) {
    for (const statement of splitSql(await readMigration(name))) {
      if (name === '0011_community_admin_author.sql' && statement.replace(/\s+/g, ' ') === VERIFIED_DOMAIN_BACKFILL.replace(/\s+/g, ' ')) {
        await query(statement);
        continue;
      }
      const match = /^ALTER TABLE (community_sessions|community_oauth_flows|community_posts|community_company_verifications) ADD COLUMN (remember_me|company_name|is_admin_author|domain)\b/.exec(statement);
      if (!match) throw new Error('Unexpected statement in additive migration.');
      const columns = (await query(`PRAGMA table_info(${match[1]})`))[0].results;
      if (!columns.some(row => row.name === match[2])) await query(statement);
    }
  }
  await query(await readMigration('0012_community_post_images.sql'));
  await query(await readMigration('0013_community_notifications.sql'));
  await query(await readMigration('0014_community_like_notifications.sql'));
  await applyBoardSchema(query, await readMigration('0015_community_boards_channels_views.sql'));
  // These six posts predate the view counter. The historical additions are estimates
  // based on their existing likes and comments; they do not generate viewer receipts.
  await query(`WITH historical(post_id, estimated_views) AS (VALUES
      ('aedf2a94-57c0-4cb4-82b9-370022e18489', 3),
      ('6f874603-b185-4ad1-b3f2-d247afb22ce2', 3),
      ('37fee88b-3b70-427a-b3bc-bcccbd3c17dd', 3),
      ('b7fdd71c-6c5f-4a4d-b12c-2ee161d4d5f9', 3),
      ('ba7e48a4-d7b2-45e0-a8c8-98ba9fcf9139', 4),
      ('f7e95ff5-17d0-4948-b8a4-e68af53f22bd', 6)
    )
    UPDATE community_posts SET view_count = MIN(6, community_posts.view_count + historical.estimated_views)
    FROM historical WHERE community_posts.id = historical.post_id
      AND community_posts.created_at < unixepoch('2026-11-17T01:29:43Z') * 1000
      AND community_posts.view_count < 3`);
  for (const [table, required] of Object.entries(REQUIRED)) {
    const columns = (await query(`PRAGMA table_info(${table})`))[0].results.map(row => row.name);
    if (required.some(column => !columns.includes(column))) throw new Error(`Required columns missing in ${table}.`);
  }
}

function registryStatements(sql) {
  const statements = splitSql(sql);
  if (!statements.length) throw new Error('Reviewed production company registry is empty.');
  if (statements.some(statement => !/^INSERT INTO community_(companies|company_domains)\b/i.test(statement) || !/ON CONFLICT(?:\(\w+\))? DO NOTHING$/i.test(statement))) {
    throw new Error('Production registry must contain only additive company/domain inserts preserving existing mappings.');
  }
  return statements;
}

export async function importRegistry(query, sql) {
  const statements = registryStatements(sql);
  for (let i = 0; i < statements.length; i += 25) await query(statements.slice(i, i + 25).join(';\n'));
  return statements.length;
}

async function saveReport(name, report) {
  await mkdir('work/release', { recursive: true });
  await writeFile(`work/release/${name}.json`, JSON.stringify(report, null, 2) + '\n');
}

export async function main(mode = process.argv[2]) {
  if (!['--preflight', '--apply'].includes(mode)) throw new Error('Usage: node scripts/release-community.mjs --preflight|--apply');
  const token = process.env.CLOUDFLARE_API_TOKEN?.trim();
  const account = process.env.CLOUDFLARE_ACCOUNT_ID || ACCOUNT;
  if (!token) throw new Error('CLOUDFLARE_API_TOKEN is required.');
  if (account !== ACCOUNT) throw new Error('Cloudflare account does not match the release target.');
  async function api(path, body) {
    let response, data;
    try {
      response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}${path}`, {
        method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}), redirect: 'error', signal: AbortSignal.timeout(60000),
      });
      data = await response.json();
    } catch { throw new Error('Cloudflare release API request failed; no response values were logged.'); }
    if (!response.ok || !data.success) throw new Error(`Cloudflare release API rejected the request (HTTP ${response.status}, codes ${(data.errors || []).map(error => Number(error.code)).join(',')}).`);
    return data.result;
  }
  const query = async sql => {
    const results = await api(`/d1/database/${DATABASE}/query`, { sql });
    if (!Array.isArray(results) || results.some(result => !result.success)) throw new Error('D1 release query failed.');
    return results;
  };
  const configuration = checkProject(await api(`/pages/projects/${PROJECT}`));
  const before = await inspectDatabase(query);
  await saveReport('preflight', { checkedAt: new Date().toISOString(), ...configuration, ...before });
  console.log(JSON.stringify({ stage: 'preflight', ...configuration, counts: before.counts }));
  if (mode === '--preflight') return;
  // Read the reviewed input before any migration, so a missing artifact cannot leave a partial release.
  const registry = await readFile('data/company-registry/production.sql', 'utf8');
  registryStatements(registry);
  await applySchema(query);
  const importedStatements = await importRegistry(query, registry);
  const after = await inspectDatabase(query);
  for (const table of ['community_posts', 'community_comments', 'community_reactions', 'community_reports', 'community_post_images']) {
    if (after.counts[table] < (before.counts[table] || 0)) throw new Error(`Data count decreased in ${table}; investigate before deploying.`);
  }
  await saveReport('applied', { appliedAt: new Date().toISOString(), importedStatements, beforeCounts: before.counts, ...after });
  console.log(JSON.stringify({ stage: 'schema-and-registry-applied', importedStatements, counts: after.counts }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(error => { console.error(error.message); process.exitCode = 1; });
