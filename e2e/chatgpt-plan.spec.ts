import { _electron as electron, expect, test, type Page } from '@playwright/test'
import { join } from 'node:path'

/**
 * Sign in with ChatGPT through the Add connection wizard in a real Electron window
 * (fake main, real renderer): the Plan option and its note, the plain sign-in button,
 * waiting and Cancel, then the model and the finished connection. Closing while it waits
 * puts everything back.
 */

interface PlanE2e {
  setLoginPending: (next: boolean) => void
  finishLogin: () => void
  loginLog: () => { login: string[]; cancel: number }
  connectionCalls: () => { add: string[]; remove: string[]; status: string[]; set: string[] }
}

const e2e = <T>(page: Page, run: (api: PlanE2e) => T): Promise<T> =>
  page.evaluate<T>(`(${run.toString()})(window.e2e)`)

async function launch() {
  const app = await electron.launch({
    args: [
      ...(process.platform === 'linux' ? ['--no-sandbox'] : []),
      join(__dirname, 'harness/main.cjs'),
    ],
    cwd: join(__dirname, '..'),
    env: { ...process.env, E2E_WIDTH: '1280', E2E_HEIGHT: '800', E2E_SCENARIO: 'set-up' },
  })
  const page = await app.firstWindow()
  await page.emulateMedia({ reducedMotion: 'reduce' })
  return { app, page }
}

async function toPlanSignIn(page: Page) {
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
  await expect(access.getByRole('radio')).toHaveCount(4)
  await access.getByRole('radio', { name: /Plan/ }).click()
  await expect(
    access.getByText(
      'Documented for ChatGPT Plus and Pro. On other plans, use Subscription (Codex).',
    ),
  ).toBeVisible()
  await access.getByRole('button', { name: 'Continue' }).click()
  const signIn = page.getByRole('dialog', { name: 'Sign in with ChatGPT' })
  await expect(signIn.getByText('Not signed in')).toBeVisible()
  return signIn
}

test('ChatGPT Plan: sign in, wait, cancel, sign in again, pick a model, finish', async () => {
  const { app, page } = await launch()
  try {
    const signIn = await toPlanSignIn(page)
    await e2e(page, (api) => {
      api.setLoginPending(true)
    })
    const button = signIn.getByRole('button', { name: 'Sign in with ChatGPT' })
    await expect(button).toHaveAttribute('data-sign-in', 'chatgpt')
    await button.click()
    await expect(
      signIn.getByText('Waiting for you to finish signing in to ChatGPT in your browser…'),
    ).toBeVisible()
    await expect(button).toBeDisabled()
    await signIn.getByRole('button', { name: 'Cancel sign-in' }).click()
    await expect(signIn.getByRole('alert')).toHaveText('Sign-in cancelled.')
    await expect(signIn.getByRole('button', { name: 'Cancel sign-in' })).toHaveCount(0)

    await button.click()
    await expect(signIn.getByRole('button', { name: 'Cancel sign-in' })).toBeVisible()
    await e2e(page, (api) => {
      api.finishLogin()
    })
    await expect(signIn.getByText('Connected')).toBeVisible()
    await signIn.getByRole('button', { name: 'Continue' }).click()

    const model = page.getByRole('dialog', { name: 'Pick a model' })
    await model.getByRole('radio', { name: /GPT-6.1 Sol/ }).check()
    await model.getByRole('button', { name: 'Continue' }).click()
    await page
      .getByRole('dialog', { name: 'Choose a folder to work in' })
      .getByRole('button', { name: 'Continue' })
      .click()
    const done = page.getByRole('dialog', { name: 'You’re all set' })
    await expect(done.getByRole('status')).toHaveText(
      'You’re set up with ChatGPT · Plan · GPT-6.1 Sol.',
    )
    expect(await e2e(page, (api) => api.loginLog())).toEqual({
      login: ['chatgpt-plan', 'chatgpt-plan'],
      cancel: 1,
    })
    await done.getByRole('button', { name: 'Start chatting' }).click()
    await expect(page.getByRole('combobox', { name: 'Active provider' })).toHaveValue(
      'chatgpt-plan',
    )
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  } finally {
    await app.close()
  }
})

test('ChatGPT Plan: closing while it waits cancels the sign-in and puts chats back', async () => {
  const { app, page } = await launch()
  try {
    const signIn = await toPlanSignIn(page)
    await e2e(page, (api) => {
      api.setLoginPending(true)
    })
    await signIn.getByRole('button', { name: 'Sign in with ChatGPT' }).click()
    await expect(signIn.getByRole('button', { name: 'Cancel sign-in' })).toBeVisible()
    await signIn.getByRole('button', { name: 'Close' }).click()
    await expect(page.getByRole('dialog', { name: 'Sign in with ChatGPT' })).toHaveCount(0)
    await expect
      .poll(() => e2e(page, (api) => api.connectionCalls().remove))
      .toContain('chatgpt-plan')
    const calls = await e2e(page, (api) => api.connectionCalls())
    expect(calls.set).toEqual(['chatgpt-plan', 'anthropic-api'])
    expect((await e2e(page, (api) => api.loginLog())).cancel).toBeGreaterThan(0)
  } finally {
    await app.close()
  }
})
