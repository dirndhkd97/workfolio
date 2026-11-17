export type ViewResult = { viewCount: number; counted: boolean; retry?: boolean };

// One cookie-establishing retry only. Never retry failed or uncertain mutations.
export async function recordView(postId: string, signal: AbortSignal, fetcher: typeof fetch = fetch): Promise<ViewResult | null> {
  for (let attempt = 0; attempt < 2 && !signal.aborted; attempt++) {
    const response = await fetcher('/api/views', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ postId }), credentials: 'same-origin', signal,
    });
    if (!response.ok || signal.aborted) return null;
    const result = await response.json() as ViewResult;
    if (signal.aborted) return null;
    if (!result.retry) return result;
  }
  return null;
}

type VisibilitySource = Pick<Document, 'visibilityState' | 'addEventListener' | 'removeEventListener'>;
export function watchVisibleView(postId: string, onResult: (result: ViewResult) => void, options: {
  document?: VisibilitySource; fetcher?: typeof fetch; delayMs?: number;
} = {}): () => void {
  const source = options.document ?? document;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let controller: AbortController | undefined;
  let stopped = false, submitted = false;
  const cancel = () => { clearTimeout(timer); timer = undefined; controller?.abort(); };
  const sync = () => {
    cancel();
    if (stopped || submitted || source.visibilityState !== 'visible') return;
    timer = setTimeout(async () => {
      if (stopped || source.visibilityState !== 'visible') return;
      submitted = true;
      controller = new AbortController();
      try {
        const result = await recordView(postId, controller.signal, options.fetcher);
        if (!stopped && !controller.signal.aborted && result) onResult(result);
      } catch { /* Reading stays available if counting fails. */ }
    }, options.delayMs ?? 1000);
  };
  source.addEventListener('visibilitychange', sync);
  sync();
  return () => { stopped = true; cancel(); source.removeEventListener('visibilitychange', sync); };
}
