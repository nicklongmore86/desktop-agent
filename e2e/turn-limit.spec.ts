import { _electron as electron, expect, test, type Page } from '@playwright/test'
import { join } from 'node:path'

/**
 * A reply paused at its turn limit, in real Electron: the neutral notice with Continue
 * (disabled while the run is still going, then one normal send of "Continue"), gone after
 * New chat, at a phone-narrow and a desktop width; and the limit in Settings.
 */

interface E2e {
  pushChat: (event: unknown) => void
  sendCalls: () => { text: string; ids: string[] }[]
}

const PAUSED = 'Paused after 35 steps. Your progress is saved.'

const launch = (width: number) =>
  electron.launch({
    args: [
      ...(process.platform === 'linux' ? ['--no-sandbox'] : []),
      join(__dirname, 'harness/main.cjs'),
    ],
    cwd: join(__dirname, '..'),
    env: { ...process.env, E2E_WIDTH: String(width), E2E_HEIGHT: '800' },
  })

const push = (page: Page, events: unknown[]) =>
  page.evaluate((list) => {
    const api = (window as unknown as { e2e: E2e }).e2e
    for (const event of list) api.pushChat(event)
  }, events)

const sendCalls = (page: Page) =>
  page.evaluate(() => (window as unknown as { e2e: E2e }).e2e.sendCalls())

for (const width of [360, 1280]) {
  test(`a paused reply offers Continue at ${String(width)}px`, async () => {
    const app = await launch(width)
    try {
      const page = await app.firstWindow()
      await expect(page.getByRole('textbox', { name: 'Message' })).toBeVisible()

      await push(page, [
        { type: 'run_started', runId: 'r1', text: 'Tidy my folder' },
        { type: 'error', runId: 'r1', code: 'max_turns', message: PAUSED },
      ])
      const notice = page.getByRole('status').filter({ hasText: PAUSED })
      await expect(notice).toBeVisible()
      await expect(notice).toHaveClass(/banner-info/)
      await expect(page.getByRole('alert').filter({ hasText: PAUSED })).toHaveCount(0)
      const button = notice.getByRole('button', { name: 'Continue' })
      // The run has not finished yet.
      await expect(button).toBeDisabled()

      await push(page, [{ type: 'run_finished', runId: 'r1', stopReason: 'max_turns' }])
      await expect(button).toBeEnabled()
      await expect(button).toBeInViewport()
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
        ),
      ).toBe(true)
      await button.click()
      await expect.poll(() => sendCalls(page)).toEqual([{ text: 'Continue', ids: [] }])

      // Starting another chat clears it for good.
      await page.getByRole('button', { name: 'New chat' }).first().click()
      await expect(page.getByText(PAUSED)).toHaveCount(0)
      await expect(page.getByRole('button', { name: 'Continue', exact: true })).toHaveCount(0)
    } finally {
      await app.close()
    }
  })
}

test('the steps-per-message limit is in Settings › Agent', async () => {
  const app = await launch(1280)
  try {
    const page = await app.firstWindow()
    await page.getByRole('button', { name: 'Settings' }).first().click()
    await page.getByRole('button', { name: 'Agent', exact: true }).click()
    const input = page.getByRole('spinbutton', { name: 'Steps per message' })
    await expect(input).toHaveValue('35')
    await input.fill('60')
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(page.getByText('Saved. It applies from your next message.')).toBeVisible()
    await input.fill('500')
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(page.getByRole('alert')).toHaveText(
      'Choose a whole number of steps from 5 to 100.',
    )
  } finally {
    await app.close()
  }
})
