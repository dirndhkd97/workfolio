#!/usr/bin/env node
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const ACCOUNT = 'ae40d286be880d4faf549a14530875dc';
const DATABASE = '070de128-ce30-40d1-9ba2-bc00e08cc073';
const PROJECT = 'workfolio';
const TABLES = ['community_users', 'community_accounts', 'community_sessions', 'community_oauth_flows', 'community_posts', 'community_comments', 'community_reactions', 'community_reports', 'community_kakao_events', 'community_companies', 'community_company_domains', 'community_company_verifications', 'community_company_challenges'];
const REQUIRED = {
  community_sessions: ['token_hash', 'user_id', 'created_at', 'expires_at', 'remember_me'],
  community_oauth_flows: ['state_hash', 'provider', 'browser_hash', 'nonce', 'code_verifier', 'redirect_uri', 'return_to', 'expires_at', 'remember_me'],
  community_posts: ['id', 'owner_id', 'title', 'body', 'category', 'nickname', 'created_at', 'company_name', 'is_admin_author'],
  community_companies: ['id', 'name'],
  community_company_domains: ['domain', 'company_id'],
  community_company_verifications: ['user_id', 'company_id', 'email_hash', 'verified_at', 'expires_at', 'domain'],
  community_company_challenges: ['id', 'user_id', 'company_id', 'domain', 'email_hash', 'code_hash', 'created_at', 'expires_at', 'attempts', 'status', 'claim_token'],
};
// This is the only data UPDATE accepted alongside the additive schema migrations.
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
    else if (char === ';') { if (statement.trim()) statements.push(statement.trim()); statement = ''; }
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
  return { project: PROJECT, productionBranch: 'main', mailgunConfigured: true, databaseBindingMatches: true };
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
  await saveReport('applied', { appliedAt: new Date().toISOString(), importedStatements, beforeCounts: before.counts, ...after });
  console.log(JSON.stringify({ stage: 'schema-and-registry-applied', importedStatements, counts: after.counts }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(error => { console.error(error.message); process.exitCode = 1; });
