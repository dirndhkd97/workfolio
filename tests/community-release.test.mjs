import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFile } from 'node:fs/promises';
import { applySchema, checkProject, importRegistry, inspectDatabase, splitSql } from '../scripts/release-community.mjs';

const databaseId = '070de128-ce30-40d1-9ba2-bc00e08cc073';
const project = { name: 'workfolio', production_branch: 'main', deployment_configs: { production: {
  env_vars: { MAILGUN_API_KEY: { type: 'secret_text' } }, d1_databases: { DB: { id: databaseId } },
} } };
const readMigration = name => readFile(new URL(`../migrations/${name}`, import.meta.url), 'utf8');
function adapter(db) {
  return async sql => splitSql(sql).map(statement => {
    const prepared = db.prepare(statement);
    return { success: true, results: /^(?:SELECT|PRAGMA)\b/i.test(statement) ? prepared.all() : (prepared.run(), []) };
  });
}

test('preflight accepts redacted secret metadata and rejects missing mail or wrong production targets', () => {
  assert.equal(checkProject(project).mailgunConfigured, true);
  const missing = structuredClone(project);
  missing.deployment_configs.production.env_vars = {};
  assert.throws(() => checkProject(missing), /MAILGUN_API_KEY is missing/);
  const empty = structuredClone(project);
  empty.deployment_configs.production.env_vars.MAILGUN_API_KEY = { type: 'plain_text', value: '' };
  assert.throws(() => checkProject(empty), /MAILGUN_API_KEY is missing/);
  assert.throws(() => checkProject({ ...project, production_branch: 'preview' }), /production branch/);
  const wrongDb = structuredClone(project);
  wrongDb.deployment_configs.production.d1_databases.DB.id = 'wrong';
  assert.throws(() => checkProject(wrongDb), /DB binding/);
});

test('additive release schema is repeatable, recovers partial company creation and preserves existing data', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('PRAGMA foreign_keys = ON');
    const query = adapter(db);
    for (const file of ['0005_community_auth.sql', '0006_community_board.sql', '0007_community_kakao_events.sql']) db.exec(await readMigration(file));
    db.exec("INSERT INTO community_users VALUES ('owner','old-nickname',1); INSERT INTO community_sessions VALUES ('old-token','owner',1,9999999999999); INSERT INTO community_posts VALUES ('old-post','owner','title','body','category','nickname',1);");
    // A prior interrupted migration may have applied one ALTER and one CREATE TABLE.
    db.exec('ALTER TABLE community_sessions ADD COLUMN remember_me INTEGER NOT NULL DEFAULT 1 CHECK (remember_me IN (0,1)); CREATE TABLE community_companies (id TEXT PRIMARY KEY,name TEXT NOT NULL);');
    await applySchema(query, readMigration);
    await applySchema(query, readMigration);
    assert.equal(db.prepare("SELECT remember_me FROM community_sessions WHERE token_hash='old-token'").get().remember_me, 1);
    assert.equal(db.prepare("SELECT company_name FROM community_posts WHERE id='old-post'").get().company_name, null);
    assert.equal(db.prepare("SELECT is_admin_author FROM community_posts WHERE id='old-post'").get().is_admin_author, 0);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM community_companies').get().n, 2);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM community_users').get().n, 1);
    const report = await inspectDatabase(query);
    assert.equal(report.counts.community_sessions, 1);
    assert.equal(JSON.stringify(report).includes('old-token'), false);
    assert.equal(JSON.stringify(report).includes('old-nickname'), false);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally { db.close(); }
});

test('admin display migration preserves old proofs as unknown and survives a partially applied rerun', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('PRAGMA foreign_keys = ON');
    for (const file of ['0005_community_auth.sql', '0006_community_board.sql', '0007_community_kakao_events.sql', '0008_community_session_persistence.sql', '0009_community_company_verification.sql', '0010_community_post_company.sql']) db.exec(await readMigration(file));
    db.exec("INSERT INTO community_users VALUES ('owner','nickname',1); INSERT INTO community_company_verifications VALUES ('owner','workfolio','old-email-hash',1,9999999999999); INSERT INTO community_posts (id,owner_id,title,body,category,nickname,created_at,company_name) VALUES ('old-public','owner','title','body','category','nickname',1,'Workfolio');");
    // Simulate an interruption after adding the nullable proof domain but before the post flag.
    db.exec('ALTER TABLE community_company_verifications ADD COLUMN domain TEXT');
    const query = adapter(db);
    await applySchema(query, readMigration);
    await applySchema(query, readMigration);
    assert.equal(db.prepare("SELECT domain FROM community_company_verifications WHERE user_id='owner'").get().domain, null);
    assert.equal(db.prepare("SELECT is_admin_author FROM community_posts WHERE id='old-public'").get().is_admin_author, 0);
    db.exec("UPDATE community_company_verifications SET domain='workfolio.life' WHERE user_id='owner'; UPDATE community_posts SET is_admin_author=1 WHERE id='old-public';");
    await applySchema(query, readMigration);
    assert.equal(db.prepare("SELECT domain FROM community_company_verifications WHERE user_id='owner'").get().domain, 'workfolio.life');
    assert.equal(db.prepare("SELECT is_admin_author FROM community_posts WHERE id='old-public'").get().is_admin_author, 1);
    assert.throws(() => db.prepare("UPDATE community_posts SET is_admin_author=2 WHERE id='old-public'").run(), /CHECK constraint/);
    const report = await inspectDatabase(query);
    assert.ok(report.schema.community_posts.some(column => column.name === 'is_admin_author'));
    assert.ok(report.schema.community_company_verifications.some(column => column.name === 'domain'));
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally { db.close(); }
});

