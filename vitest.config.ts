import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // Only the popup test needs a DOM. Everything else stays in Node, which is
    // faster and keeps browser globals out of tests that must not rely on them.
    environmentMatchGlobs: [['apps/extension/tests/popup.test.tsx', 'jsdom']],
    include: [
      'packages/*/tests/**/*.test.ts',
      'apps/*/tests/**/*.test.ts',
      'apps/*/tests/**/*.test.tsx',
    ],
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**', 'apps/*/src/**'],
    },
  },
});
