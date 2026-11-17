// Read-only HTML rendering never changes a counter. Count an actual visible detail view instead.
(() => {
  const article = document.querySelector('[data-view-post]');
  const label = article?.querySelector('[data-view-count]');
  const postId = article?.getAttribute('data-view-post');
  if (!postId || !label) return;
  let timer;
  let started = false;
  let controller;
  async function record() {
    if (started || document.visibilityState !== 'visible') return;
    started = true;
    controller = new AbortController();
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        const response = await fetch('/api/views', {
          method: 'POST', credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
          headers: {'Content-Type': 'application/json'}, body: JSON.stringify({postId}),
        });
        if (!response.ok) return;
        const data = await response.json();
        if (controller.signal.aborted) return;
        if (Number.isSafeInteger(data.viewCount) && data.viewCount >= 0) label.textContent = `조회 ${data.viewCount.toLocaleString('ko-KR')}`;
        if (data.retry !== true) return;
      }
    } catch { /* Counting must never interrupt reading or repeat an uncertain write. */ }
  }
  function schedule() {
    clearTimeout(timer);
    if (document.visibilityState !== 'visible') { controller?.abort(); return; }
    if (!started) timer = setTimeout(record, 1000);
  }
  document.addEventListener('visibilitychange', schedule);
  window.addEventListener('pagehide', () => { clearTimeout(timer); controller?.abort(); }, {once: true});
  schedule();
})();
