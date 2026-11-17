import { useCallback, useEffect, useId, useRef, useState, type MouseEvent } from "react";
import {
  ArrowLeft, Bell, ChevronRight, Flame, Heart, HelpCircle, Home, LogIn, LogOut, Menu,
  MessageCircle, PenLine, Search, ShieldCheck, Users, Plus, X,
} from "lucide-react";
import { BOARD_PAGES, boardPath } from "../../lib/community/seo";

import type { ChannelPanelTab } from "../../lib/community/channel-client";

type Notice = { id: string; postId: string; postTitle: string; createdAt: number; read: boolean } & (
  | { kind: "comment" }
  | { kind: "like"; likeCount: number }
);
type View = "menu" | "inbox" | null;
type Props = {
  signedIn: boolean;
  busy: boolean;
  onWrite: () => void;
  onCompany: () => void;
  onLogin: () => void;
  onLogout: () => void;
  onSessionExpired: (showLogin: boolean) => void;
  onOpenPost: (id: string) => void;
  onFeed: () => void;
  onTrending: () => void;
  onChannels: (tab: ChannelPanelTab) => void;
  onBoard: (event: MouseEvent<HTMLAnchorElement>, category: string) => void;
  onGuide: () => void;
  onSearch: () => void;
};

const endpoint = "/api/community-notifications";
const dateFormat = new Intl.DateTimeFormat("ko-KR", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

export function CommunityMenu({
  signedIn, busy, onWrite, onCompany, onLogin, onLogout, onSessionExpired, onOpenPost,
  onFeed, onTrending, onGuide, onSearch, onBoard, onChannels,
}: Props) {
  const [view, setView] = useState<View>(null);
  const [unreadCount, setUnreadCount] = useState(0);
  const [notices, setNotices] = useState<Notice[] | null>(null);
  const [loadError, setLoadError] = useState("");
  const [saveError, setSaveError] = useState("");
  const [saving, setSaving] = useState(false);
  const currentView = useRef<View>(null);
  const viewVersion = useRef(0);
  const readRequest = useRef<AbortController | null>(null);
  const writeRequest = useRef<AbortController | null>(null);
  const menuRoot = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const firstAction = useRef<HTMLButtonElement>(null);
  const panelId = useId();

  function changeView(next: View) {
    currentView.current = next;
    viewVersion.current++;
    setView(next);
    setLoadError("");
    setSaveError("");
    if (next === "inbox") setNotices(null);
  }

  function closeMenu() {
    changeView(null);
    trigger.current?.focus();
  }

  function choose(action: () => void) {
    closeMenu();
    action();
  }

  const load = useCallback(async () => {
    if (!signedIn || writeRequest.current || readRequest.current) return;
    const list = currentView.current === "inbox";
    const controller = new AbortController();
    readRequest.current = controller;
    try {
      const response = await fetch(list ? endpoint : endpoint + "?summary=1", { cache: "no-store", signal: controller.signal });
      if (controller.signal.aborted) return;
      if (response.status === 401) { onSessionExpired(list); return; }
      if (!response.ok) throw new Error();
      const data: { unreadCount: number; notifications?: Notice[] } = await response.json();
      if (controller.signal.aborted) return;
      setUnreadCount(data.unreadCount);
      if (list && data.notifications) { setNotices(data.notifications); setLoadError(""); }
    } catch {
      if (list && !controller.signal.aborted) setLoadError("알림을 불러오지 못했어요.");
    } finally {
      if (readRequest.current === controller) readRequest.current = null;
    }
  }, [signedIn, onSessionExpired]);

  useEffect(() => {
    if (!signedIn) return;
    const refreshVisible = () => { if (document.visibilityState === "visible") void load(); };
    refreshVisible();
    const timer = window.setInterval(refreshVisible, 60000);
    document.addEventListener("visibilitychange", refreshVisible);
    window.addEventListener("focus", refreshVisible);
    window.addEventListener("online", refreshVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refreshVisible);
      window.removeEventListener("focus", refreshVisible);
      window.removeEventListener("online", refreshVisible);
      readRequest.current?.abort();
      readRequest.current = null;
    };
  }, [signedIn, view, load]);

  useEffect(() => () => writeRequest.current?.abort(), []);

  useEffect(() => {
    if (!view) return;
    firstAction.current?.focus({ preventScroll: true });
    function outside(event: PointerEvent) {
      if (event.target instanceof Node && !menuRoot.current?.contains(event.target)) changeView(null);
    }
    function escape(event: KeyboardEvent) {
      if (event.key === "Escape") { event.preventDefault(); closeMenu(); }
    }
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [view]);

  async function markRead(notice?: Notice) {
    if (writeRequest.current) return;
    if (notice?.read) { choose(() => onOpenPost(notice.postId)); return; }
    const version = viewVersion.current;
    const controller = new AbortController();
    writeRequest.current = controller;
    readRequest.current?.abort();
    readRequest.current = null;
    setSaving(true);
    setSaveError("");
    if (!notice) firstAction.current?.focus({ preventScroll: true });
    try {
      const response = await fetch(endpoint, {
        method: "POST", headers: { "Content-Type": "application/json" }, signal: controller.signal,
        body: JSON.stringify(notice ? { id: notice.id } : { all: true }),
      });
      if (controller.signal.aborted) return;
      if (response.status === 401) { onSessionExpired(true); return; }
      if (!response.ok) throw new Error();
      setUnreadCount(count => notice ? Math.max(0, count - 1) : 0);
      setNotices(rows => rows?.map(row => !notice || row.id === notice.id ? { ...row, read: true } : row) ?? null);
      if (notice && version === viewVersion.current) choose(() => onOpenPost(notice.postId));
    } catch {
      if (!controller.signal.aborted && version === viewVersion.current) setSaveError("읽음 표시를 저장하지 못했어요. 다시 시도해 주세요.");
    } finally {
      if (!controller.signal.aborted) {
        writeRequest.current = null;
        setSaving(false);
        void load();
      }
    }
  }

  return <div className="header-actions community-menu" ref={menuRoot}
    onBlur={event => {
      if (view && event.relatedTarget instanceof Node && !event.currentTarget.contains(event.relatedTarget)) changeView(null);
    }}>
    <button type="button" ref={trigger} className="community-menu-trigger" aria-expanded={Boolean(view)}
      aria-controls={view ? panelId : undefined}
      aria-label={unreadCount ? `메뉴, 읽지 않은 알림 ${unreadCount}개` : "메뉴"}
      onClick={() => changeView(view ? null : "menu")}>
      {view ? <X aria-hidden="true" size={22}/> : <Menu aria-hidden="true" size={22}/>}
      {unreadCount > 0 && <span aria-hidden="true" className="burger-unread-dot"/>}
    </button>
    {view && <div id={panelId} className={`community-menu-panel ${view === "inbox" ? "inbox-panel" : ""}`}>
      {view === "menu" ? <nav aria-label="커뮤니티 메뉴">
        {signedIn && <button type="button" ref={firstAction} className="menu-row" onClick={() => changeView("inbox")}>
          <Bell size={17}/>알림함 {unreadCount > 0 && <span className="menu-count" aria-label={`읽지 않은 알림 ${unreadCount}개`}>{unreadCount}</span>}
          <ChevronRight size={15} className="menu-chevron"/>
        </button>}
        <button type="button" className="menu-row" ref={signedIn ? undefined : firstAction} onClick={() => choose(onWrite)}><PenLine size={17}/>글쓰기</button>
        {signedIn && <button type="button" className="menu-row" disabled={busy} onClick={() => choose(onCompany)}><ShieldCheck size={17}/>회사 인증</button>}
        <button type="button" className="menu-row" onClick={() => choose(() => onChannels("browse"))}><Users size={17}/>채널 탐색</button>
        <button type="button" className="menu-row" onClick={() => choose(() => onChannels("apply"))}><Plus size={17}/>채널 개설 신청</button>
        {signedIn && <button type="button" className="menu-row" onClick={() => choose(() => onChannels("mine"))}><ShieldCheck size={17}/>내 채널 관리</button>}
        <div className="mobile-menu-links">
          <button type="button" className="menu-row" onClick={() => choose(onSearch)}><Search size={17}/>게시글 검색</button>
          <button type="button" className="menu-row" onClick={() => choose(onFeed)}><Home size={17}/>전체 게시판</button>
          <button type="button" className="menu-row" onClick={() => choose(onTrending)}><Flame size={17}/>지금 급상승</button>
          <div className="menu-boards">{BOARD_PAGES.map(board => <a key={board.slug} href={boardPath(board.slug)} onClick={event => { onBoard(event, board.category); if (event.defaultPrevented) closeMenu(); }}>{board.category}</a>)}</div>
          <button type="button" className="menu-row" onClick={() => choose(onGuide)}><HelpCircle size={17}/>이용 가이드</button>
        </div>
        <div className="menu-account">
          {signedIn
            ? <button type="button" className="menu-row" disabled={busy} onClick={() => choose(onLogout)}><LogOut size={17}/>로그아웃</button>
            : <button type="button" className="menu-row" onClick={() => choose(onLogin)}><LogIn size={17}/>로그인</button>}
        </div>
      </nav> : <section aria-label="커뮤니티 알림함">
        <div className="inbox-heading">
          <button type="button" ref={firstAction} className="inbox-back" aria-label="메뉴로 돌아가기" onClick={() => changeView("menu")}><ArrowLeft size={18}/></button>
          <h2>알림함</h2>
          {unreadCount > 0 && <button type="button" className="inbox-mark-all" disabled={saving} onClick={() => void markRead()}>모두 읽음</button>}
        </div>
        {saveError && <p role="alert" className="inbox-feedback">{saveError}</p>}
        {loadError && <div role="alert" className="inbox-feedback">{loadError} <button type="button" onClick={() => { setLoadError(""); void load(); }}>다시 불러오기</button></div>}
        {notices === null && !loadError && <p role="status" className="inbox-state">알림을 불러오는 중…</p>}
        {notices?.length === 0 && <div className="inbox-state"><Bell size={23} aria-hidden="true"/><p>아직 받은 알림이 없어요.</p></div>}
        {Boolean(notices?.length) && <ul className="inbox-list">{notices?.map(notice => <li key={notice.id}>
          <button type="button" className="inbox-item" data-unread={!notice.read} disabled={saving} onClick={() => void markRead(notice)}>
            {notice.kind === "like" ? <Heart size={17} aria-hidden="true"/> : <MessageCircle size={17} aria-hidden="true"/>}
            <span className="inbox-item-copy">
              <strong>{notice.postTitle}</strong>
              <span>{notice.kind === "like"
                ? `동료 ${notice.likeCount.toLocaleString("ko-KR")}명이 내 글에 좋아요를 눌렀어요.`
                : "내 글에 댓글이 달렸어요."}</span>
              <time dateTime={new Date(notice.createdAt).toISOString()}>{dateFormat.format(notice.createdAt)}</time>
            </span>
            {!notice.read && <span className="inbox-item-dot"><span className="sr-only">읽지 않음</span></span>}
          </button>
        </li>)}</ul>}
      </section>}
    </div>}
  </div>;
}
