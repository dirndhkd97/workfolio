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
    assert.equal(db.prepare('SELECT COUNT(*) n FROM community_companies').get().n, 2);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM community_users').get().n, 1);
    const report = await inspectDatabase(query);
    assert.equal(report.counts.community_sessions, 1);
    assert.equal(JSON.stringify(report).includes('old-token'), false);
    assert.equal(JSON.stringify(report).includes('old-nickname'), false);
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
