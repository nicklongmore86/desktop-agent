import { _electron as electron, expect, test, type Page } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The ChatGPT · Plan screens in a real Electron window (fake main, real renderer): OpenAI's
 * button, the first-use plan notice, the composer label with Manage usage, the limit error
 * and the invitation shown to Codex · ChatGPT users. With E2E_SHOTS_DIR set, each screen is
 * also saved as a screenshot (light and dark, phone-narrow and desktop).
 */

const SHOTS = process.env['E2E_SHOTS_DIR']
const MANAGE_USAGE = 'https://chatgpt.com/settings/usage'

interface PlanE2e {
  setLoginPending: (next: boolean) => void
  finishLogin: () => void
  pushChat: (event: unknown) => void
}
const e2e = <T>(page: Page, run: (api: PlanE2e) => T): Promise<T> =>
  page.evaluate<T>(`(${run.toString()})(window.e2e)`)

async function launch(width: number, scheme: 'light' | 'dark') {
  const app = await electron.launch({
    args: [
      ...(process.platform === 'linux' ? ['--no-sandbox'] : []),
      join(__dirname, 'harness/main.cjs'),
    ],
    cwd: join(__dirname, '..'),
    env: { ...process.env, E2E_WIDTH: String(width), E2E_HEIGHT: '800', E2E_SCENARIO: 'set-up' },
  })
  const page = await app.firstWindow()
  await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' })
  // Electron keeps one profile across launches, and "seen" flags live in localStorage: start
  // from none, so the one-time notice and the invitation show in every test.
  await page.evaluate(() => {
    localStorage.clear()
  })
  await page.reload()
  const shot = async (name: string): Promise<void> => {
    if (!SHOTS) return
    mkdirSync(SHOTS, { recursive: true })
    // Two frames, so a media-query repaint has settled before the capture.
    await page.evaluate(
      () =>
        new Promise<void>((done) => {
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              done()
            })
          })
        }),
    )
    await page.screenshot({ path: join(SHOTS, `${name}-${scheme}-${String(width)}.png`) })
  }
  return { app, page, shot }
}

const noSidewaysScroll = (page: Page): Promise<boolean> =>
  page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)

