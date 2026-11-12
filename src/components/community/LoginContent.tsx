export type LoginProvider = { id: string; label: string; configured: boolean };

const providers = [
  { id: "kakao", name: "카카오", mark: "●" },
  { id: "naver", name: "네이버", mark: "N" },
  { id: "google", name: "Google", mark: "G" },
  { id: "apple", name: "Apple", mark: "" },
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
  return (
    <>
      <div className="login-intro">
        <span className="eyebrow">퇴근했으면, 우리 편</span>
        <h2>이제 같이 떠들어요.</h2>
        <p>글쓰기·댓글·공감은 로그인하고 함께해요.<br />읽기는 로그인 없이도 자유롭게.</p>
      </div>
      <div className="social-options" aria-label="소셜 로그인">
        {providers.map((provider) => {
          const configured = availableProviders.some((item) => item.id === provider.id && item.configured);
          const content = <>
            <span className="provider-mark" aria-hidden="true">
              {provider.id === "apple" ? (
                <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
                  <path d="M16.5 12.6c0-2.1 1.7-3.1 1.8-3.2-1-1.5-2.5-1.7-3.1-1.8-1.3-.1-2.5.8-3.2.8-.6 0-1.6-.8-2.7-.7-1.4 0-2.8.9-3.5 2.1-1.5 2.6-.4 6.4 1.1 8.5.7 1 1.5 2.1 2.6 2 1-.1 1.5-.7 2.8-.7 1.3 0 1.7.7 2.8.7 1.2 0 1.9-1 2.6-2 .8-1.2 1.1-2.3 1.2-2.4-.1 0-2.4-.9-2.4-3.3ZM14.4 6.3c.6-.8 1.1-1.9 1-3-.9.1-2 .6-2.7 1.4-.6.7-1.2 1.8-1 2.9 1 .1 2.1-.5 2.7-1.3Z" />
                </svg>
              ) : provider.mark}
            </span>
            <span className="provider-label">{provider.name}로 계속하기</span>
            {!configured && <span className="provider-status">{loading ? "확인 중…" : "연결 설정 필요"}</span>}
          </>;
          return configured ? <a
            key={provider.id}
            className={`social-provider ${provider.id}`}
            href={`/api/community-auth/${provider.id}?return_to=${encodeURIComponent(returnTo)}`}
            aria-label={`${provider.name}로 로그인`}
          >{content}</a> : <button key={provider.id} type="button" className={`social-provider ${provider.id}`} disabled aria-label={`${provider.name} 로그인 — ${loading ? "연결 확인 중" : "연결 설정 필요"}`}>{content}</button>;
        })}
      </div>
      {error && <div className="login-error" role="alert"><p>{error}</p><button type="button" onClick={onRetry}>다시 확인</button></div>}
      {!loading && availableProviders.length > 0 && availableProviders.some((provider) => !provider.configured) && <p className="login-note">‘연결 설정 필요’로 표시된 로그인은 아직 이용할 수 없어요.</p>}
      <button type="button" className="guest-continue" onClick={onClose}>
        로그인 없이 둘러보기 <span aria-hidden="true">→</span>
      </button>
      <p className="login-note">로그인한 계정 정보는 게시글에 공개되지 않아요.<br />게시판에서는 직접 정한 별명으로 이야기해요.</p>
    </>
  );
}
