import { SITE_ORIGIN, STATIC_SITEMAP_PATHS } from '../src/lib/community/seo';
import { escapeMarkup, readOnly, xmlResponse } from './_lib/community-seo';

// These public navigation pages remain available without D1 or authentication.
export const onRequest: PagesFunction = ({ request }) => readOnly(request, async () =>
  xmlResponse(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${STATIC_SITEMAP_PATHS.map(path => `<url><loc>${escapeMarkup(SITE_ORIGIN + path)}</loc></url>`).join('')}</urlset>`));