for (const width of [1280, 360]) {
  for (const scheme of ['light', 'dark'] as const) {
    test(`ChatGPT · Plan screens at ${String(width)}px, ${scheme}`, async () => {
      const { app, page, shot } = await launch(width, scheme)
      try {
        await page.getByRole('button', { name: 'Preferences', exact: true }).click()
        await page
          .getByRole('dialog', { name: 'Settings' })
          .getByRole('button', { name: 'Add connection' })
          .click()
        await page
          .getByRole('dialog', { name: 'Which AI do you want to use?' })
          .getByRole('button', { name: /^ChatGPT/ })
          .click()
        const access = page.getByRole('dialog', { name: 'How do you want to use ChatGPT?' })
        await access.getByRole('radio', { name: /Plan/ }).click()
        await access.getByRole('button', { name: 'Continue', exact: true }).click()
        const signIn = page.getByRole('dialog', { name: 'Sign in with ChatGPT' })
        const button = signIn.getByRole('button', { name: 'Continue with ChatGPT' })
        await expect(button).toBeVisible()
        // OpenAI's logo is drawn by the mask: it has size and takes the button's text colour.
        const logo = button.locator('.chatgpt-button-logo')
        expect(await logo.evaluate((node) => node.getBoundingClientRect().width)).toBe(21)
        expect(
          await logo.evaluate((node) => getComputedStyle(node).maskImage.includes('chatgpt-logo')),
        ).toBe(true)
        // A keyboard user reaches it and sees the focus ring.
        await button.focus()
        await expect(button).toBeFocused()
        await shot('1-sign-in-button')

        await e2e(page, (api) => {
          api.setLoginPending(true)
        })
        await button.click()
        await expect(signIn.getByRole('button', { name: 'Cancel sign-in' })).toBeVisible()
        await shot('2-sign-in-waiting')
        await e2e(page, (api) => {
          api.finishLogin()
        })
        await expect(signIn.getByText('Connected')).toBeVisible()
        await signIn.getByRole('button', { name: 'Continue', exact: true }).click()
        await page
          .getByRole('dialog', { name: 'Pick a model' })
          .getByRole('button', { name: 'Continue', exact: true })
          .click()
        await page
          .getByRole('dialog', { name: 'Choose a folder to work in' })
          .getByRole('button', { name: 'Continue', exact: true })
          .click()
        await page
          .getByRole('dialog', { name: 'You’re all set' })
          .getByRole('button', { name: 'Start chatting' })
          .click()

        // Settings (where Add connection was opened) is still open under the wizard; the
        // notice waits for it rather than stacking on it.
        await expect(
          page.getByRole('dialog', { name: 'You’re using your ChatGPT plan' }),
        ).toHaveCount(0)
        await page.getByRole('button', { name: 'Close settings' }).click()

        // The one-time notice, with focus on Got it.
        const notice = page.getByRole('dialog', { name: 'You’re using your ChatGPT plan' })
        await expect(notice).toBeVisible()
        await expect(notice.getByRole('button', { name: 'Got it' })).toBeFocused()
        await expect(notice.getByRole('link', { name: 'Manage usage' })).toHaveAttribute(
          'href',
          MANAGE_USAGE,
        )
        expect(await noSidewaysScroll(page)).toBe(true)
        await shot('3-plan-notice')
        await page.keyboard.press('Tab')
        await expect(notice.getByRole('link', { name: 'Manage usage' })).toBeFocused()
        await page.keyboard.press('Tab')
        await expect(notice.getByRole('button', { name: 'Got it' })).toBeFocused()
        await page.keyboard.press('Enter')
        await expect(notice).toHaveCount(0)

        // The composer label and the limit error, both with Manage usage.
        const label = page.locator('.plan-label')
        await expect(label).toContainText('Using ChatGPT plan')
        await expect(label.getByRole('link', { name: 'Manage usage' })).toHaveAttribute(
          'href',
          MANAGE_USAGE,
        )
        await e2e(page, (api) => {
          api.pushChat({ type: 'run_started', runId: 'r1', text: 'Summarise my notes' })
          api.pushChat({
            type: 'error',
            runId: 'r1',
            code: 'usage_limit',
            message:
              'ChatGPT usage limit reached for your plan or this app. Choose Manage usage to review it at https://chatgpt.com/settings/usage.',
          })
          api.pushChat({ type: 'run_finished', runId: 'r1', stopReason: 'error' })
        })
        const banner = page.getByRole('alert').filter({ hasText: 'Plan limit reached' })
        await expect(banner.getByRole('link', { name: 'Manage usage' })).toHaveAttribute(
          'href',
          MANAGE_USAGE,
        )
        expect(await noSidewaysScroll(page)).toBe(true)
        await shot('4-composer-label-and-limit')
      } finally {
        await app.close()
      }
    })

    test(`Codex invitation at ${String(width)}px, ${scheme}`, async () => {
      const { app, page, shot } = await launch(width, scheme)
      try {
        await page
          .getByRole('combobox', { name: 'Active provider' })
          .selectOption({ label: 'Codex · ChatGPT' })
        const invite = page.getByRole('region', { name: 'New' })
        await expect(invite).toContainText('Use your ChatGPT plan in this app.')
        await expect(page.locator('.plan-label')).toHaveCount(0)
        expect(await noSidewaysScroll(page)).toBe(true)
        await shot('5-codex-invitation')

        await invite.getByRole('button', { name: 'Set up ChatGPT · Plan' }).click()
        await expect(page.getByRole('dialog', { name: 'Sign in with ChatGPT' })).toBeVisible()
        await expect(page.getByRole('button', { name: 'Continue with ChatGPT' })).toBeVisible()
      } finally {
        await app.close()
      }
    })
  }
}
