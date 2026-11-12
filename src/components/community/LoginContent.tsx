import { useState } from "react";

export type LoginProvider = { id: string; label: string; configured: boolean };

const providers = [
  { id: "kakao", name: "카카오", icon: "/auth/kakao-symbol.svg" },
  { id: "naver", name: "네이버", icon: "/auth/naver-icon.png" },
  { id: "google", name: "Google", icon: "/auth/google-g.png" },
] as const;

type Props = {
  onClose: () => void;
  providers: LoginProvider[];
  loading: boolean;
  error: string;
  onRetry: () => void;
  returnTo: string;
};

export function LoginContent({ onClose, providers: availableProviders, loading, error, onRetry, returnTo }: Props) {
  const [rememberMe, setRememberMe] = useState(true);
  return (
    <>
      <div className="login-intro">
        <span className="eyebrow">퇴근했으면, 우리 편</span>
        <h2>이제 같이 떠들어요.</h2>
        <p>글쓰기·댓글·공감은 로그인하고 함께해요.<br />읽기는 로그인 없이도 자유롭게.</p>
      </div>
      <div className="remember-login">
        <label><input type="checkbox" checked={rememberMe} onChange={event => setRememberMe(event.target.checked)} aria-describedby="remember-login-description" /><span>로그인 유지</span></label>
        <p id="remember-login-description">{rememberMe ? "브라우저를 닫아도 유지돼요. 로그인 유지 기간은 14일이며, 이용 중에는 주기적으로 갱신돼요." : "브라우저를 닫거나 12시간이 지나면 다시 로그인해요."}</p>
        <small>공용 기기에서는 선택을 해제해 주세요.</small>
      </div>
      <div className="social-options" aria-label="소셜 로그인">
        {providers.map((provider) => {
          const configured = availableProviders.some((item) => item.id === provider.id && item.configured);
          const content = <>
            <span className="provider-mark" aria-hidden="true">
              <img src={provider.icon} alt="" width={provider.id === "naver" ? 44 : 20} height={provider.id === "naver" ? 44 : 20} />
            </span>
            <span className="provider-label">{provider.name}로 계속하기</span>
            {!configured && <span className="provider-status">{loading ? "확인 중…" : "준비 중"}</span>}
          </>;
          return configured ? <a
            key={provider.id}
            className={`social-provider ${provider.id}`}
            href={`/api/community-auth/${provider.id}?return_to=${encodeURIComponent(returnTo)}&remember_me=${rememberMe ? "1" : "0"}`}
            aria-label={`${provider.name}로 로그인`}
          >{content}</a> : <button key={provider.id} type="button" className={`social-provider ${provider.id}`} disabled aria-label={`${provider.name} 로그인 — ${loading ? "연결 확인 중" : "준비 중"}`}>{content}</button>;
        })}
      </div>
      {error && <div className="login-error" role="alert"><p>{error}</p><button type="button" onClick={onRetry}>다시 확인</button></div>}
      {!loading && availableProviders.length > 0 && availableProviders.some((provider) => providers.some((visible) => visible.id === provider.id) && !provider.configured) && <p className="login-note">‘준비 중’으로 표시된 로그인은 아직 이용할 수 없어요.</p>}
      <button type="button" className="guest-continue" onClick={onClose}>
        로그인 없이 둘러보기 <span aria-hidden="true">→</span>
      </button>
      <p className="login-note">로그인한 계정 정보는 게시글에 공개되지 않아요.<br />게시판에서는 직접 정한 별명으로 이야기해요.</p>
      <nav className="community-policy-links login-policy-links" aria-label="로그인 이용 안내">
        <a href="/privacy" target="_blank" rel="noopener noreferrer">개인정보처리방침</a>
        <a href="/terms" target="_blank" rel="noopener noreferrer">이용약관</a>
        <a href="mailto:contact@workfolio.life">문의</a>
      </nav>
    </>
  );
}
