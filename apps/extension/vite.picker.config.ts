import { defineConfig } from 'vite';

/**
 * A third, separate build for the injected element picker, for the same
 * reason vite.collector.config.ts is separate from the crxjs build:
 * chrome.scripting.executeScript({ files: [...] }) cannot resolve module
 * specifiers, so this entry must be one self-contained IIFE file.
 */
export default defineConfig({
  build: {
    target: 'chrome116',
    outDir: 'dist',
    emptyOutDir: false,
    lib: {
      entry: 'src/content/picker-entry.ts',
      formats: ['iife'],
      name: 'pageCapturePicker',
      fileName: () => 'picker.js',
    },
  },
});