test('legacy proof backfill requires one matching consumed challenge domain and is repeatable', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('PRAGMA foreign_keys = ON');
    for (const file of ['0005_community_auth.sql', '0006_community_board.sql', '0007_community_kakao_events.sql', '0008_community_session_persistence.sql', '0009_community_company_verification.sql', '0010_community_post_company.sql']) db.exec(await readMigration(file));
    for (const id of ['proven', 'missing', 'pending', 'wrong-user', 'other', 'wrong-company', 'wrong-email', 'created-late', 'expired', 'ambiguous', 'known']) {
      db.prepare('INSERT INTO community_users VALUES (?, ?, ?)').run(id, 'nickname', 1);
      db.prepare('INSERT INTO community_company_verifications VALUES (?, ?, ?, ?, ?)').run(id, 'workfolio', `hash-${id}`, 1000, 9999999999999);
    }
    const challenge = (id, userId, overrides = {}) => {
      const value = { companyId: 'workfolio', emailHash: `hash-${userId}`, domain: 'workfolio.life', createdAt: 900, expiresAt: 1100, status: 'used', ...overrides };
      db.prepare('INSERT INTO community_company_challenges (id,user_id,company_id,domain,email_hash,created_at,expires_at,status) VALUES (?,?,?,?,?,?,?,?)')
        .run(id, userId, value.companyId, value.domain, value.emailHash, value.createdAt, value.expiresAt, value.status);
    };
    challenge('proven-1', 'proven', { createdAt: 1000 });
    challenge('proven-2', 'proven');
    challenge('pending-1', 'pending', { status: 'sent' });
    challenge('wrong-user-1', 'other', { emailHash: 'hash-wrong-user' });
    challenge('wrong-company-1', 'wrong-company', { companyId: 'plax-neural-labs' });
    challenge('wrong-email-1', 'wrong-email', { emailHash: 'different-email-hash' });
    challenge('created-late-1', 'created-late', { createdAt: 1001 });
    challenge('expired-1', 'expired', { expiresAt: 1000 });
    challenge('ambiguous-1', 'ambiguous');
    challenge('ambiguous-2', 'ambiguous', { domain: 'another.example' });
    challenge('known-1', 'known');
    db.exec("ALTER TABLE community_company_verifications ADD COLUMN domain TEXT; UPDATE community_company_verifications SET domain='previous.example' WHERE user_id='known';");
    const query = adapter(db);
    await applySchema(query, readMigration);
    const domains = () => Object.fromEntries(db.prepare('SELECT user_id,domain FROM community_company_verifications ORDER BY user_id').all().map(row => [row.user_id, row.domain]));
    const expected = { ambiguous: null, 'created-late': null, expired: null, known: 'previous.example', missing: null, other: null, pending: null, proven: 'workfolio.life', 'wrong-company': null, 'wrong-email': null, 'wrong-user': null };
    assert.deepEqual(domains(), expected);
    const proofs = db.prepare('SELECT * FROM community_company_verifications ORDER BY user_id').all();
    const challenges = db.prepare('SELECT * FROM community_company_challenges ORDER BY id').all();
    await applySchema(query, readMigration);
    assert.deepEqual(db.prepare('SELECT * FROM community_company_verifications ORDER BY user_id').all(), proofs);
    assert.deepEqual(db.prepare('SELECT * FROM community_company_challenges ORDER BY id').all(), challenges);
    await assert.rejects(() => applySchema(query, async name => name === '0011_community_admin_author.sql'
      ? "UPDATE community_company_verifications SET domain='workfolio.life' WHERE domain IS NULL;" : readMigration(name)), /Unexpected statement/);
    assert.deepEqual(domains(), expected);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally { db.close(); }
});

test('reviewed registry inserts preserve curated mappings, quote semicolons, and reject mutations', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    const query = adapter(db);
    await applySchema(query, readMigration);
    const sql = "INSERT INTO community_companies (id,name) VALUES ('new','회사; O''Name') ON CONFLICT(id) DO NOTHING; INSERT INTO community_company_domains (domain,company_id) VALUES ('letsplax.com','new') ON CONFLICT(domain) DO NOTHING;";
    assert.equal(await importRegistry(query, sql), 2);
    await importRegistry(query, sql);
    assert.equal(db.prepare("SELECT name FROM community_companies WHERE id='new'").get().name, "회사; O'Name");
    assert.equal(db.prepare("SELECT company_id FROM community_company_domains WHERE domain='letsplax.com'").get().company_id, 'plax-neural-labs');
    await assert.rejects(() => importRegistry(query, 'DELETE FROM community_users;'), /only additive/);
    await assert.rejects(() => importRegistry(query, ''), /empty/);
  } finally { db.close(); }
});
