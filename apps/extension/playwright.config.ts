import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  // Serializing a real page through SingleFile is not fast.
  timeout: 120_000,
  expect: { timeout: 20_000 },
  // A single browser with one loaded extension; these cannot run in parallel.
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: { headless: false },
});
