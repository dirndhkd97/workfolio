#!/usr/bin/env node
import { Resolver } from 'node:dns/promises';
import { isIP } from 'node:net';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const QUERY = `SELECT DISTINCT ?company ?companyLabel ?website WHERE {
  VALUES ?kind { wd:Q4830453 wd:Q783794 wd:Q891723 wd:Q6881511 }
  ?company wdt:P17 wd:Q884; wdt:P856 ?website; wdt:P31 ?kind.
  SERVICE wikibase:label { bd:serviceParam wikibase:language "ko,en". }
} LIMIT 5000`;
export const DISSOLVED_QUERY = 'SELECT DISTINCT ?company WHERE { ?company wdt:P17 wd:Q884; wdt:P576 ?dissolved. }';
const ENDPOINT = 'https://query.wikidata.org/sparql';
const NOTICE = 'Official website + MX records are review signals, not proof that a domain is exclusively an employee email domain. Review before applying SQL. No database is modified by this tool.';
const PUBLIC_MAIL = new Set(['gmail.com', 'googlemail.com', 'naver.com', 'daum.net', 'hanmail.net', 'nate.com', 'kakao.com', 'kakaomail.com', 'hanmir.com', 'dreamwiz.com', 'korea.com', 'empas.com', 'chollian.net', 'paran.com', 'hotmail.com', 'outlook.com', 'live.com', 'msn.com', 'yahoo.com', 'yahoo.co.kr', 'yahoo.co.jp', 'icloud.com', 'me.com', 'mac.com', 'aol.com', 'proton.me', 'protonmail.com', 'tuta.com', 'tutanota.com', 'yandex.com', 'mail.ru', 'mail.com', 'fastmail.com', 'hey.com', 'zoho.com']);
const SHARED_HOSTS = new Set(['github.com', 'github.io', 'gitlab.com', 'gitlab.io', 'notion.so', 'notion.site', 'naver.me', 'tistory.com', 'medium.com', 'wordpress.com', 'blogspot.com', 'wixsite.com', 'wix.com', 'webflow.io', 'squarespace.com', 'carrd.co', 'netlify.app', 'vercel.app', 'pages.dev', 'cloudfront.net', 'azurewebsites.net', 'herokuapp.com', 'appspot.com', 'firebaseapp.com', 'web.app', 'facebook.com', 'instagram.com', 'linkedin.com', 'youtube.com', 'twitter.com', 'x.com', 'threads.net', 't.me', 'linktr.ee', 'sites.google.com', 'docs.google.com', 'archive.org', 'archive.is', 'archive.ph', 'archive.today', 'cafe24.com', 'imweb.me', 'modoo.at']);
function matchesHost(domain, hosts) {
  return [...hosts].some(host => domain === host || domain.endsWith(`.${host}`));
}

export function normalizeWebsite(value) {
  if (typeof value !== 'string') return { reason: 'missing_website' };
  let url;
  try { url = new URL(value); } catch { return { reason: 'invalid_website' }; }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.port) return { reason: 'unsafe_website' };
  const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
  if (isIP(hostname.replace(/^\[|\]$/g, ''))) return { reason: 'ip_address' };
  const domain = hostname.replace(/^www\./, '');
  if (domain.length > 253 || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(domain) || /\.(?:localhost|local|internal|test|invalid)$/.test(domain)) return { reason: 'invalid_domain' };
  if (matchesHost(domain, PUBLIC_MAIL)) return { reason: 'public_email_domain' };
  if (matchesHost(domain, SHARED_HOSTS)) return { reason: 'shared_host' };
  return { domain };
}

