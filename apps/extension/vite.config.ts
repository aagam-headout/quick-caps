import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import { crx } from '@crxjs/vite-plugin';
import manifest from './manifest.config.js';

export default defineConfig({
  plugins: [react(), tailwind(), crx({ manifest })],
  build: { target: 'chrome116', emptyOutDir: true },
});
