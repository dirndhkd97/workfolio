import { getCommunityIdentity, type CommunityAuthEnv } from './community-auth';
import { BoardError, checkMutationRequest, readJsonBody } from '../../src/lib/community/domain';

export interface CommunityCompanyEnv extends CommunityAuthEnv { MAILGUN_API_KEY?: string }
export interface VerifiedCompany { id: string; name: string; verifiedAt: number; expiresAt: number }
const CODE_MS = 10 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const VERIFIED_MS = 90 * 24 * HOUR_MS;
const headers = { 'Cache-Control': 'private, no-store', 'Vary': 'Cookie', 'X-Content-Type-Options': 'nosniff' };

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: status === 429 ? { ...headers, 'Retry-After': '60' } : headers });
}
function failure(error: unknown): Response {
  if (error instanceof BoardError) return json({ error: error.message }, error.status);
  return json({ error: '회사 인증을 완료하지 못했어요. 잠시 후 다시 시도해 주세요.' }, 503);
}
async function identity(request: Request, env: CommunityCompanyEnv): Promise<string> {
  const userId = await getCommunityIdentity(request, env);
  if (!userId) throw new BoardError('회사 인증은 로그인한 후 이용할 수 있어요.', 401);
  return userId;
}
async function hash(value: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function emailAddress(value: unknown): { email: string; domain: string } {
  if (typeof value !== 'string') throw new BoardError('회사 이메일을 입력해 주세요.');
  const email = value.trim().toLowerCase();
  if (email.length > 254 || !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(email)) {
    throw new BoardError('올바른 회사 이메일 주소를 입력해 주세요.');
  }
  return { email, domain: email.slice(email.lastIndexOf('@') + 1) };
}
function randomCode(): string {
  const values = new Uint32Array(1);
  // Rejection sampling avoids a modulo bias in six-digit codes, including leading zeroes.
  do { crypto.getRandomValues(values); } while (values[0] >= 4294000000);
  return String(values[0] % 1000000).padStart(6, '0');
}

export async function getVerifiedCompany(db: D1Database, userId: string, now = Date.now()): Promise<VerifiedCompany | null> {
  return db.prepare('SELECT c.id, c.name, v.verified_at AS verifiedAt, v.expires_at AS expiresAt FROM community_company_verifications v JOIN community_companies c ON c.id = v.company_id WHERE v.user_id = ? AND v.expires_at > ?')
    .bind(userId, now).first<VerifiedCompany>();
}

export async function companyMe(request: Request, env: CommunityCompanyEnv): Promise<Response> {
  try { return json({ company: await getVerifiedCompany(env.DB, await identity(request, env)) }); }
  catch (error) { return failure(error); }
}

export async function sendCompanyCode(request: Request, env: CommunityCompanyEnv): Promise<Response> {
  try {
    checkMutationRequest(request);
    const userId = await identity(request, env);
    const { email, domain } = emailAddress((await readJsonBody(request)).email);
    const company = await env.DB.prepare('SELECT c.id, c.name FROM community_company_domains d JOIN community_companies c ON c.id = d.company_id WHERE d.domain = ?')
      .bind(domain).first<{ id: string; name: string }>();
    if (!company) throw new BoardError('아직 등록되지 않은 회사 이메일이에요. 회사명과 이메일 도메인을 contact@workfolio.life로 알려 주세요.', 400);
    if (!env.MAILGUN_API_KEY?.trim()) throw new BoardError('이메일 인증 발송을 준비하고 있어요. 잠시 후 다시 시도해 주세요.', 503);
    const now = Date.now(), id = crypto.randomUUID(), code = randomCode();
    const emailHash = await hash(email), codeHash = await hash(`${id}\0${userId}\0${code}`);
    // The conditional INSERT reserves both limits in one write, even under concurrent sends.
    const reserved = await env.DB.batch([
      env.DB.prepare('DELETE FROM community_company_challenges WHERE created_at <= ?').bind(now - HOUR_MS),
      env.DB.prepare(`INSERT INTO community_company_challenges (id, user_id, company_id, domain, email_hash, code_hash, created_at, expires_at, status)
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, 'pending'
        WHERE NOT EXISTS (SELECT 1 FROM community_company_challenges WHERE (user_id = ? OR email_hash = ?) AND created_at > ?)
          AND (SELECT COUNT(*) FROM community_company_challenges WHERE user_id = ? AND created_at > ?) < 5
          AND (SELECT COUNT(*) FROM community_company_challenges WHERE email_hash = ? AND created_at > ?) < 5`)
        .bind(id, userId, company.id, domain, emailHash, codeHash, now, now + CODE_MS, userId, emailHash, now - 60000, userId, now - HOUR_MS, emailHash, now - HOUR_MS),
      env.DB.prepare("UPDATE community_company_challenges SET status = 'cancelled', code_hash = NULL WHERE user_id = ? AND id <> ? AND status IN ('pending', 'sent') AND EXISTS (SELECT 1 FROM community_company_challenges WHERE id = ?)")
        .bind(userId, id, id),
    ]);
    if (reserved[1].meta.changes !== 1) throw new BoardError('인증코드는 1분에 한 번, 시간당 5회까지 받을 수 있어요. 잠시 후 다시 시도해 주세요.', 429);
    const form = new FormData();
    form.append('from', 'Workfolio <noreply@workfolio.life>');
    form.append('to', email);
    form.append('subject', '[Workfolio] 회사 이메일 인증코드');
    form.append('text', `Workfolio 회사 이메일 인증\n\n${company.name} 인증코드: ${code}\n\n10분 안에 입력해 주세요. 본인이 요청하지 않았다면 이 메일을 무시해 주세요.`);
    try {
      const response = await fetch('https://api.mailgun.net/v3/workfolio.life/messages', {
        method: 'POST', headers: { Authorization: 'Basic ' + btoa('api:' + env.MAILGUN_API_KEY.trim()) },
        body: form, redirect: 'manual', signal: AbortSignal.timeout(8000),
      });
      if (!response.ok) throw new Error('mail_send_failed');
    } catch {
      await env.DB.prepare("UPDATE community_company_challenges SET status = 'failed', code_hash = NULL WHERE id = ? AND status = 'pending'").bind(id).run();
      throw new BoardError('인증 메일을 보내지 못했어요. 잠시 후 다시 요청해 주세요.', 503);
    }
    const sent = await env.DB.prepare("UPDATE community_company_challenges SET status = 'sent' WHERE id = ? AND status = 'pending' AND expires_at > ?").bind(id, Date.now()).run();
    if (sent.meta.changes !== 1) throw new BoardError('인증 요청이 변경되었어요. 가장 최근에 받은 코드를 사용해 주세요.', 409);
    return json({ sent: true, company, expiresAt: now + CODE_MS });
  } catch (error) { return failure(error); }
}

export async function verifyCompanyCode(request: Request, env: CommunityCompanyEnv): Promise<Response> {
  try {
    checkMutationRequest(request);
    const userId = await identity(request, env);
    const data = await readJsonBody(request);
    if (typeof data.code !== 'string' || !/^\d{6}$/.test(data.code)) throw new BoardError('6자리 인증코드를 입력해 주세요.');
    const now = Date.now();
    const challenge = await env.DB.prepare(`UPDATE community_company_challenges SET attempts = attempts + 1
      WHERE user_id = ? AND status = 'sent' AND expires_at > ? AND attempts < 5
      RETURNING id, code_hash, email_hash`)
      .bind(userId, now).first<{ id: string; code_hash: string; email_hash: string }>();
    const invalid = '인증코드가 올바르지 않거나 만료되었어요. 5회 틀렸다면 새 코드를 받아 주세요.';
    if (!challenge || await hash(`${challenge.id}\0${userId}\0${data.code}`) !== challenge.code_hash) throw new BoardError(invalid, 400);
    const claim = crypto.randomUUID();
    // Claim + verification update are transactional. A second verifier cannot reuse a code.
    const results = await env.DB.batch([
      env.DB.prepare('DELETE FROM community_company_verifications WHERE expires_at <= ?').bind(now),
      env.DB.prepare(`UPDATE community_company_challenges SET status = 'used', code_hash = NULL, claim_token = ?
        WHERE id = ? AND user_id = ? AND status = 'sent' AND code_hash = ? AND expires_at > ?
          AND EXISTS (SELECT 1 FROM community_company_domains d WHERE d.domain = community_company_challenges.domain AND d.company_id = community_company_challenges.company_id)`)
        .bind(claim, challenge.id, userId, challenge.code_hash, now),
      env.DB.prepare(`INSERT INTO community_company_verifications (user_id, company_id, email_hash, verified_at, expires_at)
        SELECT user_id, company_id, email_hash, ?, ? FROM community_company_challenges WHERE id = ? AND claim_token = ? AND status = 'used'
        ON CONFLICT(user_id) DO UPDATE SET company_id = excluded.company_id, email_hash = excluded.email_hash, verified_at = excluded.verified_at, expires_at = excluded.expires_at`)
        .bind(now, now + VERIFIED_MS, challenge.id, claim),
    ]);
    if (results[1].meta.changes !== 1 || results[2].meta.changes !== 1) throw new BoardError('이미 사용되었거나 변경된 인증 요청이에요. 새 코드를 받아 주세요.', 409);
    return json({ company: await getVerifiedCompany(env.DB, userId, now) });
  } catch (error) { return failure(error); }
}
