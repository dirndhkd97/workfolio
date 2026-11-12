import { createRemoteJWKSet, importPKCS8, jwtVerify, SignJWT } from 'jose';

export interface CommunityAuthEnv {
  DB: D1Database;
  KAKAO_CLIENT_ID?: string;
  KAKAO_CLIENT_SECRET?: string;
  NAVER_CLIENT_ID?: string;
  NAVER_CLIENT_SECRET?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  APPLE_CLIENT_ID?: string;
  APPLE_CLIENT_SECRET?: string;
  APPLE_TEAM_ID?: string;
  APPLE_KEY_ID?: string;
  APPLE_PRIVATE_KEY?: string;
}

export type CommunityProvider = 'kakao' | 'naver' | 'google' | 'apple';
type AuthErrorCode = 'provider_unavailable' | 'invalid_state' | 'provider_denied' | 'login_failed' | 'insecure_origin';
type OAuthFlow = { state_hash: string; provider: CommunityProvider; browser_hash: string; nonce: string; code_verifier: string | null; redirect_uri: string; return_to: string; expires_at: number };
type OAuthStage = 'callback_validate' | 'state_lookup' | 'state_claim' | 'authorization_response' | 'client_credentials' | 'token_request' | 'token_response' | 'token_validate' | 'id_token_verify' | 'userinfo_request' | 'userinfo_response' | 'userinfo_validate' | 'session_write';
type OAuthDiagnostic = { stage: OAuthStage; http_status: number | null; provider_code: string | null };

const OAUTH_ERROR_CODES = new Set(['invalid_request', 'invalid_client', 'invalid_grant', 'unauthorized_client', 'unsupported_grant_type', 'unsupported_response_type', 'invalid_scope', 'access_denied', 'server_error', 'temporarily_unavailable', 'invalid_token']);
const PROVIDER_ERROR_CODES = {
  kakao: new Set(['KOE001', 'KOE003', 'KOE004', 'KOE009', 'KOE010', 'KOE101', 'KOE114', 'KOE126', 'KOE127', 'KOE237', 'KOE303', 'KOE310', 'KOE319', 'KOE320', 'KOE322', '-1', '-2', '-3', '-4', '-5', '-9', '-10', '-101', '-102', '-103', '-201', '-402', '-403']),
  naver: new Set(['024', '028', '403', '404', '500']),
  google: new Set<string>(),
  apple: new Set<string>(),
};

function providerErrorCode(provider: CommunityProvider, data: Record<string, unknown>): string | null {
  for (const value of [data.error_code, data.error, data.resultcode, data.code]) {
    if (typeof value !== 'string' && typeof value !== 'number') continue;
    const code = String(value);
    if (PROVIDER_ERROR_CODES[provider].has(code) || OAUTH_ERROR_CODES.has(code)) return code;
  }
  return null;
}

const PROVIDERS = {
  kakao: { label: '카카오', authorization: 'https://kauth.kakao.com/oauth/authorize', token: 'https://kauth.kakao.com/oauth/token', clientId: 'KAKAO_CLIENT_ID', secret: 'KAKAO_CLIENT_SECRET', pkce: true },
  naver: { label: '네이버', authorization: 'https://nid.naver.com/oauth2.0/authorize', token: 'https://nid.naver.com/oauth2.0/token', clientId: 'NAVER_CLIENT_ID', secret: 'NAVER_CLIENT_SECRET', pkce: false },
  google: { label: 'Google', authorization: 'https://accounts.google.com/o/oauth2/v2/auth', token: 'https://oauth2.googleapis.com/token', clientId: 'GOOGLE_CLIENT_ID', secret: 'GOOGLE_CLIENT_SECRET', pkce: true },
  apple: { label: 'Apple', authorization: 'https://appleid.apple.com/auth/authorize', token: 'https://appleid.apple.com/auth/token', clientId: 'APPLE_CLIENT_ID', secret: 'APPLE_CLIENT_SECRET', pkce: false },
} as const;

