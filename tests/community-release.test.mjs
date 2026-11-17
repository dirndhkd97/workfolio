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

test('moderator preflight reports only configuration presence and never blocks an unset designation', () => {
  assert.equal(checkProject(project).communityModeratorConfigured, false);
  for (const [setting, expected] of [
    [{ type: 'plain_text', value: '' }, false],
    [{ type: 'plain_text', value: '   ' }, false],
    [{ type: 'plain_text', value: 'private-moderator-account' }, true],
    [{ type: 'secret_text' }, true],
    [{ type: 'secret_text', value: 'private-secret-account' }, true],
  ]) {
    const configured = structuredClone(project);
    configured.deployment_configs.production.env_vars.COMMUNITY_MODERATOR_USER_IDS = setting;
    const report = checkProject(configured);
    assert.equal(report.communityModeratorConfigured, expected);
    assert.doesNotMatch(JSON.stringify(report), /private-moderator-account|private-secret-account|COMMUNITY_MODERATOR_USER_IDS/);
  }
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

test('three-board migration preserves every real post, original category, attachment, company badge and private report across reruns', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    const query = adapter(db);
    for (const name of ['0005_community_auth.sql','0006_community_board.sql','0007_community_kakao_events.sql','0008_community_session_persistence.sql','0009_community_company_verification.sql','0010_community_post_company.sql','0011_community_admin_author.sql','0012_community_post_images.sql']) db.exec(await readMigration(name));
    const categories = ['웃픈 실수','황당한 순간','회사 사람들','소소한 일상','빡대가리 게시판','월급루팡','퇴사각 상담소'];
    for (const [index, category] of categories.entries()) db.prepare('INSERT INTO community_posts (id,owner_id,title,body,category,nickname,created_at,company_name,is_admin_author) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(`real-${index}`, 'real-owner', `실제 제목 ${index}`, `한 글자도 바꾸면 안 되는 실제 본문 ${index}`, category, '실제 작성자', 100 + index, 'Workfolio', 1);
    db.exec("INSERT INTO community_comments VALUES ('comment','real-0','reader','기존 실제 댓글','익명',100); INSERT INTO community_reactions VALUES ('real-0','reader','same',1); INSERT INTO community_reports VALUES ('real-0','reader','플랫폼에만 신고한 내용',101);");
    db.exec("INSERT INTO community_post_images (id,owner_id,object_key,post_id,status,content_type,byte_size,width,height,created_at,expires_at) VALUES ('existing-image','real-owner','community/existing','real-0','attached','image/png',100,320,240,100,200);");
    db.exec("CREATE TABLE customers (id TEXT,email TEXT); INSERT INTO customers VALUES ('customer','existing@example.test'); CREATE TABLE invoices (id TEXT,amount INTEGER); INSERT INTO invoices VALUES ('invoice',25000);");
    const content = () => db.prepare('SELECT id,owner_id,title,body,nickname,created_at,company_name,is_admin_author FROM community_posts ORDER BY id').all();
    const preserved = content(), image = db.prepare('SELECT * FROM community_post_images').all();
    await applySchema(query, readMigration); await applySchema(query, readMigration);
    assert.deepEqual(content(), preserved);
    assert.deepEqual(db.prepare('SELECT * FROM community_post_images').all(), image);
    assert.deepEqual(db.prepare('SELECT original_category FROM community_posts ORDER BY id').all().map(row => row.original_category), categories);
    assert.deepEqual(db.prepare('SELECT category FROM community_posts ORDER BY id').all().map(row => row.category), ['빡대가리 게시판','빡대가리 게시판','빡대가리 게시판','월급루팡','빡대가리 게시판','월급루팡','퇴사각 상담소']);
    assert.ok(db.prepare('SELECT status,view_count,channel_id FROM community_posts').all().every(row => row.status === 'published' && row.view_count === 0 && row.channel_id === null));
    const report = db.prepare('SELECT * FROM community_reports').get();
    assert.equal(report.reason, '플랫폼에만 신고한 내용'); assert.equal(report.share_with_channel, 0); assert.equal(report.dismissed_at, null); assert.equal(report.channel_dismissed_at, null);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM community_comments').get().n, 1);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM community_reactions').get().n, 1);
    assert.equal(db.prepare('SELECT email FROM customers').get().email, 'existing@example.test');
    assert.equal(db.prepare('SELECT amount FROM invoices').get().amount, 25000);
    // Requests served by the previous release can still arrive after migration until Pages switches workers.
    db.prepare('INSERT INTO community_posts (id,owner_id,title,body,category,nickname,created_at) VALUES (?,?,?,?,?,?,?)')
      .run('during-cutover', 'real-owner', '교체 중 등록', '이전 버전에서 등록된 글', '회사 사람들', '작성자', 999);
    for (let attempt = 0; attempt < 2; attempt++) {
      const late = db.prepare("SELECT category,original_category FROM community_posts WHERE id='during-cutover'").get();
      assert.equal(late.category, '빡대가리 게시판');
      assert.equal(late.original_category, '회사 사람들');
      await applySchema(query, readMigration);
    }
  } finally { db.close(); }
});

test('board migration rejects unreviewed data updates and destructive SQL before its first write', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(await readMigration('0006_community_board.sql'));
    const { applyBoardSchema } = await import('../scripts/release-community.mjs');
    const query = adapter(db), safe = await readMigration('0015_community_boards_channels_views.sql');
    for (const unsafe of ["DELETE FROM community_posts", "UPDATE community_posts SET body='replacement'", 'DROP TABLE community_reports', 'CREATE TABLE IF NOT EXISTS stolen (secret TEXT)', 'CREATE TABLE IF NOT EXISTS community_channels AS SELECT * FROM community_reports', 'CREATE INDEX IF NOT EXISTS community_channels_name ON community_reports(owner_id)']) {
      await assert.rejects(() => applyBoardSchema(query, `${safe};${unsafe};`), /Unexpected statement/);
      assert.equal(db.prepare('PRAGMA table_info(community_posts)').all().some(row => row.name === 'original_category'), false);
    }
    // A release interrupted after a few ALTER statements remains recoverable without duplicate-column errors.
    db.exec('ALTER TABLE community_posts ADD COLUMN original_category TEXT;');
    await applyBoardSchema(query, safe); await applyBoardSchema(query, safe);
    assert.ok(db.prepare('PRAGMA table_info(community_reports)').all().some(row => row.name === 'channel_dismissed_at'));
  } finally { db.close(); }
});
