import { useEffect, useRef, useState } from 'react';
import { Copy, Share2 } from 'lucide-react';
import { postShareLinks, postShareUrl, shareWasCancelled } from '../../lib/community/sharing';
import '../../styles/community-share.css';

export function PostShare({ id, title }: { id: string; title: string }) {
  const url = postShareUrl(id);
  const [nativeAvailable, setNativeAvailable] = useState(false);
  const [message, setMessage] = useState('');
  const [manualCopy, setManualCopy] = useState(false);
  const copyField = useRef<HTMLInputElement>(null);
  useEffect(() => { setNativeAvailable(typeof navigator.share === 'function'); }, []);
  useEffect(() => { setMessage(''); setManualCopy(false); }, [id]);
  useEffect(() => { if (manualCopy) { copyField.current?.focus(); copyField.current?.select(); } }, [manualCopy]);
  async function copy() {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(url);
      setManualCopy(false); setMessage('링크를 복사했어요.');
    } catch {
      setManualCopy(true); setMessage('아래 링크를 길게 누르거나 선택해서 복사해 주세요.');
    }
  }
  async function share() {
    setMessage('');
    try { await navigator.share({ title, url }); }
    catch (error) { if (!shareWasCancelled(error)) setMessage('공유창을 열지 못했어요. SNS 버튼이나 링크 복사를 이용해 주세요.'); }
  }
  return <details className="post-share" onClick={event => event.stopPropagation()}>
    <summary aria-label="이 글 공유하기"><Share2 size={16} aria-hidden="true"/>공유</summary>
    <div className="post-share-options">
      <p className="post-share-title">이 이야기를 함께 나눠요.</p>
      <div className="post-share-buttons">
        {nativeAvailable && <button type="button" onClick={share}><Share2 size={15} aria-hidden="true"/>앱으로 공유</button>}
        <button type="button" onClick={copy}><Copy size={15} aria-hidden="true"/>링크 복사</button>
      </div>
      <div className="post-share-socials" role="group" aria-label="SNS로 공유">
        {postShareLinks(id, title).map(item => <a key={item.name} className={`post-share-service post-share-${item.name.toLowerCase()}`} href={item.href} target="_blank" rel="noopener noreferrer" aria-label={`${item.name}에 공유 (새 창)`}>
          <span className="post-share-icon"><img src={`/share/${item.name.toLowerCase()}.svg`} width="32" height="32" alt="" aria-hidden="true"/></span>
          <span>{item.name}</span>
        </a>)}
      </div>
      {nativeAvailable && <p className="post-share-help">앱으로 공유에서 휴대폰에 설치된 공유 앱을 선택할 수 있어요.</p>}
      <p className="post-share-status" role="status">{message}</p>
      {manualCopy && <input ref={copyField} className="post-share-copy" value={url} readOnly aria-label="복사할 게시글 링크" onFocus={event => event.currentTarget.select()}/>}
    </div>
  </details>;
}