const FLOW_SECONDS = 600;
const SESSION_SECONDS = 60 * 60 * 24 * 14;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const jwks = {
  google: createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'), { timeoutDuration: 8000 }),
  apple: createRemoteJWKSet(new URL('https://appleid.apple.com/auth/keys'), { timeoutDuration: 8000 }),
};
const responseHeaders = { 'Cache-Control': 'private, no-store', 'Vary': 'Cookie', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' };

class AuthError extends Error {
  constructor(public code: AuthErrorCode, public status = 400) { super(code); }
}

export function communityAuthJson(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: responseHeaders });
}

export function isCommunityProvider(value: unknown): value is CommunityProvider {
  return typeof value === 'string' && Object.hasOwn(PROVIDERS, value);
}

export function communityProviders(env: CommunityAuthEnv) {
  return (Object.keys(PROVIDERS) as CommunityProvider[]).map((id) => {
    const settings = PROVIDERS[id];
    const clientId = env[settings.clientId]?.trim();
    const secret = env[settings.secret]?.trim();
    const appleKey = env.APPLE_TEAM_ID?.trim() && env.APPLE_KEY_ID?.trim() && env.APPLE_PRIVATE_KEY?.trim();
    return { id, label: settings.label, configured: Boolean(clientId && (secret || (id === 'apple' && appleKey))) };
  });
}

function localHttp(url: URL): boolean {
  return url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
}

function secureOrigin(request: Request): URL {
  const url = new URL(request.url);
  if (url.protocol !== 'https:' && !localHttp(url)) throw new AuthError('insecure_origin');
  return url;
}

function cookieName(request: Request, suffix = 'session'): string {
  return `${localHttp(new URL(request.url)) ? '' : '__Host-'}community_${suffix}`;
}

function cookie(request: Request, suffix: string, value: string, maxAge: number, apple = false): string {
  const secure = !localHttp(new URL(request.url));
  return `${cookieName(request, suffix)}=${value}; Path=/; HttpOnly; ${secure ? 'Secure; ' : ''}SameSite=${apple ? 'None' : 'Lax'}; Max-Age=${maxAge}`;
}

function readCookie(request: Request, name: string): string | null {
  const matches = (request.headers.get('Cookie') || '').split(';').map((part) => part.trim()).filter((part) => part.startsWith(`${name}=`));
  if (matches.length !== 1) return null;
  const value = matches[0].slice(name.length + 1);
  return TOKEN_PATTERN.test(value) ? value : null;
}

function randomToken(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(32)));
}

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function hash(value: string): Promise<string> {
  return base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))));
}

export function safeCommunityReturnTo(value: string | null): string {
  if (!value || value.length > 1024 || !value.startsWith('/') || value.startsWith('//') || /[\\\x00-\x20\x7f]/.test(value)) return '/';
  try {
    const decoded = decodeURIComponent(value);
    if (decoded.startsWith('//') || /[\\\x00-\x1f\x7f]/.test(decoded)) return '/';
    const url = new URL(value, 'https://community.invalid');
    if (url.origin !== 'https://community.invalid' || url.pathname.startsWith('//') || url.pathname.startsWith('/api/')) return '/';
    return `${url.pathname}${url.search}${url.hash}`;
  } catch { return '/'; }
}

function redirect(location: string, cookies: string[] = []): Response {
  const headers = new Headers(responseHeaders);
  headers.set('Location', location);
  for (const item of cookies) headers.append('Set-Cookie', item);
  return new Response(null, { status: 303, headers });
}

function errorRedirect(request: Request, provider: CommunityProvider, code: AuthErrorCode, returnTo = '/'): Response {
  const url = new URL(safeCommunityReturnTo(returnTo), request.url);
  url.searchParams.set('auth_error', code);
  return redirect(`${url.pathname}${url.search}${url.hash}`, [cookie(request, `oauth_${provider}`, '', 0, provider === 'apple')]);
}

