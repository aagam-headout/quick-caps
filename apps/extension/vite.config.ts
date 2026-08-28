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
    // We target Chrome 116+, which supports modulepreload natively. Shipping
    // Vite's polyfill only produces an unused-preload warning in the popup.
    modulePreload: { polyfill: false },
    rollupOptions: {
      // The offscreen document is opened by chrome.offscreen.createDocument,
      // and the onboarding page by chrome.tabs.create — neither is referenced
      // from the manifest, so crxjs does not discover them. Left out of the
      // inputs they are simply never built, and the runtime call 404s —
      // invisible to unit tests, which all mock the chrome APIs involved.
      input: {
        offscreen: 'src/offscreen/index.html',
        onboarding: 'src/onboarding/index.html',
      },
    },
  },
});
