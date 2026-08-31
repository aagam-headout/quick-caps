import js from '@eslint/js';
import tseslint from 'typescript-eslint';

const forbiddenInCore = [
  'chrome',
  'browser',
  'window',
  'document',
  'globalThis',
  'process',
  'require',
  '__dirname',
];

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/coverage/**',
      '**/test-results/**',
      '**/playwright-report/**',
      // Browser scripts served to e2e fixture pages. They are page content, not
      // project source, and linting them as such only produces false positives
      // about browser globals they legitimately use.
      'apps/extension/e2e/fixtures/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Plain-JS bin and workspace scripts run directly by Node (no TypeScript,
    // no build step) — they need Node globals that js.configs.recommended
    // doesn't assume by default.
    files: ['**/bin/*.mjs', 'scripts/*.mjs'],
    languageOptions: {
      globals: {
        process: 'readonly',
      },
    },
  },
  {
    // The core boundary. packages/core must run in any host — a browser
    // extension, a Node CLI — so it may not reach for a host global or a
    // Node built-in. It receives its DOM and its driver as parameters.
    files: ['packages/core/src/**/*.ts'],
    rules: {
      'no-restricted-globals': ['error', ...forbiddenInCore],
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['node:*'], message: 'core must not use Node built-ins' },
          ],
        },
      ],
      '@typescript-eslint/no-explicit-any': 'error',
    },
  },
);
