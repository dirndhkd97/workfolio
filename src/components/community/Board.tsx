import { useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowRight, ArrowUpRight, Check, Coffee, Flame, Zap, LogIn, LogOut, Flag, Heart, HelpCircle, Home, Laugh, Menu, MessageCircle, PenLine, Search, ShieldCheck, Sparkles, ThumbsUp, Trash2, Users, X } from "lucide-react";

import type { Category, Reaction, Post, Comment } from "../../lib/community/domain";
import { engagementCount, getTrendingPosts } from "../../lib/community/feed";
import { LoginContent, type LoginProvider } from "./LoginContent";

const categories: {name: Category; icon: typeof Coffee; color: string; desc: string}[] = [
  { name: "빡대가리 게시판", icon: Zap, color: "pink", desc: "오늘의 뇌절, 내 얘기였네" },
  { name: "월급루팡", icon: Coffee, color: "lime", desc: "일하는 척하면서 들어오세요" },
  { name: "웃픈 실수", icon: Coffee, color: "orange", desc: "지나고 보니 웃긴 나의 흑역사" },
  { name: "황당한 순간", icon: HelpCircle, color: "purple", desc: "이게 정말 회사에서 일어난 일?" },
  { name: "회사 사람들", icon: Users, color: "blue", desc: "동료, 상사, 그리고 우리 이야기" },
  { name: "소소한 일상", icon: Sparkles, color: "green", desc: "별것 아닌데 오래 남는 순간" },
];
const reactions: {key: Reaction; label: string; icon: typeof Heart}[] = [{key:"same",label:"ㅇㅈ",icon:ThumbsUp},{key:"laugh",label:"ㅋㅋㅋ",icon:Laugh},{key:"cheer",label:"힘내라 우리",icon:Heart}];

class BoardApiError extends Error {
  constructor(message: string, public status: number) { super(message); }
}

async function api<T>(body?: unknown, id?: string): Promise<T> {
  const res = await fetch(`/api/board${id ? `?id=${encodeURIComponent(id)}` : ""}`, body ? {method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)} : {cache:"no-store"});
  const data = await res.json() as T & { error?: string };
  if (!res.ok) throw new BoardApiError(data.error || "잠시 연결이 어려워요. 다시 시도해 주세요.", res.status);
  return data;
}
function dateLabel(time: number, sample = false) {
  if(sample) return "예시 사연";
  const delta = Math.max(0, Date.now()-time);
  if(delta < 60000) return "방금 전";
  if(delta < 3600000) return `${Math.floor(delta/60000)}분 전`;
  if(delta < 86400000) return `${Math.floor(delta/3600000)}시간 전`;
  return new Intl.DateTimeFormat("ko-KR",{month:"short",day:"numeric"}).format(time);
}
function Brand({small=false}:{small?:boolean}){return <span className={`brand ${small?"small":""}`}><span className="brand-mark"><span/><span/><span/></span>workfolio<span className="brand-dot">.</span></span>}
function Modal({children,onClose,label,className=""}:{children:ReactNode;onClose:()=>void;label:string;className?:string}){
  const ref=useRef<HTMLDialogElement>(null);
  useEffect(()=>{const dialog=ref.current;dialog?.showModal();return()=>dialog?.close()},[]);
  return <dialog ref={ref} aria-label={label} className={`modal ${className}`} onCancel={e=>{e.preventDefault();onClose()}} onClick={e=>{if(e.target===e.currentTarget)onClose()}}><div className="modal-inside">{children}</div></dialog>
}

