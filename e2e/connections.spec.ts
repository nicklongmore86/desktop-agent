import { _electron as electron, expect, test } from '@playwright/test'
import { join } from 'node:path'
import { clickSettings } from './open-settings'

test('Settings adds an API-key connection through the wizard and saves its key by id', async () => {
  const app = await electron.launch({
    args: [
      ...(process.platform === 'linux' ? ['--no-sandbox'] : []),
      join(__dirname, 'harness/main.cjs'),
    ],
    cwd: join(__dirname, '..'),
    env: { ...process.env, E2E_WIDTH: '1280', E2E_HEIGHT: '800', E2E_SCENARIO: 'set-up' },
  })
  try {
    const page = await app.firstWindow()
    await clickSettings(page)
    const settings = page.getByRole('dialog', { name: 'Settings' })
    const cards = settings.getByRole('list', { name: 'Connections' })
    // Listing nothing new switches nobody: the Anthropic key section is still the one shown.
    await expect(settings.getByRole('heading', { name: 'Anthropic API key' })).toBeVisible()
    await expect(cards.getByRole('heading', { name: 'OpenAI API' })).toHaveCount(0)

    await settings.getByRole('button', { name: 'Add connection' }).click()
    await page
      .getByRole('dialog', { name: 'Which AI do you want to use?' })
      .getByRole('button', { name: /^ChatGPT/ })
      .click()
    const access = page.getByRole('dialog', { name: 'How do you want to use ChatGPT?' })
    await access.getByRole('radio', { name: /API key/ }).click()
    await access.getByRole('button', { name: 'Continue' }).click()

    const key = page.getByRole('dialog', { name: 'Add your OpenAI API key' })
    const input = key.getByLabel('OpenAI API key')
    await input.fill('bad-key')
    await key.getByRole('button', { name: 'Save key' }).click()
    await expect(key.getByRole('alert')).toHaveText(
      'OpenAI rejected the API key. Update it in settings.',
    )
    await input.fill('sk-good')
    await key.getByRole('button', { name: 'Save key' }).click()
    await expect(key.getByText(/Key saved and encrypted by Windows/).first()).toBeVisible()
    expect(
      await page.evaluate(() =>
        (window as unknown as { e2e: { keyCalls: () => string[] } }).e2e.keyCalls(),
      ),
    ).toEqual(['openai-api', 'openai-api'])
    // Not in any field's value, rendered text, or attribute.
    expect(
      await page.evaluate(() => {
        const fields = [...document.querySelectorAll<HTMLInputElement>('input, textarea')]
        return (
          fields.some(
            (field) => field.value.includes('sk-good') || field.value.includes('bad-key'),
          ) ||
          document.body.innerText.includes('sk-good') ||
          document.documentElement.outerHTML.includes('sk-good')
        )
      }),
    ).toBe(false)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  } finally {
    await app.close()
  }
})
