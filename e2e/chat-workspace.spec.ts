import { _electron as electron, expect, test } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { ChatEvent } from '../src/shared/ipc'

for (const width of [360, 1280]) {
  test(`workspace chat stays usable at ${String(width)}px and labels the selected provider`, async () => {
    const app = await electron.launch({
      args: [
        ...(process.platform === 'linux' ? ['--no-sandbox'] : []),
        join(__dirname, 'harness/main.cjs'),
      ],
      cwd: join(__dirname, '..'),
      env: { ...process.env, E2E_WIDTH: String(width), E2E_HEIGHT: '800' },
    })
    try {
      const page = await app.firstWindow()
      await page.emulateMedia({ colorScheme: 'dark' })
      await expect(page.getByRole('heading', { name: 'Workspace chat' })).toBeVisible()
      const provider = width > 540 ? 'Codex · ChatGPT' : 'Claude · API'
      if (width > 540) await page.getByLabel('Active provider').selectOption('codex-subscription')
      await expect(page.locator('.provider-badge')).toHaveText(provider)
      await expect(page.getByText('1 folder granted')).toBeVisible()
      await expect(
        page.getByRole('heading', { name: 'What would you like to work on?' }),
      ).toBeVisible()
      mkdirSync(join(__dirname, '../e2e-artifacts'), { recursive: true })
      await page.screenshot({
        path: join(__dirname, `../e2e-artifacts/workspace-welcome-${String(width)}.png`),
      })
      await page.evaluate(() => {
        const api = (window as unknown as { e2e: { pushChat: (event: ChatEvent) => void } }).e2e
        api.pushChat({
          type: 'run_started',
          runId: 'sample',
          text: 'Can you find the RFI folder in Downloads?',
        })
        api.pushChat({
          type: 'text_delta',
          runId: 'sample',
          turn: 1,
          text: 'I found **RFI** in your Downloads folder. I can list its documents or help you organise them.',
        })
      })
      await expect(page.getByText(`${provider} is working…`)).toBeVisible()
      await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeInViewport()
      const bounds = await page.locator('.composer textarea').boundingBox()
      expect(bounds?.width).toBeGreaterThan(150)
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true)
      await page.screenshot({
        path: join(__dirname, `../e2e-artifacts/workspace-chat-${String(width)}.png`),
      })
    } finally {
      await app.close()
    }
  })
}