export default function Board(){
  const [posts,setPosts]=useState<Post[]>([]),[loading,setLoading]=useState(true),[loadError,setLoadError]=useState("");
  const [topic,setTopic]=useState("전체 이야기"),[sort,setSort]=useState("latest"),[query,setQuery]=useState(""),[mobileMenu,setMobileMenu]=useState(false);
  const [signedIn,setSignedIn]=useState(false),[modal,setModal]=useState<"write"|"guide"|"report"|"login"|null>(null),[selected,setSelected]=useState<Post|null>(null),[comments,setComments]=useState<Comment[]>([]),[detailLoading,setDetailLoading]=useState(false),[detailError,setDetailError]=useState("");
  const [busy,setBusy]=useState(false),[error,setError]=useState(""),[toast,setToast]=useState("");
  const [draft,setDraft]=useState({category:"빡대가리 게시판" as Category,title:"",body:"",nickname:""}),[agreed,setAgreed]=useState(false),[comment,setComment]=useState(""),[reportReason,setReportReason]=useState("개인정보 노출");
  const [providers,setProviders]=useState<LoginProvider[]>([]),[authLoading,setAuthLoading]=useState(true),[authError,setAuthError]=useState("");
  const detailRequest=useRef(0);
  const searchRef=useRef<HTMLInputElement>(null);
  const refresh=async()=>{setLoading(true);setLoadError("");try{const d=await api<{posts:Post[];signedIn:boolean}>();setPosts(d.posts);setSignedIn(d.signedIn)}catch(e){setLoadError((e as Error).message)}finally{setLoading(false)}};
  async function refreshAuth(){
    setAuthLoading(true);setAuthError("");
    try {
      const response=await fetch("/api/community-auth/me",{cache:"no-store"});
      if(!response.ok)throw new Error("로그인 연결 상태를 확인하지 못했어요. 다시 시도해 주세요.");
      const data=await response.json() as {signedIn:boolean;providers:LoginProvider[]};
      setSignedIn(data.signedIn);setProviders(data.providers);
    } catch(e){setAuthError((e as Error).message)} finally {setAuthLoading(false)}
  }
  function mutationError(e:unknown){
    if(e instanceof BoardApiError&&e.status===401){setSignedIn(false);setModal("login");setAuthError("로그인이 만료됐어요. 다시 로그인해 주세요.");return}
    setError((e as Error).message);setToast((e as Error).message);
  }
  async function logout(){
    if(busy)return;setBusy(true);
    try{
      const response=await fetch("/api/community-auth/logout",{method:"POST",headers:{"Content-Type":"application/json"},body:"{}"});
      if(!response.ok)throw new Error("로그아웃하지 못했어요. 다시 시도해 주세요.");
      setSignedIn(false);setSelected(null);setModal(null);setComments([]);setComment("");
      const url=new URL(window.location.href);url.searchParams.delete("story");window.history.replaceState(null,"",url);
      await refresh();setToast("로그아웃했어요. 글은 계속 읽을 수 있어요.");
    }catch(e){setToast((e as Error).message)}finally{setBusy(false)}
  }
  useEffect(()=>{void refresh();void refreshAuth()},[]);
  useEffect(()=>{if(!toast)return;const t=setTimeout(()=>setToast(""),3500);return()=>clearTimeout(t)},[toast]);
  async function openPost(id:string,push=true){
    const seq=++detailRequest.current;setModal(null);setError("");setDetailError("");setComments([]);setComment("");
    setSelected(posts.find(p=>p.id===id)||null);setDetailLoading(true);
    if(push){const url=new URL(window.location.href);url.searchParams.set("story",id);window.history.pushState({story:id},"",url)}
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
  function closeDetail(){if(busy)return;detailRequest.current++;setSelected(null);setDetailLoading(false);setDetailError("");setError("");const u=new URL(window.location.href);u.searchParams.delete("story");window.history.replaceState(null,"",u)}
  function chooseTopic(t:string){setTopic(t);setMobileMenu(false);setQuery("")}
  function openWrite(){setError("");setModal(signedIn?"write":"login")}
  function closeWrite(){if(busy)return;setModal(null);setError("")}
  const trending=getTrendingPosts(posts);
  const filtered=posts.filter(p=>(topic==="전체 이야기"||p.category===topic)&&(!query||`${p.title} ${p.body} ${p.nickname}`.toLowerCase().includes(query.toLowerCase())));
  const matching=sort==="trending"?getTrendingPosts(filtered):filtered.sort((a,b)=>sort==="popular"?engagementCount(b)-engagementCount(a)||b.createdAt-a.createdAt:Number(a.sample)-Number(b.sample)||b.createdAt-a.createdAt);
  function goFeed(t="전체 이야기",nextSort="latest"){chooseTopic(t);setSort(nextSort);document.getElementById("feed")?.scrollIntoView({behavior:"smooth"})}
  const featured=trending.length?trending.slice(0,3):posts.filter(p=>p.sample).slice(0,3);
  function updatePost(p:Post){setPosts(old=>old.map(x=>x.id===p.id?p:x));setSelected(old=>old?.id===p.id?p:old)}
  async function reactTo(p:Post,key:Reaction){if(!signedIn){setModal("login");return}if(busy)return;setBusy(true);setError("");try{const d=await api<{post:Post}>({action:"react",postId:p.id,reaction:key});updatePost(d.post)}catch(e){mutationError(e)}finally{setBusy(false)}}
  async function submitPost(e:React.FormEvent){e.preventDefault();if(busy||!agreed)return;setBusy(true);setError("");try{const d=await api<{post:Post}>({action:"create",...draft});setPosts(old=>[d.post,...old]);setDraft({category:"웃픈 실수",title:"",body:"",nickname:""});setAgreed(false);setModal(null);setTopic("전체 이야기");setQuery("");setSort("latest");setToast("썰 풀기 완료. 이제 반응을 기다려볼까요? 👀");void openPost(d.post.id)}catch(e){mutationError(e)}finally{setBusy(false)}}
  async function submitComment(e:React.FormEvent){e.preventDefault();if(!selected||busy)return;setBusy(true);setError("");try{const d=await api<{comment:Comment}>({action:"comment",postId:selected.id,body:comment});setComments(old=>[...old,d.comment]);updatePost({...selected,commentCount:selected.commentCount+1});setComment("")}catch(e){mutationError(e)}finally{setBusy(false)}}
  async function submitReport(e:React.FormEvent){e.preventDefault();if(!selected||busy)return;setBusy(true);setError("");try{await api({action:"report",postId:selected.id,reason:reportReason});setModal(null);setToast("신고 내용을 저장했어요. 비공개 검토용 기록입니다.")}catch(e){mutationError(e)}finally{setBusy(false)}}
  async function deletePost(){if(!selected||busy||!confirm("이 사연과 댓글을 삭제할까요? 삭제 후 복원할 수 없어요."))return;setBusy(true);try{await api({action:"delete",postId:selected.id});setPosts(old=>old.filter(p=>p.id!==selected.id));setSelected(null);const u=new URL(location.href);u.searchParams.delete("story");history.replaceState(null,"",u);setToast("사연을 삭제했어요.")}catch(e){mutationError(e)}finally{setBusy(false)}}
  function ReactionButtons({post}:{post:Post}){return <div className="reaction-list">{reactions.map(({key,label,icon:Icon})=><button key={key} className={`reaction ${post.myReactions.includes(key)?"reacted":""}`} aria-pressed={post.myReactions.includes(key)} aria-label={`${label} ${post.reactions[key]}`} disabled={busy} onClick={()=>void reactTo(post,key)}><Icon size={16}/><span>{label}</span><b>{post.reactions[key]}</b></button>)}</div>}
  return <>
    <a className="skip-link" href="#feed">이야기로 바로 가기</a>
    <header className="header"><div className="header-inner">
      <button className="brand-button" aria-label="Workfolio 홈" onClick={()=>{chooseTopic("전체 이야기");setSort("latest");window.scrollTo({top:0,behavior:"smooth"})}}><Brand/></button>
      <nav className="header-nav" aria-label="주 메뉴"><button className="active" onClick={()=>goFeed()}>커뮤니티</button><button onClick={()=>goFeed("전체 이야기","trending")}>급상승 <Flame size={14}/></button><button onClick={()=>setModal("guide")}>이용 가이드</button></nav>
      <div className="header-actions">{signedIn?<button className="login-button" onClick={()=>void logout()} disabled={busy}><LogOut size={15}/>로그아웃</button>:<button className="login-button" onClick={()=>setModal("login")}><LogIn size={16}/>로그인</button>}<button className="primary header-write" onClick={openWrite}><PenLine size={16}/>글쓰기</button><button className="icon-btn mobile-menu" aria-label="게시판 메뉴" aria-expanded={mobileMenu} onClick={()=>setMobileMenu(!mobileMenu)}><Menu size={22}/></button></div>
    </div></header>
    <div className="app-shell">
      <aside className={`left-sidebar ${mobileMenu?"show-mobile":""}`}>
        <p className="eyebrow sidebar-label">퇴근 후 접속 완료</p><nav className="side-nav" aria-label="게시판"><button className={topic==="전체 이야기"?"selected":""} onClick={()=>goFeed()}><Home size={19}/>전체 게시판</button><button onClick={()=>goFeed("전체 이야기","trending")}><Flame size={19}/>지금 급상승<span className="hot-label">HOT</span></button><div className="side-divider"/><p className="board-label">취향대로 골라보기</p>{categories.map(({name,icon:Icon})=><button key={name} className={topic===name?"selected":""} onClick={()=>goFeed(name)}><Icon size={19}/>{name}{name==="빡대가리 게시판"&&<span className="new-dot"/>}</button>)}</nav>
        <div className="sidebar-note"><span className="small-flower">✳</span><h3>직함 OFF. 본캐 ON.</h3><p>부장님도 신입도<br/>여기선 그냥 닉네임 하나.</p></div><button className="sidebar-guide" onClick={()=>setModal("guide")}><ShieldCheck size={16}/>우리끼리의 룰<ArrowUpRight size={14}/></button><div className="sidebar-footer"><Brand small/><p>퇴근 후, 우리 이야기.</p><span>© 2026 Workfolio</span></div>
      </aside>
      <main className="main-column">
        <section className="community-hero"><div className="hero-copy"><span className="hero-kicker">직장인들의 퇴근 후 아지트</span><h1>일은 했고,<br/>썰은 풀어야지<span>.</span></h1><p>오늘의 삽질부터 월급루팡 꿀팁까지.<br/>회사에선 못 한 말, 여기서 풀고 가요.</p><button className="hero-cta" onClick={openWrite}>나도 한마디 <ArrowUpRight size={17}/></button></div><div className="community-art" aria-hidden="true"><span className="art-spark">✳</span><span className="art-sticker sticker-one">퇴근이<br/>복지다.</span><span className="art-sticker sticker-two">오늘도<br/>뇌 빼고<br/><b>정상 영업</b><span className="sticker-face">•‿•</span></span><span className="art-mini">ㅋㅋㅋ</span></div></section>
        <div className="community-notice"><span>👀</span><p><strong>일단 눈팅부터.</strong> 로그인 없이 읽고, 로그인하면 같이 떠들어요.</p><button onClick={()=>setModal("login")}>참여하기 <ArrowRight size={14}/></button></div>
        <section className="trending-section" aria-labelledby="trending-title"><div className="section-heading"><div><span className="section-kicker">지금 무슨 얘기 해?</span><h2 id="trending-title"><Flame size={23}/>지금, 급상승</h2></div><button className="text-button" onClick={()=>goFeed("전체 이야기","trending")}>전체 보기 <ArrowRight size={15}/></button></div><p className="ranking-note">{loading?"반응을 불러오는 중…":loadError?"급상승 글을 불러오지 못했어요. 아래에서 다시 불러와 주세요.":trending.length?"최근 7일 글의 공감·댓글과 작성 시간을 반영해요. 최신 60개 글 기준.":"아직 급상승 글이 없어요. 먼저 예시 썰을 구경하고, 첫 반응의 주인공이 되어보세요."}</p>
        <div className="trending-grid">{featured.map((post,index)=><button className={`trending-card trending-card-${index}`} key={post.id} onClick={()=>void openPost(post.id)}><div className="trend-card-top"><span>{trending.length?`0${index+1}`:["ㅋㅋ","헉","ㅇㅈ"][index]}</span><small>{post.sample?"예시 썰":"HOT"}</small></div><span className="trend-category">{post.category}</span><h3>{post.title}</h3><div className="trend-card-bottom"><span><Heart size={13}/>{engagementCount(post)}</span><span><MessageCircle size={13}/>{post.commentCount}</span><ArrowUpRight size={18}/></div></button>)}</div></section>
        <div className="board-shortcuts"><button onClick={()=>goFeed("빡대가리 게시판")}><span className="shortcut-emoji">🫠</span><span><strong>빡대가리 게시판 <b>NEW</b></strong><small>방금 한 실수, 혼자 간직하지 마.</small></span><ArrowUpRight size={20}/></button><button onClick={()=>goFeed("월급루팡")}><span className="shortcut-emoji">🥷</span><span><strong>월급루팡</strong><small>사장님, 저 지금 일하고 있어요.</small></span><ArrowUpRight size={20}/></button></div>
        <section id="feed" className="feed-section"><div className="feed-top"><div><h2>{query?"검색 결과":topic==="전체 이야기"?"방금 올라온 썰":topic}<span>{loading?"":matching.length}</span></h2><p className="feed-description">{topic==="빡대가리 게시판"?"남 말고 나를 놀리는 곳. 오늘의 뇌절을 박제해요.":topic==="월급루팡"?"짧은 잡담, 긴 딴짓. 쉬어가는 것도 업무의 일부니까.":"사소한 썰도 환영. 댓글 한 줄이면 이미 우리 편."}</p></div><button className="text-button" onClick={openWrite}><PenLine size={15}/>글쓰기</button></div><div className="feed-tools"><div className="sort-tabs" role="group" aria-label="정렬"><button aria-pressed={sort==="latest"} className={sort==="latest"?"active":""} onClick={()=>setSort("latest")}>최신</button><button aria-pressed={sort==="trending"} className={sort==="trending"?"active":""} onClick={()=>setSort("trending")}><Flame size={14}/>급상승</button><button aria-pressed={sort==="popular"} className={sort==="popular"?"active":""} onClick={()=>setSort("popular")}>공감순</button></div><label className="search"><Search size={17}/><input ref={searchRef} aria-label="게시글 검색" placeholder="무슨 썰을 찾으세요?" value={query} onChange={e=>setQuery(e.target.value)}/>{query&&<button aria-label="검색 지우기" onClick={()=>setQuery("")}><X size={14}/></button>}</label></div><div className="mobile-categories">{["전체 이야기",...categories.map(c=>c.name)].map(name=><button key={name} className={topic===name?"active":""} onClick={()=>chooseTopic(name)}>{name==="전체 이야기"?"전체":name}</button>)}</div>
        {loading?<div className="loading-state" aria-live="polite"><div className="loader"/>썰을 주워 오는 중…</div>:loadError?<div className="empty-state" role="alert"><Coffee size={30}/><h3>잠깐, 커피 한 잔만요</h3><p>{loadError}</p><button className="primary" onClick={()=>void refresh()}>다시 불러오기</button></div>:matching.length===0?<div className="empty-state"><MessageCircle size={30}/><h3>{sort==="trending"?"아직 예열 중이에요":query?"그 썰은 아직 없네요":"이 게시판 첫 썰, 누가 풀래요?"}</h3><p>{sort==="trending"?"최근 글에 공감과 댓글이 모이면 여기 나타나요.":"검색어를 바꾸거나, 첫 번째 이야기를 남겨보세요."}</p><button className="secondary" onClick={()=>{setQuery("");setTopic("전체 이야기");setSort("latest")}}>전체 글 보기</button></div>:<div className="post-list">{matching.map(post=>{const cat=categories.find(c=>c.name===post.category);return <article className="post-card" key={post.id}><div className="post-meta"><span className={`category-badge ${cat?.color||"green"}`}>{post.category}</span>{post.sample&&<span className="example-label">가상 예시</span>}<span className="post-time">{dateLabel(post.createdAt,post.sample)}</span></div><button className="post-content" onClick={()=>void openPost(post.id)}><h3>{post.title}<span className="inline-comment-count">[{post.commentCount}]</span></h3><p>{post.body}</p></button><div className="post-bottom"><div className="author"><span className="avatar">{post.nickname.slice(0,1)}</span><span>{post.nickname}</span></div><div className="card-stats"><button aria-label={`${post.title} 공감 ${engagementCount(post)}개`} onClick={()=>void reactTo(post,"same")}><Heart size={15}/>{engagementCount(post)}</button><button aria-label={`${post.title} 댓글 ${post.commentCount}개`} onClick={()=>void openPost(post.id)}><MessageCircle size={15}/>{post.commentCount}</button></div></div></article>})}</div>}
        <div className="feed-end"><span/>여기까지 봤으면, 이제 썰 하나 풀고 가요.<span/></div><p className="sample-disclosure">‘가상 예시’는 체험용 창작 글입니다. 공감·댓글 수는 실제 반응만 표시합니다.<br/>검색·정렬은 최신 게시글 60개와 예시 글을 대상으로 합니다.</p></section>
      </main>
      <aside className="right-sidebar"><section className="join-card"><span className="join-icon">✌</span><span className="eyebrow">회사 밖에서 만나는 우리</span><h3>{signedIn?"오늘도 버티느라\n고생했어요.":"눈팅도 좋지만,\n같이 떠들면 더 재밌지."}</h3><p>{signedIn?"여기선 직함 대신 닉네임으로.\n오늘 있었던 일 하나 풀어봐요.":"읽기는 자유롭게.\n글·댓글·공감은 로그인하고 함께해요."}</p><button className="primary full-width" onClick={signedIn?openWrite:()=>setModal("login")}>{signedIn?"내 썰 풀기":"로그인하고 참여하기"}<ArrowRight size={16}/></button>{!signedIn&&<span className="guest-caption">지금은 비회원으로 둘러보는 중</span>}</section>
      <section className="writing-prompt"><div className="prompt-label"><Zap size={15}/>오늘의 떡밥</div><span className="prompt-quote">“</span><h3>답장 ‘넵’ vs ‘넹’<br/>어디까지 가능?</h3><p>팀장님한테 ‘넹’ 보냈는데<br/>읽고 답이 없으시다.</p><button onClick={()=>{setDraft(d=>({...d,category:"월급루팡",title:d.title||"팀장님께 ‘넹’, 가능 vs 불가능"}));openWrite()}}>내 생각 남기기 <ArrowRight size={16}/></button><span className="prompt-sticker" aria-hidden="true">넹?</span></section>
      <section className="right-section"><h3>이런 썰, 환영합니다 <Sparkles size={17}/></h3><div className="topic-explainer">{categories.slice(0,4).map(({name,icon:Icon,color,desc})=><button key={name} onClick={()=>goFeed(name)}><span className={`topic-icon ${color}`}><Icon size={18}/></span><span><strong>{name}</strong><small>{desc}</small></span><ArrowUpRight size={14}/></button>)}</div></section>
      <section className="safe-note"><div><ShieldCheck size={20}/><h3>드립은 자유.<br/>신상 털기는 금지.</h3></div><p>나의 흑역사는 환영하지만<br/>실명·회사명은 살짝 가려주세요.</p><button onClick={()=>setModal("guide")}>우리끼리의 룰 <ArrowRight size={14}/></button></section><p className="right-foot">퇴근은 했어도, 썰은 안 끝났으니까.<br/><span>OFF WORK. ON WORKFOLIO.</span></p></aside>
    </div>
    <button className="mobile-compose primary" onClick={openWrite}><PenLine size={18}/>썰 풀기</button>
    {toast&&<div className="toast" role="status"><Check size={18}/>{toast}</div>}
    {(selected||detailLoading||detailError)&&modal!=="report"&&modal!=="login"&&<Modal label="이야기 상세" onClose={closeDetail} className="detail-modal"><div className="modal-top"><span className="eyebrow">회사 밖 우리 이야기</span><button className="icon-btn" aria-label="이야기 닫기" onClick={closeDetail}><X/></button></div>{detailLoading?<div className="loading-state"><div className="loader"/>이야기를 여는 중이에요.</div>:detailError?<div className="empty-state"><h3>이야기를 불러오지 못했어요</h3><p>{detailError}</p><button className="secondary" onClick={closeDetail}>목록으로</button></div>:selected&&<><div className="detail-meta"><span className={`category-badge ${categories.find(c=>c.name===selected.category)?.color}`}>{selected.category}</span><span>{dateLabel(selected.createdAt,selected.sample)}</span></div><h2 className="detail-title">{selected.title}</h2><div className="detail-author"><span className="avatar">{selected.nickname.slice(0,1)}</span><span>{selected.nickname}</span>{selected.sample&&<span className="example-label">가상 이야기</span>}</div><p className="detail-body">{selected.body}</p><ReactionButtons post={selected}/><div className="detail-utility"><span>이 썰, 당신의 반응은?</span><div>{selected.mine&&<button onClick={()=>void deletePost()} disabled={busy}><Trash2 size={14}/>삭제</button>}<button onClick={()=>{setError("");setModal(signedIn?"report":"login")}}><Flag size={14}/>신고</button></div></div><section className="comments"><h3>댓글 <span>{selected.commentCount}</span></h3>{comments.length===0?<p className="no-comments">아직 댓글이 없어요. 첫 마디는 당신 차례 👀</p>:comments.map(c=><article className="comment" key={c.id}><div><strong>{c.nickname}</strong><span>{dateLabel(c.createdAt)}</span></div><p>{c.body}</p></article>)}<form onSubmit={submitComment}><label className="sr-only" htmlFor="comment">댓글</label><textarea id="comment" value={comment} onChange={e=>setComment(e.target.value)} placeholder={signedIn?"ㅋㅋㅋ 한 글자도 환영. 편하게 남겨요.":"댓글은 로그인 후 남길 수 있어요."} maxLength={500} minLength={1} required disabled={!signedIn}/><div className="comment-actions"><span>{signedIn?`${comment.length} / 500 · 별명으로 표시돼요`:"댓글을 남기려면 로그인해 주세요."}</span>{signedIn?<button className="primary" disabled={busy||comment.trim().length<1}>댓글 등록</button>:<button type="button" className="primary" onClick={()=>setModal("login")}>로그인하고 댓글 쓰기</button>}</div></form>{error&&<p className="form-error" role="alert">{error}</p>}</section></>}</Modal>}
    {modal==="login"&&<Modal label="로그인 및 비회원 이용" onClose={()=>setModal(null)} className="login-modal"><div className="modal-top"><Brand small/><button className="icon-btn" aria-label="로그인 닫기" onClick={()=>setModal(null)}><X/></button></div><LoginContent onClose={()=>setModal(null)} providers={providers} loading={authLoading} error={authError} onRetry={()=>void refreshAuth()} returnTo={typeof window!=="undefined"?window.location.pathname+window.location.search+window.location.hash:"/"}/></Modal>}
    {modal==="write"&&<Modal label="이야기 쓰기" onClose={closeWrite} className="write-modal"><div className="modal-top"><span className="eyebrow">LET IT OUT.</span><button className="icon-btn" aria-label="작성 닫기" onClick={closeWrite}><X/></button></div><h2>오늘의 썰, 풀어봅시다.</h2><p className="modal-subtitle">대단한 일 아니어도 돼요. 우리끼리 웃고 넘기면 되니까.</p><div className="privacy-tip"><ShieldCheck size={19}/><span>실명·회사명·연락처와 회사의 기밀정보는 빼주세요.<br/>별명으로 보이지만, 완전한 익명을 보장하진 않아요.</span></div>{!signedIn&&<p className="signin-notice">읽기는 가능해요. 작성하려면 <button type="button" onClick={()=>setModal("login")}>로그인</button>해 주세요.</p>}<form onSubmit={submitPost}><label htmlFor="category">어떤 이야기인가요?</label><div className="category-options" id="category">{categories.map(({name,icon:Icon})=><button type="button" key={name} aria-pressed={draft.category===name} className={draft.category===name?"active":""} onClick={()=>setDraft({...draft,category:name})}><Icon size={16}/>{name}</button>)}</div><label htmlFor="nickname">나를 부를 별명 <span>선택 · 실명은 피해주세요</span></label><input id="nickname" value={draft.nickname} onChange={e=>setDraft({...draft,nickname:e.target.value})} maxLength={16} placeholder="비워두면 ‘익명의 동료’로 표시돼요"/><label htmlFor="title">이야기 제목 <span>{draft.title.length} / 80</span></label><input id="title" value={draft.title} onChange={e=>setDraft({...draft,title:e.target.value})} maxLength={80} minLength={2} required placeholder="제목만 봐도 클릭하고 싶게 👀"/><label htmlFor="body">나의 이야기 <span>{draft.body.length} / 3000</span></label><textarea id="body" value={draft.body} onChange={e=>setDraft({...draft,body:e.target.value})} maxLength={3000} minLength={10} required placeholder={"어떤 일이 있었나요? 그때 마음은 어땠나요?\n이제는 웃으며 이야기할 수 있다면, 함께 나눠요."}/><label className="consent"><input type="checkbox" checked={agreed} onChange={e=>setAgreed(e.target.checked)} required/><span>개인을 특정할 정보와 기밀을 포함하지 않았으며,<br/>누군가를 비방하는 글이 아닌지 확인했어요.</span></label>{error&&<p className="form-error" role="alert">{error}</p>}<div className="write-footer"><span>닫아도 작성 중인 내용은 잠시 남아 있어요.<br/>새로고침하면 사라지니 주의해 주세요.</span><button className="primary" disabled={!signedIn||busy||!agreed}>{busy?"이야기 담는 중…":"이야기 등록"}<ArrowUpRight size={17}/></button></div></form></Modal>}
    {modal==="guide"&&<Modal label="커뮤니티 약속" onClose={()=>setModal(null)} className="guide-modal"><div className="modal-top"><span className="eyebrow">A LITTLE KINDNESS GOES A LONG WAY.</span><button className="icon-btn" aria-label="약속 닫기" onClick={()=>setModal(null)}><X/></button></div><div className="guide-icon"><ShieldCheck size={30}/></div><h2>웃자고 모였으니까, 선은 지켜요.</h2><p className="modal-subtitle">편하게 이야기할 수 있도록 지켜야 할 작은 약속들.</p>{[{n:"01",title:"이야기는 남기고, 개인정보는 지워요.",body:"본인과 동료의 이름, 회사명, 연락처, 구체적인 부서명은 빼주세요. 고객정보, 내부 자료, 영업비밀도 올리지 않아요. 자동 확인만으로 모든 정보를 걸러낼 수는 없어요."},{n:"02",title:"사람보다 상황을 이야기해요.",body:"누군가를 특정해 공격하거나 사실을 단정하기보다, 내가 겪은 일과 감정을 나눠요. 차별과 혐오, 괴롭힘, 보복을 부추기는 내용은 피해주세요."},{n:"03",title:"공감은 가볍게, 말은 따뜻하게.",body:"실수를 평가하기보다 한 번쯤 나도 그랬다는 마음으로 읽어요. 도움을 청하는 이야기에는 조롱 대신 배려를 남겨요."},{n:"04",title:"읽기는 자유롭게, 참여는 로그인 후에.",body:"비회원도 글과 댓글을 읽고 검색할 수 있어요. 글·댓글·공감·신고는 로그인한 이용자만 남길 수 있어요. 가상 예시는 따로 표시하며 실제 글과 반응은 서버에 저장됩니다. 신고는 기록되지만 실시간 검토나 자동 제재는 제공하지 않아요."}].map(x=><div className="guide-rule" key={x.n}><span>{x.n}</span><div><h3>{x.title}</h3><p>{x.body}</p></div></div>)}<button className="primary full-width" onClick={()=>setModal(null)}>약속할게요 <Check size={17}/></button></Modal>}
    {modal==="report"&&<Modal label="이야기 신고" onClose={()=>{if(!busy)setModal(null)}} className="report-modal"><div className="modal-top"><span className="eyebrow">함께 지키는 공간</span><button className="icon-btn" aria-label="신고 취소" onClick={()=>setModal(null)} disabled={busy}><X/></button></div><h2>어떤 점이 걱정되셨나요?</h2><p className="modal-subtitle">신고 사유는 비공개 기록으로 저장됩니다.<br/>현재 실시간 검토나 자동 숨김은 제공되지 않아요.</p><form onSubmit={submitReport}>{["개인정보 노출","비방·혐오·괴롭힘","기밀정보 노출","광고·스팸","기타"].map(r=><label className="report-option" key={r}><input type="radio" name="reason" value={r} checked={reportReason===r} onChange={()=>setReportReason(r)}/>{r}</label>)}{error&&<p className="form-error" role="alert">{error}</p>}<button className="primary full-width" disabled={busy||!signedIn}>{busy?"저장하는 중…":"신고 내용 저장"}</button></form></Modal>}
  </>
}
