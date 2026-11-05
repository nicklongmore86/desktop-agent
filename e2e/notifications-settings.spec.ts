import { _electron as electron, expect, test } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { clickSettings } from './open-settings'

/**
 * The Notifications toggle in Settings, at phone and desktop width, light and dark. SHOT_DIR
 * picks where the screenshots go (they are not written without it, so CI only checks the layout).
 */

const OUT = process.env['SHOT_DIR']

for (const width of [360, 1280]) {
  for (const scheme of ['light', 'dark'] as const) {
    test(`Notifications setting at ${String(width)}px, ${scheme}`, async () => {
      if (OUT) mkdirSync(OUT, { recursive: true })
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
        await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' })
        await clickSettings(page)
        const dialog = page.getByRole('dialog', { name: 'Settings' })
        await expect(dialog).toBeVisible()
        if (width > 540)
          await page.getByRole('button', { name: 'Notifications', exact: true }).click()
        const box = page.getByRole('checkbox', { name: 'Notify me when Desktop Agent needs me' })
        await box.scrollIntoViewIfNeeded()
        await expect(box).toBeVisible()
        await expect(box).toBeChecked()
        // No sideways scroll, and the text is not clipped at the narrow width.
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
          true,
        )
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
        if (OUT)
          await page.screenshot({ path: join(OUT, `notifications-${String(width)}-${scheme}.png`) })
        // Off, then on again, through the harness's fake main.
        await box.click()
        await expect(box).not.toBeChecked()
        if (OUT)
          await page.screenshot({
            path: join(OUT, `notifications-${String(width)}-${scheme}-off.png`),
          })
        await box.click()
        await expect(box).toBeChecked()
      } finally {
        await app.close()
      }
    })
  }
}
