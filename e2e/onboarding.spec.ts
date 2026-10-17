import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Locator,
  type Page,
} from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { ApprovalPrompt, ProviderStatus } from '../src/shared/ipc'

/**
 * The Add connection wizard in a real Electron window (fake main, real renderer):
 * the first-run flow, the same flow from the composer picker and Settings, the
 * combinations that do not work, and the personal-use toggle. It also saves
 * screenshots of every step at 360px and 1280px, light and dark.
 */

const SHOTS =
  process.env['ONBOARDING_SHOTS_DIR'] ?? join(__dirname, '../.polly/ui-v2-shots/onboarding')

interface E2eWindow {
  e2e: {
    pushApproval: (prompt: ApprovalPrompt) => void
    setLoginSucceeds: (next: boolean) => void
    setLocalRunning: (running: boolean) => void
    setStatus: (id: string, status: ProviderStatus) => void
    connectionCalls: () => { add: string[]; remove: string[]; status: string[]; set: string[] }
    keyCalls: () => string[]
  }
}

async function launch(
  width: number,
  scenario: 'first-run' | 'set-up',
): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({
    args: [
      ...(process.platform === 'linux' ? ['--no-sandbox'] : []),
      join(__dirname, 'harness/main.cjs'),
    ],
    cwd: join(__dirname, '..'),
    env: {
      ...process.env,
      E2E_WIDTH: String(width),
      E2E_HEIGHT: '800',
      E2E_SCENARIO: scenario,
    },
  })
  const page = await app.firstWindow()
  await page.emulateMedia({ reducedMotion: 'reduce' })
  return { app, page }
}

const wizardOf = (page: Page, name: string | RegExp): Locator => page.getByRole('dialog', { name })

const noSidewaysScroll = (page: Page): Promise<boolean> =>
  page.evaluate(
    () =>
      document.documentElement.scrollWidth <= window.innerWidth &&
      [...document.querySelectorAll<HTMLElement>('.wizard')].every(
        (element) => element.scrollWidth <= element.clientWidth,
      ),
  )

/**
 * Where a key the user typed shows up: any field's value, any rendered text, any attribute.
 * A refused key may still sit in the field being typed in, so that case leaves values out.
 */
const keyShownAnywhere = (page: Page, secret: string, includingFields: boolean): Promise<boolean> =>
  page.evaluate(
    ([key, fields]) => {
      const needle = key ?? ''
      const withFields = fields === 'yes'
      const inFields =
        withFields &&
        [
          ...document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input, textarea'),
        ].some((field) => field.value.includes(needle))
      // Every attribute (title, aria-*, data-*, ...). React mirrors a field's value into its own
      // value attribute, so that one is left out unless the field is meant to be gone.
      const inAttributes = [...document.querySelectorAll('*')].some((element) =>
        [...element.attributes].some(
          (attribute) =>
            attribute.value.includes(needle) &&
            (withFields ||
              !(
                attribute.name === 'value' &&
                (element.tagName === 'INPUT' || element.tagName === 'TEXTAREA')
              )),
        ),
      )
      return (
        inFields ||
        inAttributes ||
        document.body.innerText.includes(needle) ||
        document.body.textContent.includes(needle) ||
        (withFields && document.documentElement.outerHTML.includes(needle))
      )
    },
    [secret, includingFields ? 'yes' : 'no'],
  )

const e2e = <T>(page: Page, run: (api: E2eWindow['e2e']) => T): Promise<T> =>
  page.evaluate<T>(`(${run.toString()})(window.e2e)`)