function requireConfigured(env: CommunityAuthEnv, provider: CommunityProvider): void {
  if (!communityProviders(env).find((item) => item.id === provider)?.configured) throw new AuthError('provider_unavailable', 503);
}

/** Only verified community sessions count as identity; legacy/OAI headers are ignored. */
export async function getCommunityIdentity(request: Request, env: CommunityAuthEnv): Promise<string | null> {
  const url = new URL(request.url);
  if (url.protocol !== 'https:' && !localHttp(url)) return null;
  const token = readCookie(request, cookieName(request));
  if (!token) return null;
  const row = await env.DB.prepare('SELECT s.user_id FROM community_sessions s JOIN community_users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?')
    .bind(await hash(token), Date.now()).first<{ user_id: string }>();
  return row?.user_id ?? null;
}

export async function communityMe(request: Request, env: CommunityAuthEnv): Promise<Response> {
  const providers = communityProviders(env);
  try {
    const identity = await getCommunityIdentity(request, env);
    const user = identity ? await env.DB.prepare('SELECT id, nickname FROM community_users WHERE id = ?').bind(identity).first<{ id: string; nickname: string }>() : null;
    return communityAuthJson({ signedIn: Boolean(user), user, providers });
  } catch {
    return communityAuthJson({ signedIn: false, user: null, providers, error: '로그인 상태를 확인하지 못했어요. 잠시 후 다시 시도해 주세요.' }, 503);
  }
}

