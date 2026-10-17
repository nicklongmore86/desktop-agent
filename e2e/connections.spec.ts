import { _electron as electron, expect, test } from '@playwright/test'
import { join } from 'node:path'

test('Settings lists the new connections and saves a key per connection', async () => {
  const app = await electron.launch({
    args: [
      ...(process.platform === 'linux' ? ['--no-sandbox'] : []),
      join(__dirname, 'harness/main.cjs'),
    ],
    cwd: join(__dirname, '..'),
    env: { ...process.env, E2E_WIDTH: '1280', E2E_HEIGHT: '800' },
  })
  try {
    const page = await app.firstWindow()
    await page.getByRole('button', { name: 'Preferences', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Settings' })
    const cards = dialog.getByRole('radiogroup', { name: 'Access provider' })
    for (const title of ['OpenAI API', 'Gemini API', 'OpenRouter API', 'Ollama', 'LM Studio'])
      await expect(cards.getByText(title, { exact: true })).toBeVisible()
    // Listing them switches nobody: the Anthropic key section is still the one shown.
    await expect(dialog.getByRole('heading', { name: 'Anthropic API key' })).toBeVisible()

    await cards.getByRole('radio', { name: /OpenAI API/ }).check()
    await expect(dialog.getByRole('heading', { name: 'OpenAI API key' })).toBeVisible()
    await expect(dialog.getByText('No key saved.')).toBeVisible()
    const input = dialog.getByLabel('API key', { exact: true })
    await input.fill('bad-key')
    await dialog.getByRole('button', { name: 'Save key' }).click()
    await expect(dialog.getByRole('alert')).toHaveText(
      'OpenAI rejected the API key. Update it in settings.',
    )
    await expect(dialog.getByText('No key saved.')).toBeVisible()
    await input.fill('sk-good')
    await dialog.getByRole('button', { name: 'Save key' }).click()
    await expect(dialog.getByText('Key saved.')).toBeVisible()
    expect(
      await page.evaluate(() =>
        (window as unknown as { e2e: { keyCalls: () => string[] } }).e2e.keyCalls(),
      ),
    ).toEqual(['openai-api', 'openai-api'])

    await cards.getByRole('radio', { name: /Gemini API/ }).check()
    await expect(dialog.getByRole('heading', { name: 'Gemini API key' })).toBeVisible()
    await expect(dialog.getByText(/Free Gemini API keys share your data with Google/)).toBeVisible()

    await cards.getByRole('radio', { name: /Ollama/ }).check()
    // A local server needs no key.
    await expect(dialog.getByRole('heading', { name: 'Gemini API key' })).toHaveCount(0)
    await expect(input).toHaveCount(0)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  } finally {
    await app.close()
  }
})