test('first run, subscription: sign in, skip the model list, grant a folder, finish', async () => {
  const { app, page } = await launch(1280, 'first-run')
  try {
    // Nothing is set up, so the wizard opens by itself.
    const first = wizardOf(page, 'Which AI do you want to use?')
    await expect(first).toBeVisible()
    await expect(first.getByRole('heading', { level: 2 })).toBeFocused()
    await first.getByRole('button', { name: /^Claude/ }).click()

    const access = wizardOf(page, 'How do you want to use Claude?')
    await expect(access.getByText('Uses your plan’s limits. No API charges.')).toBeVisible()
    await access.getByRole('button', { name: 'Continue' }).click()

    await e2e(page, (api) => {
      api.setLoginSucceeds(true)
    })
    const signIn = wizardOf(page, 'Sign in to Claude')
    await signIn.getByRole('button', { name: 'Sign in' }).click()
    await expect(signIn.getByText('Connected')).toBeVisible()
    await signIn.getByRole('button', { name: 'Continue' }).click()

    const model = wizardOf(page, 'Pick a model')
    await expect(model.getByText(/chooses the model for you/)).toBeVisible()
    await model.getByRole('button', { name: 'Continue' }).click()

    const folder = wizardOf(page, 'Choose a folder to work in')
    await folder.getByRole('button', { name: 'Choose a folder…' }).click()
    await expect(folder.getByText('C:\\Users\\me\\Projects')).toBeVisible()
    await folder.getByRole('button', { name: 'Continue' }).click()

    const done = wizardOf(page, 'You’re all set')
    await expect(done.getByRole('status')).toHaveText(
      'You’re set up with Claude · Subscription · the default model.',
    )
    await done.getByRole('button', { name: 'Start chatting' }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(page.getByRole('combobox', { name: 'Active provider' })).toHaveValue(
      'claude-subscription',
    )
  } finally {
    await app.close()
  }
})

test('API key: main’s refusal is shown, then a saved key never appears again', async () => {
  const { app, page } = await launch(1280, 'first-run')
  try {
    await wizardOf(page, 'Which AI do you want to use?')
      .getByRole('button', { name: /^Gemini/ })
      .click()
    const access = wizardOf(page, 'How do you want to use Gemini?')
    // API key is the only segment that works, so it is chosen already.
    await expect(access.getByRole('radio', { name: /API key/ })).toBeChecked()
    await access.getByRole('button', { name: 'Continue' }).click()

    const key = wizardOf(page, 'Add your Gemini API key')
    await expect(key.getByRole('note')).toContainText(
      'Free Gemini API keys share your data with Google',
    )
    await expect(key.getByRole('link', { name: 'Get a key' })).toHaveAttribute(
      'href',
      'https://aistudio.google.com/app/apikey',
    )
    const field = key.getByLabel('Gemini API key')
    await expect(field).toHaveAttribute('type', 'password')
    await field.fill('bad-key')
    await key.getByRole('button', { name: 'Save key' }).click()
    await expect(key.getByRole('alert')).toHaveText(
      'Gemini rejected the API key. Update it in settings.',
    )
    expect(await keyShownAnywhere(page, 'bad-key', false)).toBe(false)

    await field.fill('AIza-a-good-key')
    await key.getByRole('button', { name: 'Save key' }).click()
    await expect(
      key.getByText('Key saved and encrypted by Windows. It can’t be viewed again.').first(),
    ).toBeVisible()
    await expect(key.getByLabel('Gemini API key')).toHaveCount(0)
    expect(await keyShownAnywhere(page, 'AIza-a-good-key', true)).toBe(false)
    expect(await keyShownAnywhere(page, 'bad-key', true)).toBe(false)
    expect(await e2e(page, (api) => api.keyCalls())).toEqual(['gemini-api', 'gemini-api'])
    await key.getByRole('button', { name: 'Continue' }).click()
    await wizardOf(page, 'Pick a model').getByRole('button', { name: 'Continue' }).click()
    await wizardOf(page, 'Choose a folder to work in')
      .getByRole('button', { name: 'Skip for now' })
      .click()
    await expect(wizardOf(page, 'You’re all set').getByRole('status')).toContainText('Gemini · API')
  } finally {
    await app.close()
  }
})

test('local models: not running, then Check again finds it', async () => {
  const { app, page } = await launch(1280, 'first-run')
  try {
    await wizardOf(page, 'Which AI do you want to use?')
      .getByRole('button', { name: /^Local models/ })
      .click()
    const access = wizardOf(page, 'How do you want to use Local models?')
    await expect(access.getByRole('radio')).toHaveCount(1)
    await expect(access.getByText('Runs on this PC. No account needed.')).toBeVisible()
    await access.getByRole('button', { name: 'Continue' }).click()
    await wizardOf(page, 'Which one do you use?')
      .getByRole('button', { name: /^Ollama/ })
      .click()

    const find = wizardOf(page, 'Find Ollama')
    await expect(find.getByText(/Ollama is not running/)).toBeVisible()
    await expect(find.getByRole('button', { name: 'Continue' })).toHaveCount(0)
    await e2e(page, (api) => {
      api.setLocalRunning(true)
    })
    await find.getByRole('button', { name: 'Check again' }).click()
    await expect(find.getByText('Connected')).toBeVisible()
    await find.getByRole('button', { name: 'Continue' }).click()

    const model = wizardOf(page, 'Pick a model')
    await expect(
      model.getByText('Smaller local models may not use file tools reliably.'),
    ).toBeVisible()
    await expect(model.getByRole('radio', { name: /qwen3:8b/ })).toBeChecked()
  } finally {
    await app.close()
  }
})

test('local models: a custom address on another machine is refused with a reason', async () => {
  const { app, page } = await launch(1280, 'first-run')
  try {
    await wizardOf(page, 'Which AI do you want to use?')
      .getByRole('button', { name: /^Local models/ })
      .click()
    await wizardOf(page, 'How do you want to use Local models?')
      .getByRole('button', { name: 'Continue' })
      .click()
    await wizardOf(page, 'Which one do you use?')
      .getByRole('button', { name: /^Ollama/ })
      .click()
    const find = wizardOf(page, 'Find Ollama')
    await find.getByText('Advanced').click()
    const address = find.getByRole('textbox', { name: 'Server address' })
    await address.fill('http://192.168.1.20:11434/v1')
    await find.getByRole('button', { name: 'Save address' }).click()
    await expect(find.getByRole('alert')).toContainText('Only an address on this PC')
    await expect(find.getByRole('button', { name: 'Use the usual address' })).toHaveCount(0)

    // An address on this PC is kept, and the server is looked for again.
    await e2e(page, (api) => {
      api.setLocalRunning(true)
    })
    await address.fill('http://localhost:9999/v1')
    await find.getByRole('button', { name: 'Save address' }).click()
    await expect(find.getByText('Connected')).toBeVisible()
    await expect(find.getByRole('button', { name: 'Use the usual address' })).toBeVisible()
  } finally {
    await app.close()
  }
})

test('combinations that do not work stay visible, disabled, with the reason', async () => {
  const { app, page } = await launch(1280, 'first-run')
  try {
    const first = wizardOf(page, 'Which AI do you want to use?')
    await first.getByRole('button', { name: /^Claude/ }).click()
    let access = wizardOf(page, 'How do you want to use Claude?')
    const free = access.getByRole('radio', { name: /Free/ })
    await expect(free).toBeDisabled()
    // aria-disabled, not disabled: it stays focusable so its reason can be read.
    await free.click({ force: true })
    await expect(access.getByText(/Claude Free doesn’t include Claude Code/)).toBeVisible()
    await expect(access.getByRole('button', { name: 'Continue' })).toBeDisabled()
    await access.getByRole('button', { name: 'Use an Anthropic API key' }).click()
    await expect(access.getByRole('radio', { name: /API key/ })).toBeChecked()
    await access.getByRole('button', { name: 'Back' }).click()

    await first.getByRole('button', { name: /^Gemini/ }).click()
    access = wizardOf(page, 'How do you want to use Gemini?')
    const reason =
      'Google doesn’t allow other apps to use your Google sign-in for Gemini. Use a free Gemini API key from Google AI Studio instead.'
    for (const name of [/Free/, /Subscription/]) {
      const segment = access.getByRole('radio', { name })
      await expect(segment).toBeDisabled()
      await segment.click({ force: true })
      await expect(access.getByText(reason)).toBeVisible()
    }
    await access.getByRole('button', { name: 'Use a Gemini API key' }).click()
    await expect(access.getByRole('radio', { name: /API key/ })).toBeChecked()
    await expect(access.getByRole('button', { name: 'Continue' })).toBeEnabled()
    // Back with Esc, then out with Esc.
    await page.keyboard.press('Escape')
    await expect(first).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog')).toHaveCount(0)
  } finally {
    await app.close()
  }
})

test('the composer picker ends with Add or manage connections…', async () => {
  const { app, page } = await launch(1280, 'set-up')
  try {
    const picker = page.getByRole('combobox', { name: 'Active provider' })
    await expect(picker.locator('option').last()).toHaveText('Add or manage connections…')
    await picker.selectOption({ label: 'Add or manage connections…' })
    const wizard = wizardOf(page, 'Which AI do you want to use?')
    await expect(wizard).toBeVisible()
    // Esc closes the flow, keeps the choice and returns focus to the picker.
    await page.keyboard.press('Escape')
    await expect(wizard).toHaveCount(0)
    await expect(picker).toHaveValue('anthropic-api')
    expect(await e2e(page, (api) => api.connectionCalls().set)).toEqual([])
  } finally {
    await app.close()
  }
})

test('Settings lists the connections, adds one, and turns personal-use ones off', async () => {
  const { app, page } = await launch(1280, 'set-up')
  try {
    await page.getByRole('button', { name: 'Preferences', exact: true }).click()
    const cards = page.getByRole('list', { name: 'Connections' })
    await expect(cards.getByRole('heading', { level: 4 })).toHaveText([
      'Claude · Subscription',
      'Codex · ChatGPT',
      'Anthropic API',
    ])
    await expect(page.getByText(/Anthropic’s terms require approval/)).toBeVisible()

    // Add connection opens the same wizard on top of Settings.
    await page.getByRole('button', { name: 'Add connection' }).click()
    const wizard = wizardOf(page, 'Which AI do you want to use?')
    await expect(wizard).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible()

    const toggle = page.getByRole('checkbox', { name: 'Show personal-use connections' })
    await toggle.uncheck()
    await expect(cards.getByRole('heading', { name: 'Claude · Subscription' })).toHaveCount(0)
    await toggle.check()
    await expect(cards.getByRole('heading', { name: 'Claude · Subscription' })).toBeVisible()

    // Removing asks first; the connection in use cannot be removed.
    await expect(page.getByRole('button', { name: 'Remove Anthropic API' })).toBeDisabled()
    await page.getByRole('button', { name: 'Remove Codex · ChatGPT' }).click()
    const confirm = page.getByRole('alertdialog')
    await expect(confirm).toContainText('Your chat history for it stays on this PC')
    await confirm.getByRole('button', { name: 'Cancel' }).click()
    await expect(cards.getByRole('heading', { name: 'Codex · ChatGPT' })).toBeVisible()
    await page.getByRole('button', { name: 'Remove Codex · ChatGPT' }).click()
    await confirm.getByRole('button', { name: 'Remove connection' }).click()
    await expect(cards.getByRole('heading', { name: 'Codex · ChatGPT' })).toHaveCount(0)
    expect(await e2e(page, (api) => api.connectionCalls().remove)).toEqual(['codex-subscription'])
  } finally {
    await app.close()
  }
})

test('an approval comes before the wizard, and Esc answers it first', async () => {
  const { app, page } = await launch(1280, 'first-run')
  try {
    const wizard = wizardOf(page, 'Which AI do you want to use?')
    await expect(wizard).toBeVisible()
    await page.evaluate(() => {
      ;(window as unknown as E2eWindow).e2e.pushApproval({
        id: 'wizard-approval',
        runId: 'run',
        toolUseId: null,
        tool: 'write_file',
        kind: 'write',
        summary: 'Write notes.md',
        detail: 'A small change',
      })
    })
    await expect(page.getByRole('alertdialog')).toBeVisible()
    await expect(wizard).toBeHidden()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('alertdialog')).toHaveCount(0)
    await expect(wizard).toBeVisible()
  } finally {
    await app.close()
  }
})