export async function startCommunityOAuth(request: Request, env: CommunityAuthEnv, provider: CommunityProvider): Promise<Response> {
  try {
    const url = secureOrigin(request);
    requireConfigured(env, provider);
    if (request.headers.has('Origin') && request.headers.get('Origin') !== url.origin) throw new AuthError('invalid_state', 403);
    // Apple requires a registered HTTPS domain and a Secure SameSite=None transaction cookie.
    if (provider === 'apple' && (url.protocol !== 'https:' || ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw new AuthError('insecure_origin');
    const settings = PROVIDERS[provider];
    const state = randomToken();
    const browser = randomToken();
    const nonce = randomToken();
    const verifier = settings.pkce ? randomToken() : null;
    const callback = `${url.origin}/api/community-auth/${provider}/callback`;
    const returnTo = safeCommunityReturnTo(url.searchParams.get('return_to'));
    await env.DB.batch([
      env.DB.prepare('DELETE FROM community_oauth_flows WHERE expires_at <= ?').bind(Date.now()),
      env.DB.prepare('DELETE FROM community_kakao_events WHERE expires_at <= ?').bind(Date.now()),
      env.DB.prepare('UPDATE community_kakao_events SET subject_hash = NULL, occurred_before = NULL, blocked_until = NULL WHERE blocked_until <= ?').bind(Date.now()),
      env.DB.prepare('INSERT INTO community_oauth_flows (state_hash, provider, browser_hash, nonce, code_verifier, redirect_uri, return_to, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .bind(await hash(state), provider, await hash(browser), nonce, verifier, callback, returnTo, Date.now() + FLOW_SECONDS * 1000),
    ]);
    const authorization = new URL(settings.authorization);
    authorization.search = new URLSearchParams({ client_id: env[settings.clientId]!.trim(), redirect_uri: callback, response_type: 'code', state }).toString();
    if (verifier) {
      authorization.searchParams.set('code_challenge', await hash(verifier));
      authorization.searchParams.set('code_challenge_method', 'S256');
    }
    if (provider === 'google') {
      authorization.searchParams.set('scope', 'openid');
      authorization.searchParams.set('nonce', nonce);
    }
    if (provider === 'apple') {
      authorization.searchParams.set('response_mode', 'form_post');
      authorization.searchParams.set('nonce', nonce);
    }
    return redirect(authorization.toString(), [cookie(request, `oauth_${provider}`, browser, FLOW_SECONDS, provider === 'apple')]);
  } catch (error) {
    const code = error instanceof AuthError ? error.code : 'login_failed';
    const status = error instanceof AuthError ? error.status : 503;
    return communityAuthJson({ error: code === 'provider_unavailable' ? '이 로그인 연결은 아직 준비 중이에요. 비회원으로 둘러볼 수 있어요.' : '로그인을 시작하지 못했어요. 잠시 후 다시 시도해 주세요.', code }, status);
  }
}

async function limitedText(message: Request | Response, maxBytes: number): Promise<string> {
  if (Number(message.headers.get('Content-Length')) > maxBytes) throw new AuthError('login_failed');
  const reader = message.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxBytes) { await reader.cancel(); throw new AuthError('login_failed'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return new TextDecoder().decode(bytes);
}

async function providerJson(url: string, init: RequestInit, provider: CommunityProvider, kind: 'token' | 'userinfo', diagnostic: OAuthDiagnostic): Promise<Record<string, unknown>> {
  diagnostic.stage = `${kind}_request`;
  diagnostic.http_status = null;
  diagnostic.provider_code = null;
  const response = await fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(8000) });
  diagnostic.stage = `${kind}_response`;
  diagnostic.http_status = response.status;
  const data = JSON.parse(await limitedText(response, 65536));
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new AuthError('login_failed');
  diagnostic.provider_code = providerErrorCode(provider, data);
  if (!response.ok || data.error) throw new AuthError('login_failed');
  return data;
}

async function appleClientSecret(env: CommunityAuthEnv): Promise<string> {
  if (env.APPLE_CLIENT_SECRET?.trim()) return env.APPLE_CLIENT_SECRET.trim();
  const key = await importPKCS8(env.APPLE_PRIVATE_KEY!.replace(/\\n/g, '\n'), 'ES256');
  return new SignJWT({})
    .setProtectedHeader({ alg: 'ES256', kid: env.APPLE_KEY_ID!.trim() })
    .setIssuer(env.APPLE_TEAM_ID!.trim()).setAudience('https://appleid.apple.com')
    .setSubject(env.APPLE_CLIENT_ID!.trim()).setIssuedAt().setExpirationTime('5m').sign(key);
}

function subject(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 255 || /[\x00-\x20\x7f]/.test(value)) throw new AuthError('login_failed');
  return value;
}

async function exchangeIdentity(env: CommunityAuthEnv, flow: OAuthFlow, code: string, state: string, diagnostic: OAuthDiagnostic): Promise<string> {
  diagnostic.stage = 'client_credentials';
  const settings = PROVIDERS[flow.provider];
  const clientId = env[settings.clientId]!.trim();
  const secret = flow.provider === 'apple' ? await appleClientSecret(env) : env[settings.secret]!.trim();
  const body = new URLSearchParams({ grant_type: 'authorization_code', client_id: clientId, client_secret: secret, redirect_uri: flow.redirect_uri, code });
  if (flow.code_verifier) body.set('code_verifier', flow.code_verifier);
  if (flow.provider === 'naver' || flow.provider === 'kakao') body.set('state', state);
  const tokens = await providerJson(settings.token, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' }, body }, flow.provider, 'token', diagnostic);
  diagnostic.stage = 'token_validate';
  if (flow.provider === 'google' || flow.provider === 'apple') {
    if (typeof tokens.id_token !== 'string' || tokens.id_token.length > 16384) throw new AuthError('login_failed');
    diagnostic.stage = 'id_token_verify';
    const { payload } = await jwtVerify(tokens.id_token, jwks[flow.provider], {
      issuer: flow.provider === 'google' ? ['https://accounts.google.com', 'accounts.google.com'] : 'https://appleid.apple.com',
      audience: clientId, algorithms: ['RS256'], requiredClaims: ['sub', 'iss', 'aud', 'exp', 'iat', 'nonce'], clockTolerance: 30, maxTokenAge: '10m',
    });
    if (payload.nonce !== flow.nonce || (payload.azp !== undefined && payload.azp !== clientId) || (Array.isArray(payload.aud) && payload.aud.length > 1 && payload.azp !== clientId)) throw new AuthError('login_failed');
    return subject(payload.sub);
  }
  if (typeof tokens.access_token !== 'string' || !tokens.access_token || tokens.access_token.length > 8192 || String(tokens.token_type).toLowerCase() !== 'bearer') throw new AuthError('login_failed');
  const profile = await providerJson(flow.provider === 'kakao' ? 'https://kapi.kakao.com/v2/user/me' : 'https://openapi.naver.com/v1/nid/me', {
    method: 'GET', headers: { Authorization: `Bearer ${tokens.access_token}`, Accept: 'application/json' },
  }, flow.provider, 'userinfo', diagnostic);
  diagnostic.stage = 'userinfo_validate';
  if (flow.provider === 'kakao') {
    if (typeof profile.id !== 'number' || !Number.isSafeInteger(profile.id) || profile.id <= 0) throw new AuthError('login_failed');
    return String(profile.id);
  }
  if (profile.resultcode !== '00' || !profile.response || typeof profile.response !== 'object') throw new AuthError('login_failed');
  return subject((profile.response as Record<string, unknown>).id);
}

async function accountSession(env: CommunityAuthEnv, flow: OAuthFlow, providerSubject: string, oldToken: string | null): Promise<string> {
  const provider = flow.provider;
  const id = crypto.randomUUID();
  const token = randomToken();
  const tokenHash = await hash(token);
  const now = Date.now();
  if (flow.expires_at <= now) throw new AuthError('invalid_state');
  const subjectHash = await hash(`${provider}\0${providerSubject}`);
  const flowStartedAt = flow.expires_at - FLOW_SECONDS * 1000;
  const allowed = 'NOT EXISTS (SELECT 1 FROM community_kakao_events WHERE subject_hash = ? AND occurred_before >= ? AND blocked_until > ?)';
  // Account and session creation share one transaction with the unlink watermark check.
  // A callback started before unlink cannot resurrect its account or issue an orphan session.
  const statements = [
    env.DB.prepare(`INSERT INTO community_users (id, nickname, created_at) SELECT ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM community_accounts WHERE provider = ? AND subject = ?) AND ${allowed}`)
      .bind(id, `퇴근러${randomToken().slice(0, 4)}`, now, provider, providerSubject, subjectHash, flowStartedAt, now),
    env.DB.prepare('INSERT INTO community_accounts (provider, subject, user_id, created_at) SELECT ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM community_users WHERE id = ?) ON CONFLICT(provider, subject) DO NOTHING')
      .bind(provider, providerSubject, id, now, id),
    env.DB.prepare(`INSERT INTO community_sessions (token_hash, user_id, created_at, expires_at) SELECT ?, user_id, ?, ? FROM community_accounts WHERE provider = ? AND subject = ? AND ${allowed}`)
      .bind(tokenHash, now, now + SESSION_SECONDS * 1000, provider, providerSubject, subjectHash, flowStartedAt, now),
    env.DB.prepare('DELETE FROM community_sessions WHERE expires_at <= ?').bind(now),
  ];
  if (oldToken) statements.push(env.DB.prepare('DELETE FROM community_sessions WHERE token_hash = ? AND EXISTS (SELECT 1 FROM community_sessions WHERE token_hash = ?)').bind(await hash(oldToken), tokenHash));
  const results = await env.DB.batch(statements);
  if (results[2].meta.changes !== 1) throw new AuthError('login_failed');
  return token;
}

export async function finishCommunityOAuth(request: Request, env: CommunityAuthEnv, provider: CommunityProvider): Promise<Response> {
  let returnTo = '/';
  const diagnostic: OAuthDiagnostic = { stage: 'callback_validate', http_status: null, provider_code: null };
  try {
    const url = secureOrigin(request);
    requireConfigured(env, provider);
    if (provider === 'apple' ? request.method !== 'POST' : request.method !== 'GET') throw new AuthError('invalid_state');
    if (provider === 'apple' && !request.headers.get('Content-Type')?.toLowerCase().startsWith('application/x-www-form-urlencoded')) throw new AuthError('invalid_state');
    const parameters = provider === 'apple' ? new URLSearchParams(await limitedText(request, 16384)) : url.searchParams;
    const state = parameters.get('state') || '';
    const browser = readCookie(request, cookieName(request, `oauth_${provider}`));
    if (parameters.getAll('state').length !== 1 || !TOKEN_PATTERN.test(state) || !browser) throw new AuthError('invalid_state');
    const stateHash = await hash(state);
    const browserHash = await hash(browser);
    diagnostic.stage = 'state_lookup';
    const flow = await env.DB.prepare('SELECT * FROM community_oauth_flows WHERE state_hash = ? AND provider = ? AND browser_hash = ? AND expires_at > ?')
      .bind(stateHash, provider, browserHash, Date.now()).first<OAuthFlow>();
    if (!flow || flow.redirect_uri !== `${url.origin}/api/community-auth/${provider}/callback`) throw new AuthError('invalid_state');
    // A conditional delete is the one-time claim, even when callbacks race.
    diagnostic.stage = 'state_claim';
    const claim = await env.DB.prepare('DELETE FROM community_oauth_flows WHERE state_hash = ? AND provider = ? AND browser_hash = ? AND expires_at > ?')
      .bind(stateHash, provider, browserHash, Date.now()).run();
    if (claim.meta.changes !== 1) throw new AuthError('invalid_state');
    returnTo = safeCommunityReturnTo(flow.return_to);
    diagnostic.stage = 'authorization_response';
    if (parameters.has('error')) throw new AuthError('provider_denied');
    const code = parameters.get('code');
    if (parameters.getAll('code').length !== 1 || !code || code.length > 4096) throw new AuthError('login_failed');
    const providerSubject = await exchangeIdentity(env, flow, code, state, diagnostic);
    diagnostic.stage = 'session_write';
    diagnostic.http_status = null;
    diagnostic.provider_code = null;
    const oldToken = readCookie(request, cookieName(request));
    const token = await accountSession(env, flow, providerSubject, oldToken);
    return redirect(returnTo, [cookie(request, 'session', token, SESSION_SECONDS), cookie(request, `oauth_${provider}`, '', 0, provider === 'apple')]);
  } catch (error) {
    // Never log request URLs, headers, bodies, exception messages, tokens, codes or member IDs.
    // Every field below is a local enum, HTTP status, or explicitly allowlisted provider error.
    console.warn('community_oauth_failure', { provider, ...diagnostic });
    return errorRedirect(request, provider, error instanceof AuthError ? error.code : 'login_failed', returnTo);
  }
}

export async function logoutCommunity(request: Request, env: CommunityAuthEnv): Promise<Response> {
  try {
    const url = secureOrigin(request);
    if (request.method !== 'POST' || request.headers.get('Origin') !== url.origin || request.headers.get('Sec-Fetch-Site') === 'cross-site') return communityAuthJson({ error: '허용되지 않은 요청이에요.' }, 403);
    const token = readCookie(request, cookieName(request));
    if (token) await env.DB.prepare('DELETE FROM community_sessions WHERE token_hash = ?').bind(await hash(token)).run();
    const response = communityAuthJson({ ok: true });
    response.headers.append('Set-Cookie', cookie(request, 'session', '', 0));
    return response;
  } catch { return communityAuthJson({ error: '로그아웃하지 못했어요. 다시 시도해 주세요.' }, 503); }
}
