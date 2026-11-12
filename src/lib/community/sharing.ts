import { SITE_ORIGIN, postPath } from './seo';

export function postShareUrl(id: string): string {
  return SITE_ORIGIN + postPath(id);
}

/** These links open an editable share composer; they never publish a post themselves. */
export function postShareLinks(id: string, title: string) {
  const url = postShareUrl(id);
  const link = (base: string, values: Record<string, string>) => `${base}?${new URLSearchParams(values)}`;
  return [
    { name: 'X', href: link('https://twitter.com/intent/tweet', { text: title, url }) },
    { name: 'Facebook', href: link('https://www.facebook.com/sharer/sharer.php', { u: url }) },
    { name: 'Threads', href: link('https://www.threads.com/intent/post', { text: `${title}\n${url}` }) },
    { name: 'LINE', href: link('https://social-plugins.line.me/lineit/share', { url, text: title }) },
  ];
}

export function shareWasCancelled(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'name' in error && error.name === 'AbortError';
}
