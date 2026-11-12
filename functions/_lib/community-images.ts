import { getCommunityIdentity, type CommunityAuthEnv } from './community-auth';
import { BoardError, checkMutationRequest, type PostImage } from '../../src/lib/community/domain';

export interface CommunityImageEnv extends CommunityAuthEnv { COMMUNITY_IMAGES?: R2Bucket }
export const IMAGE_BYTES = 5 * 1024 * 1024;
const IMAGE_TTL = 24 * 60 * 60 * 1000;
const IMAGE_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const privateHeaders = { 'Cache-Control': 'private, no-store', Vary: 'Cookie', 'X-Content-Type-Options': 'nosniff' };
type StoredImage = { id: string; owner_id: string; object_key: string; post_id: string | null; status: string; content_type: string; byte_size: number; width: number; height: number; expires_at: number };
export function publicImage(row: Pick<StoredImage, 'id' | 'width' | 'height'>): PostImage {
  return { id: row.id, url: `/api/community-images/${row.id}`, width: row.width, height: row.height };
}
export async function readPostImages(db: D1Database, postId: string): Promise<PostImage[]> {
  const rows = await db.prepare(`SELECT i.id, i.width, i.height FROM community_post_images i
    JOIN community_posts p ON p.id = i.post_id WHERE i.post_id = ? AND i.status = 'attached' ORDER BY i.position, i.id`).bind(postId).all<StoredImage>();
  return rows.results.map(publicImage);
}
function json(data: unknown, status = 200) {
  return Response.json(data, { status, headers: status === 429 ? { ...privateHeaders, 'Retry-After': '3600' } : privateHeaders });
}
export function imageFailure(error: unknown): Response {
  if (error instanceof BoardError) return json({ error: error.message }, error.status);
  return json({ error: '이미지를 처리하지 못했어요. 잠시 후 다시 시도해 주세요.' }, 503);
}
function storage(env: CommunityImageEnv): R2Bucket {
  if (!env.DB || !env.COMMUNITY_IMAGES) throw new BoardError('이미지 저장소를 준비하고 있어요. 잠시 후 다시 시도해 주세요.', 503);
  return env.COMMUNITY_IMAGES;
}
function imageId(value: unknown): string {
  if (typeof value !== 'string' || !IMAGE_ID.test(value)) throw new BoardError('이미지를 찾을 수 없어요.', 404);
  return value;
}
async function readImageBody(request: Request): Promise<Uint8Array> {
  if (!request.body) throw new BoardError('첨부할 이미지를 선택해 주세요.');
  if (Number(request.headers.get('content-length')) > IMAGE_BYTES) throw new BoardError('이미지는 한 장에 5MB 이하로 올려 주세요.', 413);
  const reader = request.body.getReader(), chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > IMAGE_BYTES) { await reader.cancel(); throw new BoardError('이미지는 한 장에 5MB 이하로 올려 주세요.', 413); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes;
}
// Read dimensions from the actual raster container, never from a client filename or supplied metadata.
export function inspectImage(bytes: Uint8Array, contentType: string): { width: number; height: number } {
  const invalid = () => new BoardError('올바른 JPG, PNG, WebP 이미지 파일을 선택해 주세요.', 415);
  if (bytes.length < 24) throw invalid();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const text = (start: number, length: number) => String.fromCharCode(...bytes.subarray(start, start + length));
  let width = 0, height = 0;
  if (contentType === 'image/png') {
    if (!bytes.subarray(0, 8).every((value, index) => value === [137,80,78,71,13,10,26,10][index]) || view.getUint32(8) !== 13 || text(12, 4) !== 'IHDR') throw invalid();
    width = view.getUint32(16); height = view.getUint32(20);
    let offset = 8, hasData = false, ended = false;
    while (offset + 12 <= bytes.length) {
      const length = view.getUint32(offset), kind = text(offset + 4, 4);
      if (offset + 12 + length > bytes.length) throw invalid();
      if (['acTL','fcTL','fdAT'].includes(kind)) throw invalid();
      if (kind === 'IDAT') hasData = true;
      offset += 12 + length;
      if (kind === 'IEND') { ended = length === 0 && offset === bytes.length; break; }
    }
    if (!hasData || !ended) throw invalid();
  } else if (contentType === 'image/jpeg') {
    if (bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes.at(-2) !== 0xff || bytes.at(-1) !== 0xd9) throw invalid();
    let offset = 2, hasScan = false;
    while (offset + 4 <= bytes.length) {
      if (bytes[offset++] !== 0xff) throw invalid();
      while (bytes[offset] === 0xff) offset++;
      const marker = bytes[offset++];
      if (marker === 0xda) { hasScan = true; break; }
      if (marker === 0xd9 || marker === 0x00 || marker === 0xd8) throw invalid();
      const length = view.getUint16(offset);
      if (length < 2 || offset + length > bytes.length) throw invalid();
      if ([0xc0,0xc1,0xc2].includes(marker)) {
        if (length < 8 || width) throw invalid();
        height = view.getUint16(offset + 3); width = view.getUint16(offset + 5);
      }
      offset += length;
    }
    if (!hasScan) throw invalid();
  } else if (contentType === 'image/webp') {
    if (text(0,4) !== 'RIFF' || text(8,4) !== 'WEBP' || view.getUint32(4,true) + 8 !== bytes.length) throw invalid();
    let offset = 12, hasRaster = false, canvasWidth = 0, canvasHeight = 0;
    while (offset + 8 <= bytes.length) {
      const kind = text(offset,4), length = view.getUint32(offset + 4,true), start = offset + 8;
      if (start + length > bytes.length) throw invalid();
      if (kind === 'VP8X') {
        if (length !== 10 || canvasWidth) throw invalid();
        canvasWidth = 1 + bytes[start+4] + (bytes[start+5] << 8) + (bytes[start+6] << 16);
        canvasHeight = 1 + bytes[start+7] + (bytes[start+8] << 8) + (bytes[start+9] << 16);
      } else if (kind === 'VP8 ' && length >= 10) {
        if (hasRaster) throw invalid();
        if (bytes[start + 3] !== 0x9d || bytes[start + 4] !== 0x01 || bytes[start + 5] !== 0x2a) throw invalid();
        width = view.getUint16(start + 6,true) & 0x3fff; height = view.getUint16(start + 8,true) & 0x3fff; hasRaster = true;
      } else if (kind === 'VP8L' && length >= 5) {
        if (hasRaster) throw invalid();
        if (bytes[start] !== 0x2f) throw invalid();
        const bits = view.getUint32(start + 1,true);
        width = (bits & 0x3fff) + 1; height = ((bits >>> 14) & 0x3fff) + 1; hasRaster = true;
      } else if (kind === 'ANIM' || kind === 'ANMF') throw invalid();
      offset = start + length + (length % 2);
    }
    if (!hasRaster || offset !== bytes.length || (canvasWidth && (canvasWidth !== width || canvasHeight !== height))) throw invalid();
  } else throw invalid();
  if (!width || !height || width > 12000 || height > 12000 || width * height > 40000000) throw new BoardError('이미지 해상도가 너무 커요. 크기를 줄여 다시 올려 주세요.', 413);
  return { width, height };
}

