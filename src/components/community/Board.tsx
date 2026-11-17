import { useCallback, useEffect, useRef, useState, type ReactNode, type MouseEvent } from "react";
import { ArrowRight, ArrowUpRight, Check, Coffee, Eye, Flame, Zap, Flag, Heart, HelpCircle, Home, MessageCircle, PenLine, Search, ShieldCheck, Sparkles, Trash2, Users, X } from "lucide-react";

import type { Category, Post, Comment, PostImage, Channel } from "../../lib/community/domain";
import { getTrendingPosts } from "../../lib/community/feed";
import { boardForCategory, boardPath, postPath } from "../../lib/community/seo";
import { feedNavigationUrl, readFeedNavigation, shouldHandleFeedLink, type FeedSort } from "./navigation";
import { LoginContent, type LoginProvider } from "./LoginContent";
import { CompanyVerification, type VerifiedCompany } from "./CompanyVerification";
import { CompanyLabel } from "./CompanyLabel";
import { ImageAttachments, PostImages } from "./ImageAttachments";
import { PostShare } from "./PostShare";
import { LikeButton } from "./LikeButton";
import { CommunityMenu } from "./CommunityMenu";
import { ChannelsPanel } from "./ChannelsPanel";
import { channelApi, channelFeedUrl, channelPanelUrl, readChannelNavigation, type ChannelPanelTab } from "../../lib/community/channel-client";
import { watchVisibleView } from "../../lib/community/view-client";

const categories: {name: Category; icon: typeof Coffee; color: string; desc: string}[] = [
  { name: "빡대가리 게시판", icon: Zap, color: "pink", desc: "내 실수부터 동료 빌런, 회사의 기행까지" },
  { name: "월급루팡", icon: Coffee, color: "lime", desc: "잡담·밈 환영. 월급은 지금도 들어오는 중" },
  { name: "퇴사각 상담소", icon: HelpCircle, color: "purple", desc: "사표는 잠깐 넣고, 이직·커리어 같이 고민" },
];
class BoardApiError extends Error {
  constructor(message: string, public status: number) { super(message); }
}

async function api<T>(body?: unknown, id?: string): Promise<T> {
  const res = await fetch(`/api/board${id ? `?id=${encodeURIComponent(id)}` : ""}`, body ? {method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)} : {cache:"no-store"});
  const data = await res.json() as T & { error?: string };
  if (!res.ok) throw new BoardApiError(data.error || "잠시 연결이 어려워요. 다시 시도해 주세요.", res.status);
  return data;
}
function categoryHref(category: string) {
  const board = boardForCategory(category);
  return board ? boardPath(board.slug) : "/";
}
function dateLabel(time: number) {
  const delta = Math.max(0, Date.now()-time);
  if(delta < 60000) return "방금 전";
  if(delta < 3600000) return `${Math.floor(delta/60000)}분 전`;
  if(delta < 86400000) return `${Math.floor(delta/3600000)}시간 전`;
  return new Intl.DateTimeFormat("ko-KR",{month:"short",day:"numeric"}).format(time);
}
function Brand({small=false}:{small?:boolean}){return <span className={`brand ${small?"small":""}`}><span className="brand-mark"><span/><span/><span/></span>workfolio<span className="brand-dot">.</span></span>}
function Modal({children,onClose,label,className="",id}:{children:ReactNode;onClose:()=>void;label:string;className?:string;id?:string}){
  const ref=useRef<HTMLDialogElement>(null);
  useEffect(()=>{const dialog=ref.current;dialog?.showModal();return()=>dialog?.close()},[]);
  return <dialog ref={ref} id={id} aria-label={label} className={`modal ${className}`} onCancel={e=>{e.preventDefault();onClose()}} onClick={e=>{if(e.target===e.currentTarget)onClose()}}><div className="modal-inside">{children}</div></dialog>
}

