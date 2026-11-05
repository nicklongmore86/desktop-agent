import { defineConfig } from '@playwright/test'

/** Real-Electron rendering checks (e2e/). Run `pnpm build` first: they load out/renderer. */
export default defineConfig({
  testDir: 'e2e',
  outputDir: 'test-results/e2e',
  // One Electron app per window width; its cases share it, in order.
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  // How long a page gets to show what a test waits for; the 5 s default is what failed. Windows CI
  // runners stall now and then: in the traces of real failures and near misses, a page that
  // normally takes under a second needed 6.4 and 6.7 s, with the disk queue up and svchost using
  // 30% of the machine meanwhile (PR #79's first run; stress run 42112963105, shard 11). A test
  // that normally takes 2.4 s took 10.4 s. Only a failing test ever waits this long.
  expect: { timeout: 30_000 },
  forbidOnly: !!process.env['CI'],
  reporter: process.env['CI'] ? [['list'], ['github']] : 'list',
  use: { trace: 'retain-on-failure' },
})
