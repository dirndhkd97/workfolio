// Sharing stays local until the visitor chooses an app or a social network.
for (const section of document.querySelectorAll('[data-post-share]')) {
  const url = section.dataset.shareUrl;
  const title = section.dataset.shareTitle;
  const status = section.querySelector('[data-share-status]');
  const field = section.querySelector('input');
  const copy = section.querySelector('[data-copy-share]');
  const native = section.querySelector('[data-native-share]');
  field.addEventListener('focus', () => field.select());
  copy.hidden = false;
  copy.addEventListener('click', async () => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(url);
      status.textContent = '링크를 복사했어요.';
    } catch {
      status.textContent = '아래 링크를 길게 누르거나 선택해서 복사해 주세요.';
      field.focus(); field.select();
    }
  });
  if (typeof navigator.share === 'function') {
    native.hidden = false;
    native.addEventListener('click', async () => {
      status.textContent = '';
      try { await navigator.share({ title, url }); }
      catch (error) {
        if (error?.name !== 'AbortError') status.textContent = '공유창을 열지 못했어요. SNS 버튼이나 링크 복사를 이용해 주세요.';
      }
    });
  }
}