export default function Board(){
  const [posts,setPosts]=useState<Post[]>([]),[loading,setLoading]=useState(true),[loadError,setLoadError]=useState("");
  const [topic,setTopic]=useState("전체 이야기"),[sort,setSort]=useState<FeedSort>("latest"),[query,setQuery]=useState("");
  const [ownAccountId,setOwnAccountId]=useState("");
  const signedIn=Boolean(ownAccountId);
  const [modal,setModal]=useState<"write"|"guide"|"report"|"login"|"company"|null>(null),[selected,setSelected]=useState<Post|null>(null),[comments,setComments]=useState<Comment[]>([]),[detailLoading,setDetailLoading]=useState(false),[detailError,setDetailError]=useState("");
  const [busy,setBusy]=useState(false),[error,setError]=useState(""),[toast,setToast]=useState("");
  const [draft,setDraft]=useState({category:"빡대가리 게시판" as Category,title:"",body:"",nickname:"",shareCompany:false}),[agreed,setAgreed]=useState(false),[comment,setComment]=useState(""),[reportReason,setReportReason]=useState("개인정보 노출"),[shareWithChannel,setShareWithChannel]=useState(false);
  const [images,setImages]=useState<PostImage[]>([]),[imagesBusy,setImagesBusy]=useState(false);
  const [providers,setProviders]=useState<LoginProvider[]>([]),[authLoading,setAuthLoading]=useState(true),[authError,setAuthError]=useState("");
  const [company,setCompany]=useState<VerifiedCompany|null>(null),[companyLoading,setCompanyLoading]=useState(false),[companyError,setCompanyError]=useState("");
  const companyRequest=useRef<AbortController|null>(null),companyReturnTo=useRef<"write"|null>(null);
  const [channelTab,setChannelTab]=useState<ChannelPanelTab|null>(null),[channelId,setChannelId]=useState(""),[manageId,setManageId]=useState("");
  const [channels,setChannels]=useState<Channel[]>([]),[channelsRevision,setChannelsRevision]=useState(0),[channelConsent,setChannelConsent]=useState(false);
  const feedRequest=useRef<AbortController|null>(null),channelMutationBusy=useRef(false);
  const detailRequest=useRef(0);
  const searchRef=useRef<HTMLInputElement>(null);
  const authRequest=useRef<AbortController|null>(null),authCheckedAt=useRef(0),authLoggingOut=useRef(false);
  const refresh=async()=>{
    feedRequest.current?.abort();const controller=new AbortController();feedRequest.current=controller;setLoading(true);setLoadError("");
    const current=readChannelNavigation(new URL(window.location.href)).channelId;
    try{const response=await fetch(`/api/board${current?`?channel=${encodeURIComponent(current)}`:""}`,{cache:"no-store",signal:controller.signal});const data=await response.json() as {posts:Post[];error?:string};if(!response.ok)throw new Error(data.error||"글을 불러오지 못했어요.");if(!controller.signal.aborted)setPosts(data.posts)}catch(e){if(!controller.signal.aborted)setLoadError((e as Error).message)}finally{if(!controller.signal.aborted)setLoading(false)}
  };
  useEffect(()=>{void refresh();return()=>feedRequest.current?.abort()},[channelId]);
  useEffect(()=>{const controller=new AbortController();channelApi<{channels:Channel[]}>("",undefined,controller.signal).then(data=>{if(!controller.signal.aborted)setChannels(data.channels)}).catch(()=>{});return()=>controller.abort()},[ownAccountId,channelsRevision]);
  const activeChannel=channels.find(channel=>channel.id===channelId);
  function syncChannels(){const navigation=readChannelNavigation(new URL(window.location.href));setChannelTab(navigation.tab);setChannelId(navigation.channelId);setManageId(navigation.manageId);setChannelConsent(false)}
  function openChannels(tab:ChannelPanelTab="browse",manager=""){
    setModal(null);detailRequest.current++;setSelected(null);setDetailError("");setDetailLoading(false);
    const url=channelPanelUrl(new URL(window.location.href),tab,manager);if(url.href!==window.location.href)window.history.pushState(null,"",url);syncChannels();
  }
  function openChannelLink(event:MouseEvent<HTMLAnchorElement>, tab:ChannelPanelTab){
    if(!shouldHandleFeedLink(event,event.currentTarget.target,event.currentTarget.hasAttribute("download")))return;
    event.preventDefault();openChannels(tab);
  }
  function closeChannels(){if(channelMutationBusy.current)return;const url=channelPanelUrl(new URL(window.location.href),null);window.history.replaceState(null,"",url);syncChannels()}
  function selectChannel(channel:Channel){
    const url=channelFeedUrl(new URL(window.location.href),channel.id);if(url.href!==window.location.href)window.history.pushState(null,"",url);
    setTopic("전체 이야기");setSort("latest");setQuery("");setModal(null);syncChannels();
    requestAnimationFrame(()=>{document.getElementById("feed")?.scrollIntoView({behavior:"smooth"});document.getElementById("feed")?.focus({preventScroll:true})});
  }
  function channelsChanged(){setChannelsRevision(value=>value+1);void refresh()}
  useEffect(()=>{
    if(!selected||detailLoading||detailError||modal||channelTab)return;
    return watchVisibleView(selected.id,result=>{setSelected(old=>old?.id===selected.id?{...old,viewCount:result.viewCount}:old);setPosts(old=>old.map(post=>post.id===selected.id?{...post,viewCount:result.viewCount}:post))});
  },[selected?.id,detailLoading,detailError,modal,channelTab]);
  function cancelAuthCheck(){authRequest.current?.abort();authRequest.current=null;setAuthLoading(false)}
  async function refreshAuth(force=true){
    if(authLoggingOut.current||authRequest.current||(!force&&Date.now()-authCheckedAt.current<60000))return;
    const controller=new AbortController();authRequest.current=controller;authCheckedAt.current=Date.now();
    setAuthLoading(true);setAuthError("");
    try {
      const response=await fetch("/api/community-auth/me",{cache:"no-store",signal:controller.signal});
      if(!response.ok)throw new Error("로그인 연결 상태를 확인하지 못했어요. 다시 시도해 주세요.");
      const data=await response.json() as {signedIn:boolean;providers:LoginProvider[];user?:{id:string}|null};
      if(authRequest.current===controller){setOwnAccountId(data.signedIn?data.user?.id||"":"");setProviders(data.providers)}
    } catch(e){if(authRequest.current===controller)setAuthError((e as Error).message)} finally {if(authRequest.current===controller){authRequest.current=null;setAuthLoading(false)}}
  }
  function clearCompany(){companyRequest.current?.abort();companyRequest.current=null;setCompany(null);setCompanyLoading(false);setCompanyError("");setDraft(value=>({...value,shareCompany:false}))}
  async function refreshCompany(){
    companyRequest.current?.abort();
    const controller=new AbortController();companyRequest.current=controller;setCompanyLoading(true);setCompanyError("");
    try{
      const response=await fetch("/api/community-company/me",{cache:"no-store",signal:controller.signal});
      const data=await response.json() as {company:VerifiedCompany|null;error?:string};
      if(companyRequest.current!==controller)return;
      if(!response.ok)throw new BoardApiError(data.error||"회사 인증 상태를 확인하지 못했어요.",response.status);
      const verified=data.company&&data.company.expiresAt>Date.now()?data.company:null;setCompany(verified);
      if(!verified)setDraft(value=>({...value,shareCompany:false}));
    }catch(e){if(companyRequest.current===controller){setCompany(null);setDraft(value=>({...value,shareCompany:false}));setCompanyError((e as Error).message);if(e instanceof BoardApiError&&e.status===401)mutationError(e)}}
    finally{if(companyRequest.current===controller){companyRequest.current=null;setCompanyLoading(false)}}
  }
  useEffect(()=>{if(signedIn)void refreshCompany();else clearCompany();return()=>{companyRequest.current?.abort();companyRequest.current=null}},[signedIn]);
  function openCompany(fromWrite=false){if(!signedIn){setModal("login");return}companyReturnTo.current=fromWrite?"write":null;setModal("company");void refreshCompany()}
  function closeCompany(){setModal(companyReturnTo.current)}
  function companyVerified(value:VerifiedCompany){companyRequest.current?.abort();companyRequest.current=null;setCompany(value);setCompanyLoading(false);setCompanyError("");setDraft(d=>({...d,shareCompany:false}));setToast(`${value.name} 회사 이메일 인증을 완료했어요.`);closeCompany()}
  const expireSession=useCallback((showLogin:boolean)=>{
    cancelAuthCheck();clearCompany();setOwnAccountId("");setImages([]);
    if(showLogin){setModal("login");setAuthError("로그인이 만료됐어요. 다시 로그인해 주세요.")}
  },[]);
  function mutationError(e:unknown){
    if(e instanceof BoardApiError&&e.status===401){expireSession(true);return}
    setError((e as Error).message);setToast((e as Error).message);
  }
  async function logout(){
    if(busy)return;setBusy(true);authLoggingOut.current=true;cancelAuthCheck();
    try{
      const response=await fetch("/api/community-auth/logout",{method:"POST",headers:{"Content-Type":"application/json"},body:"{}"});
      if(!response.ok)throw new Error("로그아웃하지 못했어요. 다시 시도해 주세요.");
      clearCompany();setOwnAccountId("");setImages([]);setSelected(null);setModal(null);setComments([]);setComment("");
      const url=new URL(window.location.href);url.searchParams.delete("story");window.history.replaceState(null,"",url);
      await refresh();setToast("로그아웃했어요. 글은 계속 읽을 수 있어요.");
    }catch(e){setToast((e as Error).message)}finally{authLoggingOut.current=false;setBusy(false)}
  }
  useEffect(()=>{
    void refreshAuth();
    const recheck=()=>{if(document.visibilityState==="visible")void refreshAuth(false)};
    const reconnect=()=>{if(document.visibilityState==="visible")void refreshAuth()};
    document.addEventListener("visibilitychange",recheck);window.addEventListener("focus",recheck);window.addEventListener("online",reconnect);
    return()=>{authRequest.current?.abort();authRequest.current=null;document.removeEventListener("visibilitychange",recheck);window.removeEventListener("focus",recheck);window.removeEventListener("online",reconnect)};
  },[]);
  useEffect(()=>{
    const sync=()=>{
      const navigation=readFeedNavigation(new URL(window.location.href));
      setTopic(navigation.topic);setSort(navigation.sort);setQuery("");setModal(null);syncChannels();
    };
    sync();window.addEventListener("popstate",sync);
    return()=>window.removeEventListener("popstate",sync);
  },[]);
  useEffect(()=>{if(!toast)return;const t=setTimeout(()=>setToast(""),3500);return()=>clearTimeout(t)},[toast]);
  async function openPost(id:string,push=true){
    const seq=++detailRequest.current;setModal(null);setChannelTab(null);setShareWithChannel(false);setError("");setDetailError("");setComments([]);setComment("");
    setSelected(posts.find(p=>p.id===id)||null);setDetailLoading(true);
    if(push){const url=new URL(window.location.href);url.searchParams.set("story",id);url.searchParams.delete("channels");url.searchParams.delete("manage");window.history.pushState({story:id},"",url)}
    try{const d=await api<{post:Post;comments:Comment[]}>(undefined,id);if(seq===detailRequest.current){setSelected(d.post);setComments(d.comments)}}catch(e){if(seq===detailRequest.current)setDetailError((e as Error).message)}finally{if(seq===detailRequest.current)setDetailLoading(false)}
  }
  useEffect(()=>{const sync=()=>{const id=new URL(window.location.href).searchParams.get("story");if(id)void openPost(id,false);else{detailRequest.current++;setSelected(null);setDetailLoading(false);setDetailError("")}};sync();window.addEventListener("popstate",sync);return()=>window.removeEventListener("popstate",sync)},[]);
  useEffect(()=>{
    const url=new URL(window.location.href),code=url.searchParams.get("auth_error");
    if(!code)return;
    const messages:Record<string,string>={provider_unavailable:"선택한 로그인 연결이 아직 설정되지 않았어요.",invalid_state:"로그인 요청이 만료되었거나 유효하지 않아요. 다시 시작해 주세요.",provider_denied:"로그인을 취소했어요. 원할 때 다시 참여할 수 있어요.",login_failed:"로그인을 완료하지 못했어요. 잠시 후 다시 시도해 주세요.",insecure_origin:"안전한 사이트 주소에서 로그인을 다시 시작해 주세요."};
    setAuthError(messages[code]||messages.login_failed);setModal("login");
    url.searchParams.delete("auth_error");window.history.replaceState(null,"",url);
  },[]);
  function openPostLink(event:MouseEvent<HTMLAnchorElement>,id:string){
    if(event.defaultPrevented||event.button!==0||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey)return;
    event.preventDefault();void openPost(id);
  }
  function closeDetail(){if(busy)return;detailRequest.current++;setSelected(null);setDetailLoading(false);setDetailError("");setError("");const u=new URL(window.location.href);u.searchParams.delete("story");window.history.replaceState(null,"",u)}
  function chooseTopic(t:string){setTopic(t);setQuery("")}
  function openWrite(){setError("");closeChannels();setModal(signedIn?"write":"login");if(signedIn)void refreshCompany()}
  function closeWrite(){if(busy)return;setModal(null);setError("")}
  const verifiedCompany=company&&company.expiresAt>Date.now()&&!companyError?company:null;
  const trending=getTrendingPosts(posts);
  const filtered=posts.filter(p=>(!channelId||p.channelId===channelId)&&(topic==="전체 이야기"||p.category===topic)&&(!query||`${p.title} ${p.body} ${p.nickname}`.toLowerCase().includes(query.toLowerCase())));
  const matching=sort==="trending"?getTrendingPosts(filtered):filtered.sort((a,b)=>sort==="popular"?b.likeCount-a.likeCount||b.createdAt-a.createdAt:b.createdAt-a.createdAt);
  function goFeed(t="전체 이야기",nextSort:FeedSort="latest",scroll=true){
    chooseTopic(t);setSort(nextSort);setModal(null);
    detailRequest.current++;setSelected(null);setDetailLoading(false);setDetailError("");
    const url=feedNavigationUrl(new URL(window.location.href),t,nextSort);url.searchParams.delete("channel");url.searchParams.delete("channels");url.searchParams.delete("manage");setChannelId("");setChannelTab(null);setManageId("");setChannelConsent(false);
    if(!scroll)url.hash="";
    if(url.href!==window.location.href)window.history.pushState(null,"",url);
    if(scroll)requestAnimationFrame(()=>{
      const feed=document.getElementById("feed");
      feed?.focus({preventScroll:true});
      feed?.scrollIntoView({behavior:window.matchMedia("(prefers-reduced-motion: reduce)").matches?"auto":"smooth"});
    });
  }
  function openCategoryLink(event:MouseEvent<HTMLAnchorElement>,category:string){
    if(!shouldHandleFeedLink(event,event.currentTarget.target,event.currentTarget.hasAttribute("download")))return;
    event.preventDefault();goFeed(category);
  }
  function changeSort(nextSort:FeedSort){
    setSort(nextSort);
    const url=feedNavigationUrl(new URL(window.location.href),topic,nextSort);
    if(url.href!==window.location.href)window.history.pushState(null,"",url);
  }
  function boardNavigation(){return <nav className="side-nav" aria-label="게시판"><button className={!channelId&&topic==="전체 이야기"&&sort!=="trending"?"selected":""} onClick={()=>goFeed()}><Home size={19}/>전체 게시판</button><button className={!channelId&&topic==="전체 이야기"&&sort==="trending"?"selected":""} onClick={()=>goFeed("전체 이야기","trending")}><Flame size={19}/>지금 급상승<span className="hot-label">HOT</span></button><div className="side-divider"/><p className="board-label">기본 게시판 3개</p>{categories.map(({name,icon:Icon})=><a key={name} className={!channelId&&topic===name?"selected":""} aria-current={!channelId&&topic===name?"page":undefined} href={categoryHref(name)} onClick={event=>openCategoryLink(event,name)}><Icon size={19}/>{name}{name==="빡대가리 게시판"&&<span className="new-dot"/>}</a>)}<div className="side-divider"/><p className="board-label">취향 모임 · 승인 후 개설</p><button onClick={()=>openChannels()}><Users size={19}/>채널 탐색</button><button onClick={()=>openChannels("mine")}>내 채널 / 관리</button><button onClick={()=>openChannels("apply")}>+ 채널 개설 신청</button></nav>}
  const featured=trending.slice(0,3);
  function updatePost(p:Post){setPosts(old=>old.map(x=>x.id===p.id?p:x));setSelected(old=>old?.id===p.id?p:old)}
  function toggleLike(post: Post) {
    if (!signedIn) { setModal("login"); return; }
    if (busy) return;
    setBusy(true);
    setError("");
    return api<{ post: Post }>({ action: "like", postId: post.id, liked: !post.liked })
      .then(result => updatePost(result.post))
      .catch(mutationError)
      .finally(() => setBusy(false));
  }
  async function submitPost(e:React.FormEvent){e.preventDefault();if(busy||imagesBusy||!agreed)return;if(channelId&&(!activeChannel||!channelConsent)){setError("채널 운영 방식에 동의한 뒤 등록해 주세요.");return}if(draft.shareCompany&&(!verifiedCompany||companyLoading)){setError("회사 인증 상태를 확인한 뒤 다시 등록해 주세요.");return}setBusy(true);setError("");try{const d=await api<{post:Post}>({action:"create",...draft,imageIds:images.map(image=>image.id),...(channelId?{channelId,channelModerationConfirmed:channelConsent}:{})});setPosts(old=>[d.post,...old]);setImages([]);setDraft({category:"빡대가리 게시판",title:"",body:"",nickname:"",shareCompany:false});setAgreed(false);setChannelConsent(false);if(!channelId)goFeed("전체 이야기","latest",false);else setModal(null);setToast("썰 풀기 완료. 이제 반응을 기다려볼까요? 👀");void openPost(d.post.id)}catch(e){mutationError(e)}finally{setBusy(false)}}
  async function submitComment(e:React.FormEvent){e.preventDefault();if(!selected||busy)return;setBusy(true);setError("");try{const d=await api<{comment:Comment}>({action:"comment",postId:selected.id,body:comment});setComments(old=>[...old,d.comment]);updatePost({...selected,commentCount:selected.commentCount+1});setComment("")}catch(e){mutationError(e)}finally{setBusy(false)}}
  async function submitReport(e:React.FormEvent){e.preventDefault();if(!selected||busy)return;setBusy(true);setError("");try{await api({action:"report",postId:selected.id,reason:reportReason,shareWithChannel:!!selected.channelId&&shareWithChannel});setModal(null);setToast(shareWithChannel&&selected.channelId?"신고를 저장했어요. 선택한 사유는 채널 관리자에게도 공유돼요.":"신고를 저장했어요. 플랫폼만 확인하는 비공개 기록입니다.")}catch(e){mutationError(e)}finally{setBusy(false)}}
  async function deletePost(){if(!selected||busy||!confirm("이 사연과 댓글을 삭제할까요? 삭제 후 복원할 수 없어요."))return;setBusy(true);try{await api({action:"delete",postId:selected.id});setPosts(old=>old.filter(p=>p.id!==selected.id));setSelected(null);const u=new URL(location.href);u.searchParams.delete("story");history.replaceState(null,"",u);setToast("사연을 삭제했어요.")}catch(e){mutationError(e)}finally{setBusy(false)}}
  return <>
    <a className="skip-link" href="#feed">이야기로 바로 가기</a>
    <header className="header"><div className="header-inner">
      <button className="brand-button" aria-label="Workfolio 홈" onClick={()=>{goFeed("전체 이야기","latest",false);window.scrollTo({top:0,behavior:"smooth"})}}><Brand/></button>
      <nav className="header-nav" aria-label="주 메뉴"><button className="active" onClick={()=>goFeed()}>커뮤니티</button><button onClick={()=>goFeed("전체 이야기","trending")}>급상승 <Flame size={14}/></button><button onClick={()=>openChannels()}><Users size={15}/>채널</button><button onClick={()=>setModal("guide")}>이용 가이드</button></nav>
      <CommunityMenu key={ownAccountId||"guest"} signedIn={signedIn} busy={busy}
        onWrite={openWrite} onCompany={()=>openCompany()} onLogin={()=>setModal("login")} onLogout={()=>void logout()}
        onChannels={openChannels} onBoard={(event,name)=>openCategoryLink(event,name)} onSessionExpired={expireSession} onOpenPost={id=>void openPost(id)}
        onFeed={()=>goFeed()} onTrending={()=>goFeed("전체 이야기","trending")} onGuide={()=>setModal("guide")}
        onSearch={()=>{document.getElementById("feed")?.scrollIntoView();searchRef.current?.focus({preventScroll:true})}}/>
    </div></header>
    <nav className="channel-mobile-entry" aria-label="게시판과 채널">
      <a href="#basic-boards">기본 게시판 3개</a>
      <a href="/?channels=browse" onClick={event=>openChannelLink(event,"browse")}><Users size={16}/>채널 탐색</a>
      <a href="/?channels=apply" onClick={event=>openChannelLink(event,"apply")}>채널 개설 신청</a>
    </nav>
    <div className="app-shell">
      <aside className="left-sidebar">
        <p className="eyebrow sidebar-label">퇴근 후 접속 완료</p>{boardNavigation()}
        <div className="sidebar-note"><span className="small-flower">✳</span><h3>직함 OFF. 본캐 ON.</h3><p>부장님도 신입도<br/>여기선 그냥 닉네임 하나.</p></div><button className="sidebar-guide" onClick={()=>setModal("guide")}><ShieldCheck size={16}/>우리끼리의 룰<ArrowUpRight size={14}/></button><div className="sidebar-footer"><Brand small/><p>퇴근 후, 우리 이야기.</p><span>© 2026 Workfolio</span></div>
      </aside>
      <main className="main-column">
        <section className="community-hero"><div className="hero-copy"><span className="hero-kicker">직장인 익명 커뮤니티 · 퇴근 후 아지트</span><h1>일은 했고,<br/>썰은 풀어야지<span>.</span></h1><p>회사 뒷담도, 상사 스트레스도.<br/>회사에서 못 한 말, 별명으로 풀고 가요.</p><button className="hero-cta" onClick={openWrite}>나도 한마디 <ArrowUpRight size={17}/></button></div><div className="community-art" aria-hidden="true"><span className="art-spark">✳</span><span className="art-sticker sticker-one">퇴근이<br/>복지다.</span><span className="art-sticker sticker-two">오늘도<br/>뇌 빼고<br/><b>정상 영업</b><span className="sticker-face">•‿•</span></span><span className="art-mini">ㅋㅋㅋ</span></div></section>
        <div className="community-notice"><span>👀</span><p><strong>일단 눈팅부터.</strong> 로그인 없이 읽고, 로그인하면 같이 떠들어요.</p><button onClick={()=>setModal("login")}>참여하기 <ArrowRight size={14}/></button></div>
        <section className="trending-section" aria-labelledby="trending-title"><div className="section-heading"><div><span className="section-kicker">지금 무슨 얘기 해?</span><h2 id="trending-title"><Flame size={23}/>지금, 급상승</h2></div><button className="text-button" onClick={()=>goFeed("전체 이야기","trending")}>전체 보기 <ArrowRight size={15}/></button></div><p className="ranking-note">{loading?"반응을 불러오는 중…":loadError?"급상승 글을 불러오지 못했어요. 아래에서 다시 불러와 주세요.":trending.length?"최근 7일 글의 좋아요·댓글과 작성 시간을 반영해요. 최신 60개 글 기준.":"최근 글에 좋아요와 댓글이 모이면 여기에 소개돼요."}</p>
        <div className="trending-grid">{featured.map((post,index)=><a className={`trending-card trending-card-${index}`} key={post.id} href={postPath(post.id)} onClick={event=>openPostLink(event,post.id)}><div className="trend-card-top"><span>{`0${index+1}`}</span><small>HOT</small></div><span className="trend-category">{post.category}</span><h3>{post.title}</h3><div className="trend-card-bottom"><span><Heart size={13}/>{post.likeCount}</span><span><MessageCircle size={13}/>{post.commentCount}</span><span><Eye size={13}/>{post.viewCount||0}</span><ArrowUpRight size={18}/></div></a>)}</div></section>
        <h2 className="base-board-heading" id="basic-boards">기본 게시판 3개</h2><div className="board-shortcuts"><a href={categoryHref("빡대가리 게시판")} onClick={event=>openCategoryLink(event,"빡대가리 게시판")}><span className="shortcut-emoji">🫠</span><span><strong>빡대가리 게시판</strong><small>내 실수·동료 썰·회사의 기행, 여기 다 풀자.</small></span><ArrowUpRight size={20}/></a><a href={categoryHref("월급루팡")} onClick={event=>openCategoryLink(event,"월급루팡")}><span className="shortcut-emoji">🥷</span><span><strong>월급루팡</strong><small>잡담과 밈 사이, 월급은 쌓이는 중.</small></span><ArrowUpRight size={20}/></a><a href={categoryHref("퇴사각 상담소")} onClick={event=>openCategoryLink(event,"퇴사각 상담소")}><span className="shortcut-emoji">🧳</span><span><strong>퇴사각 상담소</strong><small>사표 내기 전, 우리끼리 작전회의.</small></span><ArrowUpRight size={20}/></a></div>
        <section className="channel-entry-card"><div><h2>이용자 채널</h2><p>점심 메뉴 원정대부터 이직 스터디까지. 채널을 신청하면 승인 후 직접 운영할 수 있어요.</p></div><div>
          <a className="primary" href="/?channels=browse" onClick={event=>openChannelLink(event,"browse")}>채널 탐색 <ArrowRight size={16}/></a>
          <a className="text-button" href="/?channels=apply" onClick={event=>openChannelLink(event,"apply")}>채널 개설 신청</a>
        </div></section>
        <section id="feed" className="feed-section" tabIndex={-1}>{channelId&&<div className="selected-channel-context"><Users size={18}/><div><small>지금 보고 있는 채널</small><strong>{activeChannel?.name||"선택한 채널"}</strong></div><button onClick={()=>openChannels()}>채널 바꾸기</button></div>}<div className="feed-top"><div><h2>{channelId?activeChannel?.name||"채널 이야기":query?"검색 결과":topic==="전체 이야기"?"방금 올라온 썰":topic}<span>{loading?"":matching.length}</span></h2><p className="feed-description">{channelId?activeChannel?.description||"채널 정보를 불러오는 중이에요.":topic==="빡대가리 게시판"?"내 실수, 동료 빌런, 회사의 기행. 신상은 빼고 썰만 풀어요.":topic==="월급루팡"?"짧은 잡담, 긴 딴짓. 쉬어가는 것도 업무의 일부니까.":topic==="퇴사각 상담소"?"퇴사 버튼 누르기 전, 이직·커리어부터 같이 고민해요.":"사소한 썰도 환영. 댓글 한 줄이면 이미 우리 편."}</p></div><button className="text-button" onClick={openWrite}><PenLine size={15}/>글쓰기</button></div><div className="feed-tools"><div className="sort-tabs" role="group" aria-label="정렬"><button aria-pressed={sort==="latest"} className={sort==="latest"?"active":""} onClick={()=>changeSort("latest")}>최신</button><button aria-pressed={sort==="trending"} className={sort==="trending"?"active":""} onClick={()=>changeSort("trending")}><Flame size={14}/>급상승</button><button aria-pressed={sort==="popular"} className={sort==="popular"?"active":""} onClick={()=>changeSort("popular")}>좋아요순</button></div><label className="search"><Search size={17}/><input ref={searchRef} aria-label="게시글 검색" placeholder="무슨 썰을 찾으세요?" value={query} onChange={e=>setQuery(e.target.value)}/>{query&&<button aria-label="검색 지우기" onClick={()=>setQuery("")}><X size={14}/></button>}</label></div><div className="mobile-categories" aria-label="기본 게시판 3개">{["전체 이야기",...categories.map(c=>c.name)].map(name=><a key={name} className={!channelId&&topic===name?"active":""} href={name==="전체 이야기"?"/#feed":categoryHref(name)} onClick={event=>openCategoryLink(event,name)} aria-current={!channelId&&topic===name?"page":undefined}>{name==="전체 이야기"?"전체":name}</a>)}</div>
        {loading?<div className="loading-state" aria-live="polite"><div className="loader"/>썰을 주워 오는 중…</div>:loadError?<div className="empty-state" role="alert"><Coffee size={30}/><h3>잠깐, 커피 한 잔만요</h3><p>{loadError}</p><button className="primary" onClick={()=>void refresh()}>다시 불러오기</button></div>:matching.length===0?<div className="empty-state"><MessageCircle size={30}/><h3>{sort==="trending"?"아직 예열 중이에요":query?"그 썰은 아직 없네요":"이 게시판 첫 썰, 누가 풀래요?"}</h3><p>{sort==="trending"?"최근 글에 좋아요와 댓글이 모이면 여기 나타나요.":"검색어를 바꾸거나, 첫 번째 이야기를 남겨보세요."}</p><button className="secondary" onClick={()=>goFeed()}>전체 글 보기</button></div>:<div className="post-list">{matching.map(post=>{const cat=categories.find(c=>c.name===post.category);return <article className="post-card" key={post.id}><div className="post-meta">{post.channelName&&<button className="post-channel-label" onClick={()=>{const channel=channels.find(item=>item.id===post.channelId);if(channel)selectChannel(channel)}}>{post.channelName}</button>}<span className={`category-badge ${cat?.color||"green"}`}>{post.category}</span><span className="post-time">{dateLabel(post.createdAt)}</span></div><a className="post-content" href={postPath(post.id)} onClick={event=>openPostLink(event,post.id)}><h3>{post.title}<span className="inline-comment-count">[{post.commentCount}]</span></h3><p>{post.body}</p><PostImages images={post.images||[]} title={post.title} compact/></a><div className="post-bottom"><div className="author"><span className="avatar">{post.nickname.slice(0,1)}</span><span><CompanyLabel name={post.companyName} isAdmin={post.isAdminAuthor} /><span className="author-separator"> · </span>{post.nickname}</span></div><div className="card-stats"><span className="view-count" aria-label={`조회 ${post.viewCount||0}회`}><Eye size={15}/>{post.viewCount||0}</span><LikeButton post={post} compact disabled={busy} onToggle={toggleLike}/><button aria-label={`${post.title} 댓글 ${post.commentCount}개`} onClick={()=>void openPost(post.id)}><MessageCircle size={15}/>{post.commentCount}</button></div></div></article>})}</div>}
        <div className="feed-end"><span/>여기까지 봤으면, 이제 썰 하나 풀고 가요.<span/></div><p className="sample-disclosure">검색·정렬은 현재 목록의 최신 게시글 60개 기준이에요. 조회수는 글을 1초 이상 볼 때 집계하며, 같은 계정·브라우저의 중복 조회는 약 24시간 동안 제한해요. 브라우저·쿠키 변경에 따라 달라질 수 있어요.</p></section>
        <footer className="community-footer"><nav className="community-policy-links" aria-label="커뮤니티 이용 안내"><a href="/privacy">개인정보처리방침</a><a href="/terms">이용약관</a><a href="mailto:contact@workfolio.life">문의</a></nav></footer>
      </main>
      <aside className="right-sidebar"><section className="join-card"><span className="join-icon">✌</span><span className="eyebrow">회사 밖에서 만나는 우리</span><h3>{signedIn?"오늘도 버티느라\n고생했어요.":"눈팅도 좋지만,\n같이 떠들면 더 재밌지."}</h3><p>{signedIn?"여기선 직함 대신 닉네임으로.\n오늘 있었던 일 하나 풀어봐요.":"읽기는 자유롭게.\n글·댓글·좋아요는 로그인하고 함께해요."}</p><button className="primary full-width" onClick={signedIn?openWrite:()=>setModal("login")}>{signedIn?"내 썰 풀기":"로그인하고 참여하기"}<ArrowRight size={16}/></button>{!signedIn&&<span className="guest-caption">지금은 비회원으로 둘러보는 중</span>}</section>
      <section className="writing-prompt"><div className="prompt-label"><Zap size={15}/>오늘의 떡밥</div><span className="prompt-quote">“</span><h3>답장 ‘넵’ vs ‘넹’<br/>어디까지 가능?</h3><p>팀장님한테 ‘넹’ 보냈는데<br/>읽고 답이 없으시다.</p><button onClick={()=>{setDraft(d=>({...d,category:"월급루팡",title:d.title||"팀장님께 ‘넹’, 가능 vs 불가능"}));openWrite()}}>내 생각 남기기 <ArrowRight size={16}/></button><span className="prompt-sticker" aria-hidden="true">넹?</span></section>
      <section className="right-section"><h3>이런 썰, 환영합니다 <Sparkles size={17}/></h3><div className="topic-explainer">{categories.slice(0,4).map(({name,icon:Icon,color,desc})=><a key={name} href={categoryHref(name)} onClick={event=>openCategoryLink(event,name)}><span className={`topic-icon ${color}`}><Icon size={18}/></span><span><strong>{name}</strong><small>{desc}</small></span><ArrowUpRight size={14}/></a>)}</div></section>
      <section className="safe-note"><div><ShieldCheck size={20}/><h3>드립은 자유.<br/>신상 털기는 금지.</h3></div><p>나의 흑역사는 환영하지만<br/>실명·연락처는 살짝 가려주세요.</p><button onClick={()=>setModal("guide")}>우리끼리의 룰 <ArrowRight size={14}/></button></section><p className="right-foot">퇴근은 했어도, 썰은 안 끝났으니까.<br/><span>OFF WORK. ON WORKFOLIO.</span></p></aside>
    </div>
    <button className="mobile-compose primary" onClick={openWrite}><PenLine size={18}/>썰 풀기</button>
    {toast&&<div className="toast" role="status"><Check size={18}/>{toast}</div>}
    {channelTab&&modal!=="login"&&<Modal label="채널 탐색과 관리" className="channels-modal" onClose={closeChannels}><ChannelsPanel tab={channelTab} manageId={manageId} authLoading={authLoading} signedIn={signedIn} ownAccountId={ownAccountId} onNavigate={openChannels} onClose={closeChannels} onLogin={()=>setModal("login")} onSelect={selectChannel} onChanged={channelsChanged} onOpenPost={id=>void openPost(id)} onBusyChange={value=>{channelMutationBusy.current=value}}/></Modal>}
    {(selected||detailLoading||detailError)&&modal!=="report"&&modal!=="login"&&modal!=="company"&&<Modal label="이야기 상세" onClose={closeDetail} className="detail-modal"><div className="modal-top"><span className="eyebrow">회사 밖 우리 이야기</span><button className="icon-btn" aria-label="이야기 닫기" onClick={closeDetail}><X/></button></div>{detailLoading?<div className="loading-state"><div className="loader"/>이야기를 여는 중이에요.</div>:detailError?<div className="empty-state"><h3>이야기를 불러오지 못했어요</h3><p>{detailError}</p><button className="secondary" onClick={closeDetail}>목록으로</button></div>:selected&&<><div className="detail-meta">{selected.channelName&&<span className="post-channel-label">{selected.channelName}</span>}<span className={`category-badge ${categories.find(c=>c.name===selected.category)?.color}`}>{selected.category}</span><span>{dateLabel(selected.createdAt)}</span><span className="view-count"><Eye size={14}/>조회 {selected.viewCount||0}</span></div><h2 className="detail-title">{selected.title}</h2><div className="detail-author"><span className="avatar">{selected.nickname.slice(0,1)}</span><span><CompanyLabel name={selected.companyName} isAdmin={selected.isAdminAuthor} /><span className="author-separator"> · </span>{selected.nickname}</span></div><p className="detail-body">{selected.body}</p><PostImages images={selected.images||[]} title={selected.title}/><PostShare id={selected.id} title={selected.title}/><div className="detail-utility"><LikeButton key={selected.id} post={selected} disabled={busy} onToggle={toggleLike}/><div>{selected.mine&&<button onClick={()=>void deletePost()} disabled={busy}><Trash2 size={14}/>삭제</button>}<button onClick={()=>{setError("");setShareWithChannel(false);setModal(signedIn?"report":"login")}}><Flag size={14}/>신고</button></div></div><section className="comments"><h3>댓글 <span>{selected.commentCount}</span></h3>{comments.length===0?<p className="no-comments">아직 댓글이 없어요. 첫 마디는 당신 차례 👀</p>:comments.map(c=><article className="comment" key={c.id}><div><strong>{c.nickname}</strong><span>{dateLabel(c.createdAt)}</span></div><p>{c.body}</p></article>)}<form onSubmit={submitComment}><label className="sr-only" htmlFor="comment">댓글</label><textarea id="comment" value={comment} onChange={e=>setComment(e.target.value)} placeholder={signedIn?"ㅋㅋㅋ 한 글자도 환영. 편하게 남겨요.":"댓글은 로그인 후 남길 수 있어요."} maxLength={500} minLength={1} required disabled={!signedIn}/><div className="comment-actions"><span>{signedIn?`${comment.length} / 500 · 별명으로 표시돼요`:"댓글을 남기려면 로그인해 주세요."}</span>{signedIn?<button className="primary" disabled={busy||comment.trim().length<1}>댓글 등록</button>:<button type="button" className="primary" onClick={()=>setModal("login")}>로그인하고 댓글 쓰기</button>}</div></form>{error&&<p className="form-error" role="alert">{error}</p>}</section></>}</Modal>}
    {modal==="login"&&<Modal label="로그인 및 비회원 이용" onClose={()=>setModal(null)} className="login-modal"><div className="modal-top"><Brand small/><button className="icon-btn" aria-label="로그인 닫기" onClick={()=>setModal(null)}><X/></button></div><LoginContent onClose={()=>setModal(null)} providers={providers} loading={authLoading} error={authError} onRetry={()=>void refreshAuth()} returnTo={typeof window!=="undefined"?window.location.pathname+window.location.search+window.location.hash:"/"}/></Modal>}
    {modal==="company"&&<Modal label="회사 이메일 인증" onClose={closeCompany} className="company-modal"><div className="modal-top"><span className="eyebrow">회사명 공개는 내가 선택해요</span><button className="icon-btn" aria-label="회사 인증 닫기" onClick={closeCompany}><X/></button></div>{companyLoading?<p className="company-status" role="status">회사 인증 상태를 확인하는 중이에요.</p>:<><CompanyVerification company={verifiedCompany} onVerified={companyVerified} onAuthExpired={()=>mutationError(new BoardApiError("다시 로그인해 주세요.",401))}/>{companyError&&<p className="form-error" role="alert">{companyError}</p>}</>}</Modal>}
    {modal==="write"&&<Modal label="이야기 쓰기" onClose={closeWrite} className="write-modal"><div className="modal-top"><span className="eyebrow">LET IT OUT.</span><button className="icon-btn" aria-label="작성 닫기" onClick={closeWrite}><X/></button></div><h2>오늘의 썰, 풀어봅시다.</h2><p className="modal-subtitle">대단한 일 아니어도 돼요. 우리끼리 웃고 넘기면 되니까.</p><div className="privacy-tip"><ShieldCheck size={19}/><span>실명·연락처와 회사의 기밀정보는 빼주세요.<br/>별명으로 보이지만, 완전한 익명을 보장하진 않아요.</span></div>{!signedIn&&<p className="signin-notice">읽기는 가능해요. 작성하려면 <button type="button" onClick={()=>setModal("login")}>로그인</button>해 주세요.</p>}<form onSubmit={submitPost}>{channelId&&<div className="write-channel-notice"><strong>{activeChannel?.name||"선택한 채널"}에 쓰는 글이에요.</strong><p>{activeChannel?.rules}</p><label className="consent"><input type="checkbox" checked={channelConsent} onChange={event=>setChannelConsent(event.target.checked)} required/><span>채널 관리자가 이 글을 숨기거나 복원할 수 있으며, 처리 기록이 남는 데 동의해요.</span></label></div>}<label htmlFor="category">어떤 이야기인가요?</label><div className="category-options" id="category">{categories.map(({name,icon:Icon})=><button type="button" key={name} aria-pressed={draft.category===name} className={draft.category===name?"active":""} onClick={()=>setDraft({...draft,category:name})}><Icon size={16}/>{name}</button>)}</div><label htmlFor="nickname">나를 부를 별명 <span>선택 · 실명은 피해주세요</span></label><input id="nickname" value={draft.nickname} onChange={e=>setDraft({...draft,nickname:e.target.value})} maxLength={16} placeholder="비워두면 ‘익명의 동료’로 표시돼요"/><div className="company-disclosure"><label className="company-share-option"><input type="checkbox" checked={draft.shareCompany} disabled={!signedIn||!verifiedCompany||companyLoading} onChange={event=>setDraft({...draft,shareCompany:event.target.checked})}/><span>이 글에 회사명 공개</span></label><p className="company-author-preview"><CompanyLabel name={draft.shareCompany&&verifiedCompany?verifiedCompany.name:null} isAdmin={draft.shareCompany&&verifiedCompany?.isAdmin} /> · {draft.nickname.trim()||"익명의 동료"}</p>{companyLoading?<p role="status">회사 인증 상태를 확인하는 중이에요.</p>:<p>{verifiedCompany?verifiedCompany.isAdmin?"Workfolio 이메일 인증 완료. 회사 공개를 선택한 글에는 관리자 표시가 붙어요.":`${verifiedCompany.name} 이메일 인증 완료. 공개 여부는 글마다 선택해요.`:"회사 이메일 인증 후 회사명을 공개할 수 있어요."}</p>}{companyError&&<p className="form-error" role="alert">{companyError}</p>}<button type="button" className="company-verify-link" onClick={()=>openCompany(true)} disabled={busy}>{verifiedCompany?"회사 인증 관리":"회사 이메일 인증하기"}<ArrowRight size={13}/></button></div><label htmlFor="title">이야기 제목 <span>{draft.title.length} / 80</span></label><input id="title" value={draft.title} onChange={e=>setDraft({...draft,title:e.target.value})} maxLength={80} minLength={2} required placeholder="제목만 봐도 클릭하고 싶게 👀"/><label htmlFor="body">나의 이야기 <span>{draft.body.length} / 3000</span></label><textarea id="body" value={draft.body} onChange={e=>setDraft({...draft,body:e.target.value})} maxLength={3000} minLength={images.length?1:10} required placeholder={"어떤 일이 있었나요? 그때 마음은 어땠나요?\n이제는 웃으며 이야기할 수 있다면, 함께 나눠요."}/><ImageAttachments value={images} onChange={setImages} onBusyChange={setImagesBusy} disabled={busy||!signedIn}/><label className="consent"><input type="checkbox" checked={agreed} onChange={e=>setAgreed(e.target.checked)} required/><span>개인을 특정할 정보와 기밀을 포함하지 않았어요.</span></label>{error&&<p className="form-error" role="alert">{error}</p>}<div className="write-footer"><span>닫아도 작성 중인 내용은 잠시 남아 있어요.<br/>새로고침하면 사라지니 주의해 주세요.</span><button className="primary" disabled={!signedIn||busy||imagesBusy||!agreed||(!!channelId&&(!activeChannel||!channelConsent))}>{busy?"이야기 담는 중…":"이야기 등록"}<ArrowUpRight size={17}/></button></div></form></Modal>}
    {modal==="guide"&&<Modal label="커뮤니티 약속" onClose={()=>setModal(null)} className="guide-modal"><div className="modal-top"><span className="eyebrow">A LITTLE KINDNESS GOES A LONG WAY.</span><button className="icon-btn" aria-label="약속 닫기" onClick={()=>setModal(null)}><X/></button></div><div className="guide-icon"><ShieldCheck size={30}/></div><h2>웃자고 모였으니까, 선은 지켜요.</h2><p className="modal-subtitle">편하게 이야기할 수 있도록 지켜야 할 작은 약속들.</p>{[{n:"01",title:"이야기는 남기고, 개인정보는 지워요.",body:"본인과 동료의 이름, 연락처, 구체적인 부서명은 빼주세요. 회사명은 인증 후 공개 옵션으로 표시할 수 있어요. 고객정보, 내부 자료, 영업비밀은 올리지 않아요. 자동 확인만으로 모든 정보를 걸러낼 수는 없어요."},{n:"02",title:"사람보다 상황을 이야기해요.",body:"누군가를 특정해 공격하거나 사실을 단정하기보다, 내가 겪은 일과 감정을 나눠요. 차별과 혐오, 괴롭힘, 보복을 부추기는 내용은 피해주세요."},{n:"03",title:"공감은 가볍게, 말은 따뜻하게.",body:"실수를 평가하기보다 한 번쯤 나도 그랬다는 마음으로 읽어요. 도움을 청하는 이야기에는 조롱 대신 배려를 남겨요."},{n:"04",title:"읽기는 자유롭게, 참여는 로그인 후에.",body:"비회원도 글과 댓글을 읽고 검색할 수 있어요. 글·댓글·좋아요·신고는 로그인한 이용자만 남길 수 있어요. 글과 댓글, 좋아요는 서버에 저장됩니다. 신고는 기록되지만 실시간 검토나 자동 제재는 제공하지 않아요."}].map(x=><div className="guide-rule" key={x.n}><span>{x.n}</span><div><h3>{x.title}</h3><p>{x.body}</p></div></div>)}<button className="primary full-width" onClick={()=>setModal(null)}>약속할게요 <Check size={17}/></button></Modal>}
    {modal==="report"&&<Modal label="이야기 신고" onClose={()=>{if(!busy)setModal(null)}} className="report-modal"><div className="modal-top"><span className="eyebrow">함께 지키는 공간</span><button className="icon-btn" aria-label="신고 취소" onClick={()=>setModal(null)} disabled={busy}><X/></button></div><h2>어떤 점이 걱정되셨나요?</h2><p className="modal-subtitle">기본적으로 플랫폼만 확인하는 비공개 기록이에요.<br/>신고만으로 글이 자동으로 숨겨지진 않아요.</p><form onSubmit={submitReport}>{["개인정보 노출","비방·혐오·괴롭힘","기밀정보 노출","광고·스팸","기타"].map(r=><label className="report-option" key={r}><input type="radio" name="reason" value={r} checked={reportReason===r} onChange={()=>setReportReason(r)}/>{r}</label>)}{selected?.channelId&&<label className="consent channel-report-consent"><input type="checkbox" checked={shareWithChannel} onChange={event=>setShareWithChannel(event.target.checked)}/><span>이 신고 사유를 채널 관리자에게도 공유할게요. 선택하지 않으면 플랫폼만 확인해요. 신고자 정보는 공개되지 않아요.</span></label>}{error&&<p className="form-error" role="alert">{error}</p>}<button className="primary full-width" disabled={busy||!signedIn}>{busy?"저장하는 중…":"신고 내용 저장"}</button></form></Modal>}
  </>
}
