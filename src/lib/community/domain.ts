export const CATEGORIES = ["웃픈 실수", "황당한 순간", "회사 사람들", "소소한 일상", "빡대가리 게시판", "월급루팡"] as const;
export const REACTIONS = ["same", "laugh", "cheer"] as const;
export type Category = (typeof CATEGORIES)[number];
export type Reaction = (typeof REACTIONS)[number];
export interface Post {
  id: string;
  title: string;
  body: string;
  category: Category;
  nickname: string;
  createdAt: number;
  sample: boolean;
  reactions: Record<Reaction, number>;
  myReactions: Reaction[];
  commentCount: number;
  mine: boolean;
}
export interface Comment { id: string; body: string; nickname: string; createdAt: number }
export const LIMITS = { title: 80, body: 3000, nickname: 20, comment: 500, report: 500, requestBytes: 16384 } as const;
export class BoardError extends Error {
  status: number;
  constructor(message: string, status = 400) { super(message); this.name = "BoardError"; this.status = status; }
}
// This is a precaution, not a guarantee of anonymization. Names and employers can still identify people.
export function hasContactDetails(text: string): boolean {
  return /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(text)
    || /(?:\+?82[- .]?)?0?1[016789][- .]?\d{3,4}[- .]?\d{4}/.test(text)
    || /\b(?:\+\d{1,3}[- .]?)?(?:\(?\d{2,3}\)?[- .])\d{3,4}[- .]\d{4}\b/.test(text)
    || /(?:https?:\/\/|www\.)\S+/i.test(text);
}
export function textField(value: unknown, label: string, max: number, min = 1): string {
  if (typeof value !== "string") throw new BoardError(`${label}을(를) 입력해 주세요.`);
  const text = value.trim().normalize("NFC");
  if (text.length < min || text.length > max) throw new BoardError(`${label}은(는) ${min}~${max}자 이내로 입력해 주세요.`);
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) throw new BoardError("사용할 수 없는 제어 문자가 포함되어 있어요.");
  if (hasContactDetails(text)) throw new BoardError("연락처·이메일·링크를 지우고 다시 올려 주세요. 실명과 회사명도 한 번 더 확인해 주세요.");
  return text;
}
export function validPostId(value: unknown): string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/.test(value)) throw new BoardError("올바른 이야기 주소가 아니에요.");
  return value;
}
export function validateCreate(data: Record<string, unknown>) {
  if (!CATEGORIES.includes(data.category as Category)) throw new BoardError("이야기 주제를 골라 주세요.");
  return {
    title: textField(data.title, "제목", LIMITS.title, 2),
    body: textField(data.body, "이야기", LIMITS.body, 10),
    nickname: textField(data.nickname || "익명의 동료", "별명", LIMITS.nickname),
    category: data.category as Category,
  };
}
export function checkMutationRequest(request: Request): void {
  const origin = request.headers.get("origin");
  if (!origin || origin !== new URL(request.url).origin || request.headers.get("sec-fetch-site") === "cross-site") {
    throw new BoardError("이 페이지에서 다시 시도해 주세요.", 403);
  }
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
    throw new BoardError("JSON 형식으로 요청해 주세요.", 415);
  }
  const length = request.headers.get("content-length");
  if (length && Number(length) > LIMITS.requestBytes) throw new BoardError("내용이 너무 길어요.", 413);
}
export async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  if (!request.body) throw new BoardError("내용을 입력해 주세요.");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > LIMITS.requestBytes) { await reader.cancel(); throw new BoardError("내용이 너무 길어요.", 413); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.length; }
  let data: unknown;
  try { data = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(joined)); } catch { throw new BoardError("요청 내용을 읽을 수 없어요."); }
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new BoardError("올바른 요청이 아니에요.");
  return data as Record<string, unknown>;
}
