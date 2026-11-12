import { useEffect, useRef, useState, type FormEvent } from "react";
import { CompanyLabel } from "./CompanyLabel";

export type VerifiedCompany = { id: string; name: string; verifiedAt: number; expiresAt: number; isAdmin: boolean };
type Props = { company: VerifiedCompany | null; onVerified: (company: VerifiedCompany) => void; onAuthExpired: () => void };

export function CompanyVerification({ company, onVerified, onAuthExpired }: Props) {
  const [editing, setEditing] = useState(!company);
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [sent, setSent] = useState<{ company: { id: string; name: string }; expiresAt: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => { pending.current?.abort(); pending.current = null; }, []);

  async function submit(event: FormEvent, action: "send-code" | "verify-code") {
    event.preventDefault();
    if (pending.current) return;
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true); setError("");
    try {
      const response = await fetch(`/api/community-company/${action}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(action === "send-code" ? { email } : { code }), signal: controller.signal,
      });
      const data = await response.json() as { error?: string; company: VerifiedCompany; expiresAt: number };
      if (pending.current !== controller) return;
      if (response.status === 401) { onAuthExpired(); return; }
      if (!response.ok) throw new Error(data.error || "회사 인증을 완료하지 못했어요. 다시 시도해 주세요.");
      if (action === "send-code") { setSent(data); setCode(""); }
      else onVerified(data.company);
    } catch (cause) {
      if (pending.current === controller) setError((cause as Error).message);
    } finally {
      if (pending.current === controller) { pending.current = null; setBusy(false); }
    }
  }

  return <div className="company-verification">
    <h2>회사 이메일 인증</h2>
    <p className="modal-subtitle">회사 이메일로 받은 코드를 확인해요.<br />인증한 회사명은 글마다 공개 여부를 선택할 수 있어요.</p>
    {company && <div className="company-verified"><strong>{company.name}{company.isAdmin && <CompanyLabel name={company.name} isAdmin />}</strong><span>이메일 인증 완료 · {new Intl.DateTimeFormat("ko-KR", { year: "numeric", month: "long", day: "numeric" }).format(company.expiresAt)}까지</span>{company.isAdmin && <p>회사 공개를 선택한 글에는 ‘관리자’로 표시돼요.</p>}{!editing && <button type="button" onClick={() => setEditing(true)}>다른 회사 인증 / 다시 인증</button>}</div>}
    {editing && <>
      <form onSubmit={event => void submit(event, "send-code")}>
        <label htmlFor="company-email">회사 이메일</label>
        <input id="company-email" type="email" autoComplete="email" placeholder="name@company.com" required maxLength={254} value={email} disabled={busy} onChange={event => { setEmail(event.target.value); setSent(null); setCode(""); setError(""); }} />
        <button className="secondary full-width" disabled={busy || !email.trim()}>{busy ? "처리하는 중…" : sent ? "인증코드 다시 받기" : "인증코드 받기"}</button>
      </form>
      {sent && <form onSubmit={event => void submit(event, "verify-code")}>
        <p className="company-code-notice" role="status"><strong>{sent.company.name}</strong> 인증 메일을 보냈어요. 받은 편지함과 스팸함을 확인해 주세요.<br />{new Intl.DateTimeFormat("ko-KR", { hour: "2-digit", minute: "2-digit" }).format(sent.expiresAt)}까지 가장 최근에 받은 코드를 입력해 주세요.</p>
        <label htmlFor="company-code">6자리 인증코드</label>
        <input id="company-code" type="text" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} minLength={6} required placeholder="000000" value={code} disabled={busy} onChange={event => setCode(event.target.value.replace(/\D/g, "").slice(0, 6))} />
        <button className="primary full-width" disabled={busy || code.length !== 6}>{busy ? "확인하는 중…" : "회사 인증 완료하기"}</button>
      </form>}
    </>}
    {error && <p className="form-error" role="alert">{error}</p>}
    <p className="company-privacy">이메일 주소는 게시글에 공개되지 않아요.<br />회사 이메일 접근 권한을 확인하는 인증이며, 90일 동안 유효해요.</p>
    <p className="company-help">등록되지 않은 회사라면 <a href="mailto:contact@workfolio.life">contact@workfolio.life</a>로 회사명과 이메일 도메인을 알려 주세요.</p>
  </div>;
}
