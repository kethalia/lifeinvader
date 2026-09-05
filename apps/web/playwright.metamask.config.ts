import { defineConfig } from '@playwright/test'

export default defineConfig({
  expect: { timeout: 15_000 },
  fullyParallel: false,
  outputDir: 'test-results/metamask',
  reporter: [['list']],
  testDir: './e2e',
  testMatch: 'metamask.smoke.spec.ts',
  timeout: 180_000,
  workers: 1,
})
