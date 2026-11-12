// @ts-check
import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';
import sitemap from '@astrojs/sitemap';
import react from '@astrojs/react';
import { BOARD_PAGES, SITE_ORIGIN, boardPath } from './src/lib/community/seo.ts';

// https://astro.build/config
export default defineConfig({
  output: 'static',
  site: 'https://workfolio.life',
  integrations: [react(), sitemap({
    filter: (page) => ['', '/privacy', '/terms', '/studio', ...BOARD_PAGES.map(board => boardPath(board.slug))].includes(new URL(page).pathname.replace(/\/$/, '')),
    customPages: BOARD_PAGES.map(board => `${SITE_ORIGIN}${boardPath(board.slug)}`),
  })],
  vite: {
    plugins: [tailwindcss()],
  },
});
