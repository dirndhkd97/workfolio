import { useEffect, useRef, useState } from 'react';
import { ArrowRight, Check, Flag, Plus, ShieldCheck, Users, X } from 'lucide-react';
import type { Channel, Post } from '../../lib/community/domain';
import { channelApi, ChannelApiError, canManageChannel, canRestoreChannelPost, type ChannelPanelTab } from '../../lib/community/channel-client';

type Report = { id: string; postId: string; reason: string; createdAt: number };
type Listing = { channels?: Channel[]; requests?: Channel[]; signedIn: boolean; isModerator: boolean };
type Management = { channel: Channel; posts: Post[]; reports: Report[]; isModerator: boolean };
type Props = {
  tab: ChannelPanelTab; manageId: string; authLoading: boolean; signedIn: boolean; ownAccountId: string;
  onNavigate: (tab: ChannelPanelTab, manageId?: string) => void;
  onClose: () => void; onLogin: () => void; onSelect: (channel: Channel) => void;
  onChanged: () => void; onBusyChange: (busy: boolean) => void; onOpenPost: (id: string) => void;
};
const statusLabel = { pending: '승인 대기', active: '운영 중', rejected: '반려' };

export function ChannelsPanel({ tab, manageId, authLoading, signedIn, ownAccountId, onNavigate, onClose, onLogin, onSelect, onChanged, onOpenPost, onBusyChange }: Props) {
  const [items, setItems] = useState<Channel[]>([]);
  const [moderator, setModerator] = useState(false);
  const [management, setManagement] = useState<Management | null>(null);
  const [loading, setLoading] = useState(true), [error, setError] = useState(''), [readFailed, setReadFailed] = useState(false);
  const [notice, setNotice] = useState(''), [busy, setBusy] = useState(false), [revision, setRevision] = useState(0);
  const [draft, setDraft] = useState({ name: '', description: '', rules: '', originalConfirmed: false });
  const [action, setAction] = useState<{ kind: 'approve' | 'reject' | 'hide' | 'restore' | 'dismiss'; channelId: string; postId?: string; title: string } | null>(null);
  const [note, setNote] = useState('');
  const confirmForm = useRef<HTMLFormElement>(null);
  useEffect(() => { if (action) { confirmForm.current?.scrollIntoView({ block: 'center', behavior: 'smooth' }); confirmForm.current?.querySelector('textarea')?.focus({ preventScroll: true }); } }, [action]);
  const mutation = useRef(false), mounted = useRef(true), context = useRef(0);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    context.current++;
    const controller = new AbortController();
    setLoading(true); setError(''); setReadFailed(false); setModerator(false); setManagement(null); setItems([]); setAction(null);
    const query = manageId ? `?manage=${encodeURIComponent(manageId)}` : tab === 'review' ? '?review=1' : tab === 'mine' || tab === 'apply' ? '?mine=1' : '';
    if (!signedIn && tab !== 'browse') { setLoading(false); return () => controller.abort(); }
    channelApi<Listing | Management>(query, undefined, controller.signal).then(data => {
      if (controller.signal.aborted) return;
      setModerator(data.isModerator === true);
      if ('channel' in data) setManagement(data);
      else setItems(data.channels ?? data.requests ?? []);
    }).catch(e => {
      if (controller.signal.aborted) return;
      setError((e as Error).message); setReadFailed(true);
      if (e instanceof ChannelApiError && e.status === 401) onLogin();
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [tab, manageId, signedIn, revision]);

  async function mutate(body: unknown, success: string, requested = false) {
    if (mutation.current) return;
    const startedIn = context.current;
    mutation.current = true; setBusy(true); onBusyChange(true); setError('');
    try {
      await channelApi('', body);
      onChanged();
      if (!mounted.current || startedIn !== context.current) return;
      setNotice(success); setAction(null); setNote('');
      if (requested) { setDraft({ name: '', description: '', rules: '', originalConfirmed: false }); onNavigate('mine'); }
      else setRevision(value => value + 1);
    } catch (e) {
      if (!mounted.current || startedIn !== context.current) return;
      setError(`${(e as Error).message} 자동으로 다시 보내지 않아요. 내 채널에서 처리 결과를 확인한 뒤 다시 시도해 주세요.`);
      if (e instanceof ChannelApiError && e.status === 401) onLogin();
    } finally { mutation.current = false; onBusyChange(false); if (mounted.current) setBusy(false); }
  }
  const pending = items.some(item => item.status === 'pending');
  const atLimit = items.filter(item => item.status === 'active').length >= 3;
  const needsLogin = !signedIn && tab !== 'browse';
  const startAction = (kind: NonNullable<typeof action>['kind'], channelId: string, title: string, postId?: string) => { setNote(''); setError(''); setAction({ kind, channelId, title, postId }); };
  const actionLabel = { approve: '승인', reject: '반려', hide: '숨기기', restore: '복원', dismiss: '신고 검토 완료' };

  return <div className="channels-panel">
    <div className="modal-top"><span className="eyebrow">같은 떡밥, 우리끼리 더 깊게</span><button className="icon-btn" aria-label="채널 닫기" onClick={onClose} disabled={busy}><X /></button></div>
    <h2>우리 채널, 우리 룰.</h2>
    <p className="modal-subtitle">기본 게시판 3개와는 별개의 모임이에요.<br />개설 신청 → 플랫폼 승인 → 신청자가 직접 관리해요.</p>
    <nav className="channel-tabs" aria-label="채널 메뉴">
      <button aria-current={tab === 'browse' ? 'page' : undefined} onClick={() => onNavigate('browse')} disabled={busy}><Users size={16} />채널 탐색</button>
      <button aria-current={tab === 'mine' ? 'page' : undefined} onClick={() => onNavigate('mine')} disabled={busy}>내 채널</button>
      <button aria-current={tab === 'apply' ? 'page' : undefined} onClick={() => onNavigate('apply')} disabled={busy}><Plus size={16} />개설 신청</button>
      {(moderator || tab === 'review') && <button aria-current={tab === 'review' ? 'page' : undefined} onClick={() => onNavigate('review')} disabled={busy}><ShieldCheck size={16} />운영 검토</button>}
    </nav>
    {notice && <p className="channel-notice" role="status"><Check size={16} />{notice}</p>}
    {error && <p className="form-error" role="alert">{error}</p>}
    {needsLogin && authLoading ? <p className="loading-state" role="status">로그인 상태를 확인하는 중…</p>
      : needsLogin ? <div className="channel-empty"><h3>눈팅은 자유, 개설과 관리는 로그인 후.</h3><p>로그인하고 돌아와도 지금 선택한 채널 메뉴가 그대로 열려요.</p><button className="primary" onClick={onLogin}>로그인하고 계속하기 <ArrowRight size={16} /></button></div>
      : loading ? <div className="loading-state" role="status"><div className="loader" />채널을 불러오는 중…</div>
      : readFailed ? <button className="secondary" onClick={() => setRevision(value => value + 1)}>다시 불러오기</button>
      : management ? <>
        <button className="channel-back" onClick={() => onNavigate('mine')} disabled={busy}>← 내 채널 목록</button>
        <h3 className="channel-manager-title">{management.channel.name} {moderator ? '운영자 관리' : '관리'}</h3>
        <p className="channel-audit"><ShieldCheck size={17} />{moderator ? '플랫폼 운영 권한으로 관리해요. 플랫폼이 숨긴 글과 비공개 신고를 포함하며, 숨김·복원과 신고 처리 사유는 운영 기록에 남아요.' : '글 숨김·복원과 신고 처리 사유는 운영 기록에 남아요. 채널 관리자는 이 채널의 글만 관리할 수 있고, 플랫폼이 숨긴 글은 복원할 수 없어요.'}</p>
        <section className="channel-report-list"><h4><Flag size={16} />{moderator ? '검토할 신고' : '공유된 신고'} {management.reports.length}건</h4><p>{moderator ? '플랫폼 비공개 신고를 포함한 목록이에요. 신고자 정보는 표시하지 않아요.' : '신고자가 공유에 동의한 사유만 보여요. 신고자 정보는 공개하지 않아요.'}</p>
          {management.reports.length === 0 ? <p className="channel-empty-note">공유된 미처리 신고가 없어요.</p> : management.reports.map(report => <article key={report.id}><strong>{management.posts.find(post => post.id === report.postId)?.title ?? '신고된 글'}</strong><p>{report.reason}</p><button onClick={() => startAction('dismiss', management.channel.id, '이 글의 신고', report.postId)} disabled={busy}>검토 완료 처리</button></article>)}
        </section>
        <h4 className="channel-post-heading">채널 글 관리</h4>
        {!management.posts.length && <p className="channel-empty-note">아직 올라온 글이 없어요. 첫 떡밥을 던져볼까요?</p>}
        {management.posts.map(post => <article className="channel-managed-post" key={post.id}><div><span className={`channel-status ${post.status === 'hidden' ? 'rejected' : 'active'}`}>{post.status === 'hidden' ? '숨김' : '공개'}</span><strong>{post.title}</strong><p>{post.body}</p></div><div className="channel-card-actions">{post.status !== 'hidden' && <button className="secondary" onClick={() => onOpenPost(post.id)} disabled={busy}>글 보기</button>}<button className="secondary" disabled={busy || (post.status === 'hidden' && !canRestoreChannelPost(post, moderator))} onClick={() => startAction(post.status === 'hidden' ? 'restore' : 'hide', management.channel.id, post.title, post.id)}>{post.status === 'hidden' ? canRestoreChannelPost(post, moderator) ? '복원' : '플랫폼 숨김' : '숨기기'}</button></div></article>)}
      </> : tab === 'apply' ? <>
        {pending || atLimit ? <div className="channel-empty"><h3>{pending ? '이미 승인 대기 중인 신청이 있어요.' : '운영 중인 채널은 최대 3개예요.'}</h3><p>승인 대기 신청은 한 번에 1개만 가능해요. 기존 신청과 처리 결과를 먼저 확인해 주세요.</p><button className="secondary" onClick={() => onNavigate('mine')}>내 신청 확인</button></div> : <form className="channel-application" onSubmit={event => { event.preventDefault(); if (!draft.originalConfirmed) return; void mutate({ action: 'request', ...draft }, '개설 신청을 보냈어요. 승인되면 직접 관리할 수 있어요.', true); }}>
          <label htmlFor="channel-name">채널 이름 <span>3~30자</span></label><input id="channel-name" minLength={3} maxLength={30} required value={draft.name} onChange={event => setDraft({ ...draft, name: event.target.value })} placeholder="예: 점심 메뉴가 제일 어려운 사람들" disabled={busy} />
          <label htmlFor="channel-description">어떤 이야기를 나누나요? <span>20~500자</span></label><textarea id="channel-description" minLength={20} maxLength={500} required value={draft.description} onChange={event => setDraft({ ...draft, description: event.target.value })} placeholder="이 모임에 누가 오면 좋을지, 어떤 썰을 나눌지 알려주세요." disabled={busy} />
          <label htmlFor="channel-rules">우리 채널의 약속 <span>20~1,000자</span></label><textarea id="channel-rules" minLength={20} maxLength={1000} required value={draft.rules} onChange={event => setDraft({ ...draft, rules: event.target.value })} placeholder="드립은 환영, 신상 털기는 금지. 구체적인 운영 기준을 적어주세요." disabled={busy} />
          <label className="consent"><input type="checkbox" checked={draft.originalConfirmed} onChange={event => setDraft({ ...draft, originalConfirmed: event.target.checked })} required disabled={busy} /><span>채널 소개와 운영 규칙을 직접 작성했으며, 다른 사람이나 공식 조직을 사칭하지 않아요. 승인 후 채널 관리와 운영 기록에 동의해요.</span></label>
          <p className="channel-empty-note">신청은 자동 승인되지 않아요. 운영 중 3개, 승인 대기 1개까지 가능해요. 실명·연락처와 누군가를 특정해 공격하는 내용은 빼주세요.</p><button className="primary" disabled={busy || !draft.originalConfirmed}>{busy ? '신청하는 중…' : '개설 신청 보내기'}<ArrowRight size={16} /></button>
        </form>}
      </> : <>
        {tab === 'review' && <p className="channel-audit"><ShieldCheck size={17} />플랫폼 운영 권한으로 검토해요. 회사 인증 배지는 이 권한을 뜻하지 않아요. 승인·반려와 사유는 기록에 남아요.</p>}
        {!items.length ? <div className="channel-empty"><Users size={28} /><h3>{tab === 'browse' ? '아직 열린 채널이 없어요.' : tab === 'review' ? '검토할 신청이 없어요.' : '아직 내 채널이 없어요.'}</h3><p>{tab === 'review' ? '새 신청이 들어오면 여기에서 확인할 수 있어요.' : '취향 맞는 동료들, 직접 모아볼까요? 신청은 플랫폼 검토 후 열려요.'}</p>{tab !== 'review' && <button className="primary" onClick={() => onNavigate('apply')}>첫 채널 신청하기 <Plus size={16} /></button>}</div> : <div className="channel-grid">{items.map(channel => <article className="channel-card" key={channel.id}><span className={`channel-status ${channel.status}`}>{statusLabel[channel.status]}</span><h3>{channel.name}</h3><p>{channel.description}</p><details><summary>채널의 약속</summary><p>{channel.rules}</p></details>{channel.reviewNote && <p className="channel-review-note">검토 메모: {channel.reviewNote}</p>}<div className="channel-card-actions">{channel.status === 'active' && <button className="primary" onClick={() => onSelect(channel)} disabled={busy}>채널 들어가기 <ArrowRight size={15} /></button>}{canManageChannel(channel, moderator) && <button className="secondary" onClick={() => onNavigate('mine', channel.id)} disabled={busy}>{moderator ? '운영자 관리' : '관리'}</button>}{tab === 'review' && moderator && channel.status === 'pending' && <><button className="primary" onClick={() => startAction('approve', channel.id, channel.name)} disabled={busy}>승인 검토</button><button className="secondary" onClick={() => startAction('reject', channel.id, channel.name)} disabled={busy}>반려 검토</button></>}</div></article>)}</div>}
      </>}
    {tab === 'mine' && signedIn && ownAccountId && <details className="channel-own-account"><summary>내 계정 확인</summary><p>플랫폼 소유자가 운영 계정을 지정할 때만 필요한 내 계정 ID예요. 회사 인증 배지는 운영 권한과 별개이며, 여기서 권한이 바뀌지는 않아요.</p><label htmlFor="own-account-id">내 계정 ID</label><input id="own-account-id" value={ownAccountId} readOnly /></details>}
    {action && <form ref={confirmForm} className="channel-confirm" onSubmit={event => { event.preventDefault(); void mutate({ action: action.kind, channelId: action.channelId, ...(action.postId ? { postId: action.postId } : {}), note }, `${actionLabel[action.kind]} 처리를 완료했어요.`); }}>
      <h3>‘{action.title}’ {actionLabel[action.kind]}할까요?</h3><p>{action.kind === 'approve' ? '승인하면 채널이 공개되고 신청자가 채널 글을 관리할 수 있어요.' : action.kind === 'hide' ? moderator ? '글과 첨부 이미지를 공개 화면에서 숨겨요. 플랫폼 운영자만 다시 복원할 수 있어요.' : '글과 첨부 이미지를 공개 화면에서 숨겨요. 채널 관리자가 숨긴 글은 나중에 복원할 수 있어요.' : action.kind === 'restore' ? '글과 첨부 이미지가 다시 공개돼요.' : action.kind === 'reject' ? '신청은 반려 상태로 바뀌고, 신청자에게 사유가 보여요.' : moderator ? '이 글의 미처리 신고를 플랫폼에서 검토 완료로 표시해요. 글은 그대로예요.' : '이 글에 공유된 신고를 채널에서 검토 완료로 표시해요. 플랫폼의 검토 기록과 글은 그대로예요.'}</p><label htmlFor="channel-action-note">처리 사유{action.kind === 'approve' ? ' (선택)' : ''}</label><textarea id="channel-action-note" value={note} onChange={event => setNote(event.target.value)} maxLength={500} minLength={action.kind === 'approve' ? 0 : 2} required={action.kind !== 'approve'} disabled={busy} /><div className="channel-card-actions"><button type="button" className="secondary" onClick={() => setAction(null)} disabled={busy}>취소</button><button className="primary" disabled={busy}>{busy ? '처리 중…' : `확인하고 ${actionLabel[action.kind]}`}</button></div>
    </form>}
  </div>;
}
