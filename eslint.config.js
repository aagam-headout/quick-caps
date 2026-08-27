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
    ignores: ['**/dist/**', '**/node_modules/**', '**/coverage/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
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