export async function cleanupImages(env: CommunityImageEnv): Promise<void> {
  const bucket = storage(env), now = Date.now();
  const rows = await env.DB.prepare(`SELECT id, object_key FROM community_post_images
    WHERE status = 'deleted' OR (status IN ('uploading','pending') AND expires_at <= ?) LIMIT 20`).bind(now).all<StoredImage>();
  for (const row of rows.results) {
    // Claim the row before touching R2: a concurrent post may have attached it since the SELECT.
    const claimed = await env.DB.prepare(`UPDATE community_post_images SET status = 'deleted' WHERE id = ?
      AND (status = 'deleted' OR (status IN ('uploading','pending') AND expires_at <= ?)) RETURNING object_key`).bind(row.id,now).first<{object_key:string}>();
    if (!claimed) continue;
    await bucket.delete(claimed.object_key);
    await env.DB.prepare("DELETE FROM community_post_images WHERE id = ? AND status = 'deleted'").bind(row.id).run();
  }
}
export async function uploadImage(request: Request, env: CommunityImageEnv): Promise<Response> {
  const origin = request.headers.get('origin');
  if (!origin || origin !== new URL(request.url).origin || request.headers.get('sec-fetch-site') === 'cross-site') throw new BoardError('이 페이지에서 다시 시도해 주세요.', 403);
  const userId = await getCommunityIdentity(request, env);
  if (!userId) throw new BoardError('이미지를 올리려면 먼저 로그인해 주세요.', 401);
  const bucket = storage(env), now = Date.now();
  const contentType = request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() || '';
  if (!['image/jpeg','image/png','image/webp'].includes(contentType)) throw new BoardError('JPG, PNG, WebP 이미지만 첨부할 수 있어요.', 415);
  const accepted = await env.DB.prepare(`INSERT INTO community_image_upload_limits (owner_id,window_started_at,attempts) VALUES (?,?,1)
    ON CONFLICT(owner_id) DO UPDATE SET
    window_started_at = CASE WHEN community_image_upload_limits.window_started_at <= excluded.window_started_at - 3600000 THEN excluded.window_started_at ELSE community_image_upload_limits.window_started_at END,
    attempts = CASE WHEN community_image_upload_limits.window_started_at <= excluded.window_started_at - 3600000 THEN 1 ELSE community_image_upload_limits.attempts + 1 END
    WHERE community_image_upload_limits.window_started_at <= excluded.window_started_at - 3600000 OR community_image_upload_limits.attempts < 30 RETURNING attempts`).bind(userId,now).first();
  if (!accepted) throw new BoardError('이미지를 많이 올렸어요. 잠시 후 다시 시도해 주세요.', 429);
  const bytes = await readImageBody(request), dimensions = inspectImage(bytes, contentType);
  const id = crypto.randomUUID(), key = `community/${id}`;
  const reserved = await env.DB.prepare(`INSERT INTO community_post_images (id,owner_id,object_key,status,content_type,byte_size,width,height,created_at,expires_at)
    SELECT ?,?,?,'uploading',?,?,?,?,?,? WHERE (SELECT COUNT(*) FROM community_post_images WHERE owner_id = ? AND status IN ('uploading','pending') AND expires_at > ?) < 20`)
    .bind(id,userId,key,contentType,bytes.length,dimensions.width,dimensions.height,now,now + IMAGE_TTL,userId,now).run();
  if (!reserved.meta.changes) throw new BoardError('작성 중인 이미지가 많아요. 사용하지 않는 첨부를 지운 뒤 다시 올려 주세요.', 429);
  try {
    await bucket.put(key,bytes,{ httpMetadata: { contentType } });
    await env.DB.prepare("UPDATE community_post_images SET status = 'pending' WHERE id = ? AND status = 'uploading'").bind(id).run();
  } catch (error) {
    // Retain a tombstone if object deletion fails so a later upload retries cleanup.
    await env.DB.prepare("UPDATE community_post_images SET status = 'deleted' WHERE id = ?").bind(id).run();
    throw error;
  }
  return json({ image: publicImage({ id, ...dimensions }) },201);
}
export async function serveImage(request: Request, env: CommunityImageEnv, value: unknown): Promise<Response> {
  const id = imageId(value), bucket = storage(env);
  const row = await env.DB.prepare(`SELECT i.*, EXISTS (SELECT 1 FROM community_posts p WHERE p.id = i.post_id) AS live_post FROM community_post_images i WHERE i.id = ?`).bind(id).first<StoredImage & {live_post:number}>();
  const published = row?.status === 'attached' && row.live_post === 1;
  if (!row || (!published && !(row.status === 'pending' && row.expires_at > Date.now() && row.owner_id === await getCommunityIdentity(request,env)))) throw new BoardError('이미지를 찾을 수 없어요.',404);
  const object = await bucket.get(row.object_key);
  if (!object) throw new BoardError('이미지를 찾을 수 없어요.',404);
  const headers = new Headers({ 'Content-Type': row.content_type, 'Content-Length': String(row.byte_size), 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox", 'Cache-Control': published ? 'public, max-age=0, must-revalidate' : 'private, no-store', ETag: object.httpEtag });
  if (!published) headers.set('Vary','Cookie');
  if (published && request.headers.get('if-none-match') === object.httpEtag) return new Response(null,{status:304,headers});
  return new Response(request.method === 'HEAD' ? null : object.body,{headers});
}
export async function discardImage(request: Request, env: CommunityImageEnv, value: unknown): Promise<Response> {
  checkMutationRequest(request);
  const userId = await getCommunityIdentity(request,env);
  if (!userId) throw new BoardError('먼저 로그인해 주세요.',401);
  storage(env);
  const id = imageId(value);
  const result = await env.DB.prepare("UPDATE community_post_images SET status = 'deleted' WHERE id = ? AND owner_id = ? AND status = 'pending'").bind(id,userId).run();
  if (!result.meta.changes) throw new BoardError('삭제할 첨부 이미지를 찾을 수 없어요.',404);
  return json({ok:true});
}