for (const width of [1280, 360]) {
  for (const scheme of ['light', 'dark'] as const) {
    test(`screenshots at ${String(width)}px, ${scheme}`, async () => {
      mkdirSync(SHOTS, { recursive: true })
      const { app, page } = await launch(width, 'first-run')
      const shot = async (name: string): Promise<void> => {
        // Two frames let a media-query change repaint before the capture.
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
        expect(await noSidewaysScroll(page)).toBe(true)
        await page.screenshot({ path: join(SHOTS, `${name}-${scheme}-${String(width)}.png`) })
      }
      try {
        await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' })
        const first = wizardOf(page, 'Which AI do you want to use?')
        await expect(first).toBeVisible()
        await shot('1-provider')

        await first.getByRole('button', { name: /^Gemini/ }).click()
        const access = wizardOf(page, 'How do you want to use Gemini?')
        await access.getByRole('radio', { name: /Subscription/ }).click({ force: true })
        await shot('2-access-unavailable')
        await access.getByRole('button', { name: 'Use a Gemini API key' }).click()
        await access.getByRole('button', { name: 'Continue' }).click()

        const key = wizardOf(page, 'Add your Gemini API key')
        await key.getByLabel('Gemini API key').fill('AIza-screenshot-key')
        await shot('3-connect-key')
        await key.getByRole('button', { name: 'Save key' }).click()
        await expect(key.getByRole('button', { name: 'Continue' })).toBeVisible()
        await shot('4-connect-key-saved')
        await key.getByRole('button', { name: 'Back' }).click()
        await access.getByRole('button', { name: 'Back' }).click()

        await first.getByRole('button', { name: /^Local models/ }).click()
        await wizardOf(page, 'How do you want to use Local models?')
          .getByRole('button', { name: 'Continue' })
          .click()
        await wizardOf(page, 'Which one do you use?')
          .getByRole('button', { name: /^Ollama/ })
          .click()
        const find = wizardOf(page, 'Find Ollama')
        await expect(find.getByText(/not running/)).toBeVisible()
        await shot('5-connect-local-not-running')
        await e2e(page, (api) => {
          api.setLocalRunning(true)
        })
        await find.getByRole('button', { name: 'Check again' }).click()
        await find.getByRole('button', { name: 'Continue' }).click()
        await expect(wizardOf(page, 'Pick a model').getByRole('radio').first()).toBeVisible()
        await shot('6-model')
        await wizardOf(page, 'Pick a model').getByRole('button', { name: 'Continue' }).click()
        await shot('7-folder')
        await wizardOf(page, 'Choose a folder to work in')
          .getByRole('button', { name: 'Choose a folder…' })
          .click()
        await wizardOf(page, 'Choose a folder to work in')
          .getByRole('button', { name: 'Continue' })
          .click()
        await shot('8-done')
        await wizardOf(page, 'You’re all set')
          .getByRole('button', { name: 'Start chatting' })
          .click()

        await page.getByRole('button', { name: 'Preferences', exact: true }).click()
        await expect(page.getByRole('list', { name: 'Connections' })).toBeVisible()
        await shot('9-settings-accounts')
      } finally {
        await app.close()
      }
    })
  }
}
