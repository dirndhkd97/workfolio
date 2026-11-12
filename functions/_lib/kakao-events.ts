import { createRemoteJWKSet, errors, jwtVerify } from 'jose';
import type { CommunityAuthEnv } from './community-auth';

const ISSUER = 'https://kauth.kakao.com';
const UNLINK = 'https://schemas.openid.net/secevent/oauth/event-type/user-unlinked';
// Kakao retries for about 130 minutes. Four hours allows retries without accepting old SETs.
const MAX_AGE_SECONDS = 4 * 60 * 60;
const CLOCK_TOLERANCE = 60;
const keys = createRemoteJWKSet(new URL(`${ISSUER}/.well-known/jwks.json`), { timeoutDuration: 1500 });
const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
type Failure = 'invalid_request' | 'invalid_key' | 'invalid_issuer' | 'invalid_audience';

class InvalidEvent extends Error {
  constructor(public code: Failure = 'invalid_request') { super(code); }
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function identifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 255 && !/[\x00-\x20\x7f]/.test(value);
}

async function digest(value: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function readSet(request: Request): Promise<string> {
  const limit = 16384;
  if (Number(request.headers.get('Content-Length')) > limit) throw new InvalidEvent();
  const reader = request.body?.getReader();
  if (!reader) throw new InvalidEvent();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel(); throw new InvalidEvent(); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return new TextDecoder().decode(bytes);
}

/** Only OAUTH User Unlinked is subscribed; no Admin key or user-profile scope is needed. */
export async function receiveKakaoEvent(request: Request, env: CommunityAuthEnv): Promise<Response> {
  if (request.method !== 'POST') return new Response(null, { status: 405, headers: { ...headers, Allow: 'POST' } });
  if (!env.KAKAO_CLIENT_ID?.trim()) return new Response(null, { status: 503, headers });
  try {
    if (request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/secevent+jwt') throw new InvalidEvent();
    const { payload, protectedHeader } = await jwtVerify(await readSet(request), keys, {
      issuer: ISSUER, audience: env.KAKAO_CLIENT_ID.trim(), algorithms: ['RS256'], typ: 'secevent+jwt',
      requiredClaims: ['sub', 'iss', 'aud', 'iat', 'jti', 'toe', 'app_id', 'txm', 'events'],
      maxTokenAge: MAX_AGE_SECONDS, clockTolerance: CLOCK_TOLERANCE,
    });
    const now = Date.now();
    const seconds = Math.floor(now / 1000);
    if (protectedHeader.typ !== 'secevent+jwt' || !identifier(protectedHeader.kid) || !identifier(payload.jti) || !identifier(payload.txm)
      || typeof payload.aud !== 'string' || payload.aud !== env.KAKAO_CLIENT_ID.trim()
      || typeof payload.app_id !== 'string' || !/^[1-9]\d*$/.test(payload.app_id)
      || typeof payload.sub !== 'string' || !/^[1-9]\d{0,31}$/.test(payload.sub)
      || !Number.isSafeInteger(payload.iat) || !Number.isSafeInteger(payload.toe)
      || (payload.toe as number) <= 0 || (payload.toe as number) > seconds + CLOCK_TOLERANCE
      || (payload.toe as number) > payload.iat! + CLOCK_TOLERANCE
      || (payload.toe as number) < seconds - MAX_AGE_SECONDS - CLOCK_TOLERANCE
      || !object(payload.events) || Object.keys(payload.events).length !== 1 || !Object.hasOwn(payload.events, UNLINK)) throw new InvalidEvent();
    const event = payload.events[UNLINK];
    if (!object(event) || !object(event.subject) || event.subject.subject_type !== 'iss-sub'
      || event.subject.iss !== ISSUER || event.subject.sub !== payload.sub || !identifier(event.reason)) throw new InvalidEvent();

    const eventHash = await digest(`${ISSUER}\0${payload.aud}\0${payload.jti}`);
    const subjectHash = await digest(`kakao\0${payload.sub}`);
    // toe has whole-second precision, so callbacks started in that second are blocked too.
    const occurredBefore = ((payload.toe as number) + 1) * 1000;
    await env.DB.batch([
      env.DB.prepare('DELETE FROM community_kakao_events WHERE expires_at <= ?').bind(now),
      env.DB.prepare('UPDATE community_kakao_events SET subject_hash = NULL, occurred_before = NULL, blocked_until = NULL WHERE blocked_until <= ?').bind(now),
      env.DB.prepare('INSERT INTO community_kakao_events (event_hash, subject_hash, occurred_before, blocked_until, expires_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(event_hash) DO NOTHING')
        .bind(eventHash, subjectHash, occurredBefore, now + 11 * 60 * 1000, now + 24 * 60 * 60 * 1000),
      // A delayed first delivery still revokes: created_at cannot prove when OAuth consent occurred.
      env.DB.prepare("DELETE FROM community_sessions WHERE user_id IN (SELECT user_id FROM community_accounts WHERE provider = 'kakao' AND subject = ?) AND EXISTS (SELECT 1 FROM community_kakao_events WHERE event_hash = ? AND processed_at IS NULL)")
        .bind(payload.sub, eventHash),
      env.DB.prepare("DELETE FROM community_accounts WHERE provider = 'kakao' AND subject = ? AND EXISTS (SELECT 1 FROM community_kakao_events WHERE event_hash = ? AND processed_at IS NULL)")
        .bind(payload.sub, eventHash),
      env.DB.prepare('UPDATE community_kakao_events SET processed_at = ? WHERE event_hash = ? AND processed_at IS NULL').bind(now, eventHash),
    ]);
    // Includes unknown users and duplicate delivery; no raw token/member number is logged or retained.
    return new Response(null, { status: 202, headers });
  } catch (error) {
    let code: Failure;
    if (error instanceof InvalidEvent) code = error.code;
    else if (error instanceof errors.JWTClaimValidationFailed) code = error.claim === 'iss' ? 'invalid_issuer' : error.claim === 'aud' ? 'invalid_audience' : 'invalid_request';
    else if (error instanceof errors.JWSSignatureVerificationFailed || error instanceof errors.JWKSNoMatchingKey || error instanceof errors.JOSEAlgNotAllowed) code = 'invalid_key';
    else if (error instanceof errors.JWTInvalid || error instanceof errors.JWSInvalid || error instanceof errors.JWTExpired || error instanceof errors.JOSENotSupported) code = 'invalid_request';
    // Storage/key-fetch failures must be retried by Kakao, not acknowledged as completed.
    else return new Response(null, { status: 503, headers });
    return Response.json({ err: code, description: 'The security event token could not be validated.' }, { status: 400, headers });
  }
}