export function collectCandidates(source) {
  const bindings = source?.results?.bindings;
  if (!Array.isArray(bindings)) throw new Error('Expected Wikidata SPARQL JSON with results.bindings.');
  const rejected = [], distinct = new Map();
  for (const binding of bindings) {
    const entity = binding?.company?.value, label = binding?.companyLabel?.value, website = binding?.website?.value;
    const name = typeof label === 'string' ? label.trim() : null;
    const match = typeof entity === 'string' ? /^https?:\/\/www\.wikidata\.org\/entity\/(Q[1-9]\d*)$/.exec(entity) : null;
    const provenance = { entity: entity ?? null, name: name ?? null, website: website ?? null };
    if (!match || typeof name !== 'string' || !name || name === match[1] || name.length > 200 || /[\x00-\x1f\x7f]/.test(name)) {
      rejected.push({ ...provenance, reason: 'invalid_company' });
      continue;
    }
    const normalized = normalizeWebsite(website);
    if (normalized.reason) { rejected.push({ ...provenance, reason: normalized.reason }); continue; }
    const candidate = { companyId: `wikidata-${match[1]}`, wikidataId: match[1], name, domain: normalized.domain, website, source: `https://www.wikidata.org/wiki/${match[1]}` };
    const key = `${candidate.companyId}\0${candidate.domain}`;
    if (!distinct.has(key)) distinct.set(key, candidate);
  }
  const owners = new Map();
  for (const candidate of distinct.values()) {
    if (!owners.has(candidate.domain)) owners.set(candidate.domain, new Set());
    owners.get(candidate.domain).add(candidate.companyId);
  }
  const candidates = [];
  for (const candidate of distinct.values()) {
    if (owners.get(candidate.domain).size > 1) rejected.push({ ...candidate, reason: 'ambiguous_domain', conflictingCompanyIds: [...owners.get(candidate.domain)].sort() });
    else candidates.push(candidate);
  }
  return { candidates: candidates.sort((a, b) => a.domain.localeCompare(b.domain)), rejected };
}

async function defaultMxLookup(domain) {
  return new Resolver({ timeout: 3000, tries: 1 }).resolveMx(domain);
}
export async function checkMx(candidates, lookup = defaultMxLookup) {
  const results = new Array(candidates.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(6, candidates.length) }, async () => {
    while (cursor < candidates.length) {
      const index = cursor++, candidate = candidates[index];
      try {
        const records = await lookup(candidate.domain);
        const mx = records.filter(record => typeof record.exchange === 'string' && record.exchange && record.exchange !== '.' && Number.isInteger(record.priority));
        results[index] = mx.length ? { ...candidate, mx: mx.map(record => ({ exchange: record.exchange.toLowerCase(), priority: record.priority })) } : { ...candidate, reason: 'no_mx' };
      } catch (error) {
        results[index] = { ...candidate, reason: 'mx_lookup_failed', dnsCode: typeof error?.code === 'string' ? error.code : 'UNKNOWN' };
      }
    }
  }));
  return { candidates: results.filter(item => !item.reason), rejected: results.filter(item => item.reason) };
}

function quote(value) { return `'${value.replace(/'/g, "''")}'`; }
export function generateSql(candidates) {
  const companies = new Map();
  for (const candidate of candidates) {
    if (candidate.reason || !candidate.mx?.length || normalizeWebsite(`https://${candidate.domain}`).domain !== candidate.domain || !/^wikidata-Q[1-9]\d*$/.test(candidate.companyId) || typeof candidate.name !== 'string') {
      throw new Error('SQL generation requires normalized company candidates with successful MX checks.');
    }
    if (companies.has(candidate.companyId) && companies.get(candidate.companyId) !== candidate.name) throw new Error(`Conflicting names for ${candidate.companyId}.`);
    companies.set(candidate.companyId, candidate.name);
  }
  const domains = new Set();
  const lines = ['-- Reviewable bulk company registry import from Wikidata (CC0).', `-- ${NOTICE}`, '-- Existing operator-curated company names and domain mappings are never overwritten.'];
  for (const [id, name] of companies) lines.push(`INSERT INTO community_companies (id, name) VALUES (${quote(id)}, ${quote(name)}) ON CONFLICT(id) DO NOTHING;`);
  for (const candidate of candidates) {
    if (domains.has(candidate.domain)) throw new Error(`Duplicate domain in SQL candidates: ${candidate.domain}`);
    domains.add(candidate.domain);
    lines.push(`INSERT INTO community_company_domains (domain, company_id) VALUES (${quote(candidate.domain)}, ${quote(candidate.companyId)}) ON CONFLICT(domain) DO NOTHING;`);
  }
  return lines.join('\n') + '\n';
}

