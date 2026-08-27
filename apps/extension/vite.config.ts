import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import { crx } from '@crxjs/vite-plugin';
import manifest from './manifest.config.js';

export default defineConfig({
  plugins: [react(), tailwind(), crx({ manifest })],
  build: {
    target: 'chrome116',
    emptyOutDir: true,
    rollupOptions: {
      // The offscreen document is opened by chrome.offscreen.createDocument,
      // not referenced from the manifest, so crxjs does not discover it. Left
      // out of the inputs it is simply never built, and createDocument 404s at
      // runtime — invisible to unit tests, which all mock chrome.offscreen.
      input: { offscreen: 'src/offscreen/index.html' },
    },
  },
});
