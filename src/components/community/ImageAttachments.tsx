import { useEffect, useId, useRef, useState, type ChangeEvent } from "react";
import { ImagePlus, RotateCcw, X } from "lucide-react";
import type { PostImage } from "../../lib/community/domain";
import { deletePendingImage, IMAGE_LIMITS, uploadPostImage } from "./image-utils";
import "../../styles/community-images.css";

type Props = {
  value: PostImage[];
  onChange: (images: PostImage[]) => void;
  onBusyChange?: (busy: boolean) => void;
  disabled?: boolean;
};

export function ImageAttachments({ value, onChange, onBusyChange, disabled = false }: Props) {
  const inputId = useId();
  const input = useRef<HTMLInputElement>(null);
  const pending = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  const callbacks = useRef({ onChange, onBusyChange }); callbacks.current = { onChange, onBusyChange };
  const current = useRef(value); current.current = value;
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState({ current: 0, total: 0 });
  const [errors, setErrors] = useState<string[]>([]);
  const [failedFiles, setFailedFiles] = useState<File[]>([]);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; pending.current?.abort(); pending.current = null; callbacks.current.onBusyChange?.(false); };
  }, []);

  function update(images: PostImage[]) { current.current = images; callbacks.current.onChange(images); }
  function setWorking(working: boolean) { setBusy(working); callbacks.current.onBusyChange?.(working); }

  async function attach(files: File[]) {
    if (disabled || pending.current || !files.length) return;
    if (current.current.length + files.length > IMAGE_LIMITS.count) {
      setErrors([`이미지는 최대 ${IMAGE_LIMITS.count}장까지 첨부할 수 있어요. 지금은 ${IMAGE_LIMITS.count - current.current.length}장 더 고를 수 있어요.`]);
      return;
    }
    const controller = new AbortController(); pending.current = controller;
    setWorking(true); setErrors([]); setFailedFiles([]);
    const failed: File[] = [], messages: string[] = [];
    try {
      for (let index = 0; index < files.length; index++) {
        if (controller.signal.aborted) { failed.push(...files.slice(index)); break; }
        setProgress({ current: index + 1, total: files.length });
        try {
          const image = await uploadPostImage(files[index], controller.signal);
          if (!mounted.current || pending.current !== controller) {
            // A successful response arriving during close is still an unclaimed draft upload.
            void deletePendingImage(image).catch(() => {});
            break;
          }
          update([...current.current, image]);
        } catch (cause) {
          if (controller.signal.aborted) { failed.push(...files.slice(index)); break; }
          failed.push(files[index]);
          messages.push(`${files[index].name}: ${cause instanceof Error ? cause.message : "이미지를 첨부하지 못했어요."}`);
        }
      }
      if (mounted.current && pending.current === controller) {
        setFailedFiles(failed);
        setErrors(controller.signal.aborted ? ["첨부를 중단했어요. 이미 추가한 이미지는 남아 있어요."] : messages);
      }
    } finally {
      if (mounted.current && pending.current === controller) { pending.current = null; setWorking(false); }
    }
  }

  function select(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.currentTarget.files || []);
    event.currentTarget.value = "";
    void attach(files);
  }

  async function remove(image: PostImage) {
    if (disabled || pending.current) return;
    const controller = new AbortController(); pending.current = controller;
    setWorking(true); setErrors([]); setProgress({ current: 0, total: 0 });
    const previous = current.current;
    // Remove from the controlled draft before the request, so closing during deletion
    // cannot leave a dead image reference in the preserved draft.
    update(previous.filter(item => item.id !== image.id));
    try {
      await deletePendingImage(image, controller.signal);
    } catch (cause) {
      if (mounted.current && !controller.signal.aborted) { update(previous); setErrors([cause instanceof Error ? cause.message : "이미지를 지우지 못했어요."]); }
    } finally {
      if (mounted.current && pending.current === controller) { pending.current = null; setWorking(false); }
    }
  }

  return <section className="image-attachments" aria-labelledby={`${inputId}-label`} aria-busy={busy}>
    <div className="image-attachments-heading"><strong id={`${inputId}-label`}>이미지 첨부</strong><span>{value.length} / {IMAGE_LIMITS.count}</span></div>
    <input ref={input} id={inputId} type="file" accept="image/jpeg,image/png,image/webp" multiple tabIndex={-1} className="image-file-input" disabled={disabled || busy || value.length >= IMAGE_LIMITS.count} onChange={select} aria-label="첨부할 이미지 선택" />
    {value.length > 0 && <ol className="image-attachment-list">{value.map((image, index) => <li key={image.id}>
      <img src={image.url} width={image.width} height={image.height} alt={`첨부 이미지 ${index + 1}`} />
      <span className="image-attachment-number">{index + 1}</span>
      <button type="button" className="image-remove" aria-label={`첨부 이미지 ${index + 1} 삭제`} disabled={disabled || busy} onClick={() => void remove(image)}><X size={17} aria-hidden="true" /></button>
    </li>)}</ol>}
    <div className="image-attachment-actions">
      <button type="button" className="image-choose" disabled={disabled || busy || value.length >= IMAGE_LIMITS.count} onClick={() => input.current?.click()}><ImagePlus size={18} aria-hidden="true" />이미지 선택</button>
      {!busy && failedFiles.length > 0 && <button type="button" className="image-retry" disabled={disabled || value.length + failedFiles.length > IMAGE_LIMITS.count} onClick={() => void attach(failedFiles)}><RotateCcw size={16} aria-hidden="true" />실패한 {failedFiles.length}장 다시 시도</button>}
      {busy && progress.total > 0 && <button type="button" className="image-cancel" onClick={() => pending.current?.abort()}>첨부 중단</button>}
    </div>
    <p className="image-attachment-help">JPG·PNG·WebP, 한 장당 10MB 이하 · 최대 10장<br />사진 속 이름·연락처·회사 기밀도 확인해 주세요.</p>
    {busy && <p className="image-upload-status" role="status">{progress.total ? `이미지 ${progress.current} / ${progress.total}장 첨부 중…` : "첨부 이미지를 지우는 중…"}</p>}
    {!busy && errors.length > 0 && <div className="image-upload-errors" role="alert">{errors.map((error, index) => <p key={index}>{error}</p>)}</div>}
  </section>;
}

export function PostImages({ images, title, compact = false }: { images: PostImage[]; title: string; compact?: boolean }) {
  if (!images.length) return null;
  if (compact) return <span className="post-image-thumbnail"><img src={images[0].url} width={images[0].width} height={images[0].height} loading="lazy" alt={`${title} 첨부 이미지`} />{images.length > 1 && <span>{images.length}장</span>}</span>;
  return <div className="post-images">{images.map((image, index) => <figure key={image.id}><a href={image.url} target="_blank" rel="noopener noreferrer" aria-label={`첨부 이미지 ${index + 1} 크게 보기 (새 창)`}><img src={image.url} width={image.width} height={image.height} loading="lazy" alt={`${title} 첨부 이미지 ${index + 1}`} /></a></figure>)}</div>;
}
