import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { normalizeWebsite, collectCandidates, checkMx, generateSql, excludeDissolved } from '../scripts/company-registry.mjs';

const binding = (id, name, website) => ({ company: { value: `http://www.wikidata.org/entity/${id}` }, companyLabel: { value: name }, website: { value: website } });
const source = (...bindings) => ({ results: { bindings } });
const mx = [{ exchange: 'mail.example.com', priority: 10 }];

test('website normalization removes only www and rejects credentials, IPs, free mail and shared hosts', () => {
  assert.deepEqual(normalizeWebsite('https://WWW.LETSPLAX.COM/about?x=1'), { domain: 'letsplax.com' });
  assert.deepEqual(normalizeWebsite('https://careers.example.com/'), { domain: 'careers.example.com' });
  assert.deepEqual(normalizeWebsite('http://www.example.co.kr.'), { domain: 'example.co.kr' });
  for (const value of ['ftp://example.com', 'https://secret@example.com', 'https://name:pass@example.com', 'https://example.com:8080']) assert.equal(normalizeWebsite(value).reason, 'unsafe_website');
  for (const value of ['http://127.0.0.1', 'http://[::1]', 'http://2130706433']) assert.equal(normalizeWebsite(value).reason, 'ip_address');
  for (const value of ['https://naver.com', 'https://gmail.com', 'https://corp.naver.com', 'https://kakao.com', 'https://kakaomail.com', 'https://dreamwiz.com']) assert.equal(normalizeWebsite(value).reason, 'public_email_domain');
  for (const value of ['https://company.github.io', 'https://company.notion.site', 'https://company.vercel.app', 'https://sites.google.com/company', 'https://web.archive.org/web/old-company.com']) assert.equal(normalizeWebsite(value).reason, 'shared_host');
  for (const value of ['https://localhost', 'https://company.internal', 'not a URL']) assert.ok(normalizeWebsite(value).reason);
});

test('separate dissolved-company query excludes closed companies and fails without reliable data', () => {
  const companies = source(binding('Q1', '운영 회사', 'https://active.example.com'), binding('Q2', '폐업 회사', 'https://closed.example.com'));
  const dissolved = source({ company: { value: 'https://www.wikidata.org/entity/Q2' } });
  assert.equal(excludeDissolved(companies, dissolved).results.bindings.length, 1);
  assert.equal(excludeDissolved(companies, dissolved).results.bindings[0].companyLabel.value, '운영 회사');
  assert.throws(() => excludeDissolved(companies, {}), /required/);
  assert.throws(() => excludeDissolved(companies, source({ company: { value: 'untrusted' } })), /Invalid dissolved/);
});

test('candidate extraction collapses duplicate websites and rejects every ambiguous company-domain mapping', () => {
  const result = collectCandidates(source(
    binding('Q1', '플랙스뉴럴랩스', 'https://www.letsplax.com'),
    binding('Q1', '플랙스뉴럴랩스', 'http://letsplax.com/about'),
    binding('Q2', '같은 그룹 첫 회사', 'https://same.example.com'),
    binding('Q3', '같은 그룹 둘째 회사', 'https://www.same.example.com'),
    binding('Q4', '공유 서비스', 'https://brand.github.io'),
    binding('Q5', 'Q5', 'https://unlabelled.example.com'),
  ));
  assert.equal(result.candidates.length, 1);
  assert.deepEqual(result.candidates[0], { companyId: 'wikidata-Q1', wikidataId: 'Q1', name: '플랙스뉴럴랩스', domain: 'letsplax.com', website: 'https://www.letsplax.com', source: 'https://www.wikidata.org/wiki/Q1' });
  assert.equal(result.rejected.filter(item => item.reason === 'ambiguous_domain').length, 2);
  assert.ok(result.rejected.filter(item => item.reason === 'ambiguous_domain').every(item => item.conflictingCompanyIds.join(',') === 'wikidata-Q2,wikidata-Q3'));
  assert.ok(result.rejected.some(item => item.reason === 'shared_host'));
  assert.ok(result.rejected.some(item => item.reason === 'invalid_company'));
});

test('MX checks fail closed on missing/null/error records and bound concurrency to six', async () => {
  const input = Array.from({ length: 15 }, (_, i) => ({ companyId: `wikidata-Q${i + 1}`, name: `회사${i}`, domain: `company-${i}.example.com` }));
  let active = 0, peak = 0;
  const result = await checkMx(input, async domain => {
    active++; peak = Math.max(peak, active);
    await new Promise(resolve => setImmediate(resolve));
    active--;
    if (domain.startsWith('company-0.')) return [];
    if (domain.startsWith('company-1.')) return [{ exchange: '.', priority: 0 }];
    if (domain.startsWith('company-2.')) throw Object.assign(new Error('DNS failure'), { code: 'ENOTFOUND' });
    return mx;
  });
  assert.equal(peak, 6);
  assert.equal(result.candidates.length, 12);
  assert.equal(result.rejected.filter(item => item.reason === 'no_mx').length, 2);
  assert.equal(result.rejected.find(item => item.reason === 'mx_lookup_failed').dnsCode, 'ENOTFOUND');
  assert.deepEqual(await checkMx([], () => { throw new Error('should not run'); }), { candidates: [], rejected: [] });
});

test('generated SQL escapes names, is idempotent and preserves curated company names and domain ownership', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(`PRAGMA foreign_keys = ON;
      CREATE TABLE community_companies (id TEXT PRIMARY KEY, name TEXT NOT NULL);
      CREATE TABLE community_company_domains (domain TEXT PRIMARY KEY, company_id TEXT NOT NULL REFERENCES community_companies(id));
      INSERT INTO community_companies VALUES ('curated', '운영자 확인 회사');
      INSERT INTO community_company_domains VALUES ('curated.example.com', 'curated');
      INSERT INTO community_companies VALUES ('wikidata-Q3', '운영자가 고친 이름');`);
    const candidates = [
      { companyId: 'wikidata-Q1', name: "O'Reilly 회사", domain: 'new.example.com', mx },
      { companyId: 'wikidata-Q2', name: '잘못 가져온 회사', domain: 'curated.example.com', mx },
      { companyId: 'wikidata-Q3', name: '기존 자동 이름', domain: 'updated.example.com', mx },
    ];
    const sql = generateSql(candidates);
    db.exec(sql); db.exec(sql);
    assert.equal(db.prepare('SELECT name FROM community_companies WHERE id = ?').get('wikidata-Q1').name, "O'Reilly 회사");
    assert.equal(db.prepare('SELECT company_id FROM community_company_domains WHERE domain = ?').get('curated.example.com').company_id, 'curated');
    assert.equal(db.prepare('SELECT name FROM community_companies WHERE id = ?').get('wikidata-Q3').name, '운영자가 고친 이름');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM community_company_domains').get().n, 3);
    assert.match(sql, /not proof/);
    assert.throws(() => generateSql([{ ...candidates[0], mx: [] }]), /successful MX/);
    assert.throws(() => generateSql([candidates[0], { ...candidates[1], domain: candidates[0].domain }]), /Duplicate domain/);
  } finally { db.close(); }
});
