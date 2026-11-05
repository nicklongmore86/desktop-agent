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
  // runners stall now and then, for up to two minutes, with the disk queue at 4 to 15 and little
  // CPU in use. A page that normally takes under a second then needed 6.4 and 6.7 s (PR #79's first
  // run; stress run 42112963105, shard 11), and in stress run 42115982950, shard 11, one wait took
  // 24 s and four tests in a row took 23 to 36 s instead of 1 to 2 s. Only a failing test ever
  // waits this long.
  expect: { timeout: 30_000 },
  forbidOnly: !!process.env['CI'],
  reporter: process.env['CI'] ? [['list'], ['github']] : 'list',
  use: { trace: 'retain-on-failure' },
})
