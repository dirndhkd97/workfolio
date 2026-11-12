#!/usr/bin/env node
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const ACCOUNT = 'ae40d286be880d4faf549a14530875dc';
const DATABASE = '070de128-ce30-40d1-9ba2-bc00e08cc073';
const STATUSES = ['pending', 'sent', 'failed', 'cancelled', 'used'];
const QUERIES = {
  challenges: 'SELECT status, COUNT(*) AS count, MAX(created_at) AS latest_created_at FROM community_company_challenges GROUP BY status',
  mapping: "SELECT EXISTS(SELECT 1 FROM community_company_domains d JOIN community_companies c ON c.id = d.company_id WHERE d.domain = 'letsplax.com') AS mapping_exists",
};

// Official read-only endpoint and regional hosts:
// https://documentation.mailgun.com/docs/mailgun/api-reference/send/mailgun/domains/get-v4-domains--name-
// https://documentation.mailgun.com/docs/mailgun/api-reference/api-overview
// Domain Sending Keys can send mail but cannot read domain metadata. A GET 403
// therefore does not establish that the application's sending credential is bad.
// https://documentation.mailgun.com/docs/mailgun/user-manual/api-key-mgmt/rbac-mgmt
export function classifyMailgun(status) {
  if (status >= 200 && status < 300) return 'domain_metadata_accessible';
  if (status === 401) return 'metadata_authentication_rejected';
  if (status === 403) return 'metadata_forbidden_key_scope_unknown';
  if (status === 404) return 'domain_not_found_or_inaccessible_in_region';
  if (status === 429) return 'metadata_rate_limited';
  if (status >= 500) return 'metadata_service_error';
  if (status >= 300 && status < 400) return 'metadata_redirect_not_followed';
  return 'metadata_request_rejected';
}

function readableSecret(entry) {
  if (!entry || typeof entry.value !== 'string') return null;
  const value = entry.value.trim();
  // Cloudflare can return only secret metadata or a redacted placeholder.
  if (!value || /[*•…]/u.test(value) || /^(?:\[?redacted\]?|\[?hidden\]?|undefined|null)$/i.test(value)) return null;
  return value;
}

export function summarizeChallenges(rows) {
  const summary = STATUSES.map(status => ({ status, count: 0, latestCreatedAt: null }));
  for (const row of Array.isArray(rows) ? rows : []) {
    const target = summary.find(item => item.status === row.status);
    if (!target) continue; // Never echo unexpected database strings.
    if (Number.isSafeInteger(row.count) && row.count >= 0) target.count = row.count;
    if (Number.isSafeInteger(row.latest_created_at) && row.latest_created_at >= 0 && row.latest_created_at <= 8640000000000000) {
      target.latestCreatedAt = new Date(row.latest_created_at).toISOString();
    }
  }
  return summary;
}

export async function diagnose({ env = process.env, fetchImpl = fetch } = {}) {
  const token = env.CLOUDFLARE_API_TOKEN?.trim();
  if (!token) return { classification: 'cloudflare_token_missing', secretReadable: false };
  if (env.CLOUDFLARE_ACCOUNT_ID && env.CLOUDFLARE_ACCOUNT_ID !== ACCOUNT) {
    return { classification: 'cloudflare_account_mismatch', secretReadable: false };
  }

  async function cloudflare(path, sql) {
    let response;
    try {
      response = await fetchImpl(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}${path}`, {
        method: sql ? 'POST' : 'GET',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        ...(sql ? { body: JSON.stringify({ sql }) } : {}),
        redirect: 'manual', signal: AbortSignal.timeout(15000),
      });
    } catch { return { summary: { httpStatus: null, classification: 'cloudflare_network_error' } }; }
    const httpStatus = response.status;
    if (!response.ok) return { summary: { httpStatus, classification: 'cloudflare_request_rejected' } };
    let data;
    try { data = await response.json(); }
    catch { return { summary: { httpStatus, classification: 'cloudflare_invalid_response' } }; }
    if (data?.success !== true) return { summary: { httpStatus, classification: 'cloudflare_api_error' } };
    return { summary: { httpStatus, classification: 'cloudflare_ok' }, result: data.result };
  }

  const project = await cloudflare('/pages/projects/workfolio');
  const report = { pages: project.summary, secretReadable: false };
  const matches = project.result?.name === 'workfolio' && project.result?.production_branch === 'main';
  const key = matches ? readableSecret(project.result?.deployment_configs?.production?.env_vars?.MAILGUN_API_KEY) : null;
  if (project.result && !matches) report.pages.classification = 'pages_project_mismatch';
  report.secretReadable = Boolean(key);

  // Only these two fixed SELECT statements can be sent through D1's query API.
  for (const [name, sql] of Object.entries(QUERIES)) {
    const response = await cloudflare(`/d1/database/${DATABASE}/query`, sql);
    report[name] = { ...response.summary };
    const result = response.result?.[0];
    if (result?.success === true && Array.isArray(result.results)) {
      if (name === 'challenges') report[name].statuses = summarizeChallenges(result.results);
      else report[name].mappingExists = result.results[0]?.mapping_exists === 1;
    } else if (response.result) report[name].classification = 'd1_invalid_query_result';
  }

  if (key) {
    report.mailgun = {};
    for (const [region, host] of [['us', 'api.mailgun.net'], ['eu', 'api.eu.mailgun.net']]) {
      let response;
      try {
        response = await fetchImpl(`https://${host}/v4/domains/workfolio.life`, {
          method: 'GET', headers: { Authorization: `Basic ${Buffer.from(`api:${key}`).toString('base64')}` },
          redirect: 'manual', signal: AbortSignal.timeout(15000),
        });
      } catch {
        report.mailgun[region] = { httpStatus: null, classification: 'metadata_network_error' };
        continue;
      }
      const summary = { httpStatus: response.status, classification: classifyMailgun(response.status) };
      if (response.ok) {
        try {
          const body = await response.json();
          summary.domainState = ['active', 'unverified', 'disabled'].includes(body?.domain?.state) ? body.domain.state : 'unknown';
        } catch { summary.classification = 'metadata_invalid_response'; }
      }
      // No raw response, SMTP login, DNS value, key, or message details escape.
      report.mailgun[region] = summary;
    }
  }
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  diagnose().then(report => console.log(JSON.stringify(report, null, 2))).catch(() => {
    console.error(JSON.stringify({ classification: 'diagnostic_internal_error' }));
    process.exitCode = 1;
  });
}
