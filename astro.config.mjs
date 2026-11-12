// @ts-check
import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';
import sitemap from '@astrojs/sitemap';
import react from '@astrojs/react';

// https://astro.build/config
export default defineConfig({
  output: 'static',
  site: 'https://workfolio.life',
  integrations: [react(), sitemap({
    filter: (page) => !page.includes('/admin'),
  })],
  vite: {
    plugins: [tailwindcss()],
  },
});