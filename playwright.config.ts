import { defineConfig } from '@playwright/test'

/** Real-Electron rendering checks (e2e/). Run `pnpm build` first: they load out/renderer. */
export default defineConfig({
  testDir: 'e2e',
  outputDir: 'test-results/e2e',
  // One Electron app per window width; its cases share it, in order.
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  forbidOnly: !!process.env['CI'],
  reporter: process.env['CI'] ? [['list'], ['github']] : 'list',
  use: { trace: 'retain-on-failure' },
})
