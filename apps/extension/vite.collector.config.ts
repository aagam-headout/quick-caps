import { defineConfig } from 'vite';

/**
 * A second, separate build for the injected collector.
 *
 * chrome.scripting.executeScript({ files: [...] }) cannot resolve module
 * specifiers, so this entry must be one self-contained file with no imports.
 * It is built apart from the crxjs build rather than as another input to it:
 * crxjs owns its input list, and forcing an IIFE format across that build
 * would break the popup and the service worker, both of which must stay ESM.
 */
export default defineConfig({
  build: {
    target: 'chrome116',
    outDir: 'dist',
    emptyOutDir: false,
    lib: {
      entry: 'src/content/collector-inject.ts',
      formats: ['iife'],
      name: 'pageCaptureCollector',
      fileName: () => 'collector.js',
    },
  },
});
