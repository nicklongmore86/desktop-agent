import { _electron as electron, expect, test } from '@playwright/test'
import { join } from 'node:path'

/**
 * The stylesheet's theme switch in real Chromium: System follows the OS colour
 * scheme, and data-theme on <html> overrides it either way.
 */
test('system follows the OS scheme and data-theme overrides it', async () => {
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
    await expect(page.getByRole('heading', { name: 'Workspace chat' })).toBeVisible()
    const background = (): Promise<string> =>
      page.evaluate(() => getComputedStyle(document.body).backgroundColor)
    const force = (theme: string | null): Promise<void> =>
      page.evaluate((value) => {
        if (value) document.documentElement.dataset['theme'] = value
        else delete document.documentElement.dataset['theme']
      }, theme)
    const LIGHT = 'rgb(255, 255, 255)'
    const DARK = 'rgb(23, 23, 23)'

    await page.emulateMedia({ colorScheme: 'light' })
    await force(null)
    expect(await background()).toBe(LIGHT)
    await page.emulateMedia({ colorScheme: 'dark' })
    expect(await background()).toBe(DARK)
    await force('light')
    expect(await background()).toBe(LIGHT)
    await page.emulateMedia({ colorScheme: 'light' })
    await force('dark')
    expect(await background()).toBe(DARK)
    await force(null)
    expect(await background()).toBe(LIGHT)

    // Reduced motion switches transitions off.
    const transition = (): Promise<number> =>
      page.evaluate(() => {
        const button = document.querySelector('button')
        return button ? parseFloat(getComputedStyle(button).transitionDuration) : -1
      })
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    expect(await transition()).toBeCloseTo(0.12)
    await page.emulateMedia({ reducedMotion: 'reduce' })
    expect(await transition()).toBeLessThan(0.001)
  } finally {
    await app.close()
  }
})