export function excludeDissolved(source, dissolved) {
  if (!Array.isArray(source?.results?.bindings) || !Array.isArray(dissolved?.results?.bindings)) throw new Error('Both company and dissolved-company query responses are required.');
  const entityId = value => typeof value === 'string' ? /^https?:\/\/www\.wikidata\.org\/entity\/(Q[1-9]\d*)$/.exec(value)?.[1] : null;
  const excluded = new Set(dissolved.results.bindings.map(binding => {
    const id = entityId(binding?.company?.value);
    if (!id) throw new Error('Invalid dissolved-company response; refusing an incomplete exclusion list.');
    return id;
  }));
  return { ...source, results: { ...source.results, bindings: source.results.bindings.filter(binding => !excluded.has(entityId(binding?.company?.value))) } };
}
async function fetchQuery(query) {
  const url = new URL(ENDPOINT);
  url.search = new URLSearchParams({ query, format: 'json' }).toString();
  const response = await fetch(url, { headers: { Accept: 'application/sparql-results+json', 'User-Agent': 'WorkfolioCompanyRegistry/1.0 (contact@workfolio.life)' }, redirect: 'error', signal: AbortSignal.timeout(45000) });
  if (!response.ok) throw new Error(`Wikidata request failed (${response.status}).`);
  return response.json();
}
async function fetchSource() {
  // Separate indexed queries avoid the large FILTER NOT EXISTS join timing out.
  const [raw, dissolved] = await Promise.all([fetchQuery(QUERY), fetchQuery(DISSOLVED_QUERY)]);
  return { raw, dissolved, source: excludeDissolved(raw, dissolved) };
}

const HELP = `Usage: node scripts/company-registry.mjs (--input FILE | --fetch) --output-dir DIR [--generate-sql]

Build reviewable Korean company/email-domain candidates from Wikidata CC0 official websites.
--input FILE       Read a saved Wikidata SPARQL JSON response.
--fetch            Fetch Korean companies and exclude known dissolved companies (45s per query).
--output-dir DIR   Write candidates.json (accepted candidates, provenance, MX records and exclusions).
--generate-sql     Also write registry.sql for a reviewed bulk import; it preserves existing mappings.
--help             Show this help.

Public email providers, shared hosting, ambiguous domains and absent/failed MX checks are excluded.
DNS requests run with concurrency 6. Original query and Wikidata entity links remain in the snapshot.
${NOTICE}
`;
export async function main(args = process.argv.slice(2)) {
  if (args.includes('--help')) { process.stdout.write(HELP); return; }
  let input, output, shouldFetch = false, sql = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--input') input = args[++i];
    else if (args[i] === '--output-dir') output = args[++i];
    else if (args[i] === '--fetch') shouldFetch = true;
    else if (args[i] === '--generate-sql') sql = true;
    else throw new Error(`Unknown argument: ${args[i]}`);
  }
  if ((!input && !shouldFetch) || (input && shouldFetch) || !output || input?.startsWith('--') || output.startsWith('--')) throw new Error(HELP);
  const fetched = shouldFetch ? await fetchSource() : null;
  const source = fetched ? fetched.source : JSON.parse(await readFile(resolve(input), 'utf8'));
  const collected = collectCandidates(source);
  const checked = await checkMx(collected.candidates);
  const rejected = [...collected.rejected, ...checked.rejected];
  const directory = resolve(output);
  await mkdir(directory, { recursive: true });
  const snapshot = { generatedAt: new Date().toISOString(), source: ENDPOINT, sourceInput: input ? resolve(input) : null, license: 'CC0-1.0', queryTemplate: QUERY, dissolvedQueryTemplate: DISSOLVED_QUERY, requiresReview: true, notice: NOTICE, candidates: checked.candidates, rejected };
  await writeFile(join(directory, 'candidates.json'), JSON.stringify(snapshot, null, 2) + '\n');
  if (fetched) {
    await writeFile(join(directory, 'source.json'), JSON.stringify(fetched.raw, null, 2) + '\n');
    await writeFile(join(directory, 'dissolved-source.json'), JSON.stringify(fetched.dissolved, null, 2) + '\n');
  }
  if (sql) await writeFile(join(directory, 'registry.sql'), generateSql(checked.candidates));
  process.stdout.write(JSON.stringify({ candidates: checked.candidates.length, rejected: rejected.length, output: directory, sqlGenerated: sql }) + '\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
