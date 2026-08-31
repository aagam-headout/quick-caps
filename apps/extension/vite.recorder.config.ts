import { defineConfig } from 'vite';

/**
 * A fourth, separate build for the MAIN-world recorder, for the same reason
 * vite.picker.config.ts is separate: the recorder is no longer a manifest
 * content script (see background/recorder-registration.ts - registration is
 * the only place the "is it wanted?" decision can be made), and a
 * dynamically registered script's js entries cannot resolve module
 * specifiers, so this entry must be one self-contained IIFE file.
 */
export default defineConfig({
  build: {
    target: 'chrome116',
    outDir: 'dist',
    emptyOutDir: false,
    lib: {
      entry: 'src/content/recorder-entry.ts',
      formats: ['iife'],
      name: 'pageCaptureRecorder',
      fileName: () => 'recorder.js',
    },
  },
});
