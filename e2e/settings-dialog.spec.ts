import { _electron as electron, expect, test } from '@playwright/test'
import { join } from 'node:path'
import type { ApprovalPrompt } from '../src/shared/ipc'
import { clickSettings } from './open-settings'

for (const width of [1280, 400]) {
  test(`Settings dialog focus, sections and theme at ${String(width)}px`, async () => {
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
      const opener = page.getByRole('button', { name: 'Settings', exact: true })
      await clickSettings(page)
      const dialog = page.getByRole('dialog', { name: 'Settings' })
      await expect(dialog).toBeVisible()
      await expect(dialog).toBeFocused()
      await page.keyboard.press('Tab')
      await expect(page.getByRole('button', { name: 'Close settings' })).toBeFocused()
      await page.keyboard.press('Shift+Tab')
      expect(await dialog.evaluate((el) => el.contains(document.activeElement))).toBe(true)
      await page.keyboard.press('Tab')
      await expect(page.getByRole('button', { name: 'Close settings' })).toBeFocused()
      if (width > 540) await page.getByRole('button', { name: 'Appearance', exact: true }).click()
      await page.getByRole('button', { name: 'Dark', exact: true }).click()
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
      await page.keyboard.press('Escape')
      await expect(dialog).toHaveCount(0)
      await expect(opener).toBeFocused()
      // Opening a targeted section uses the App onOpenSettings contract.
      if (width > 540) {
        await page.getByRole('button', { name: 'Manage folders' }).click()
        await expect(page.getByRole('heading', { name: 'Folders & permissions' })).toBeVisible()
        await expect(page.getByRole('heading', { name: 'Accounts & providers' })).toHaveCount(0)
        await page.getByRole('button', { name: 'Privacy & audit log', exact: true }).click()
      } else await clickSettings(page)
      await page.getByRole('button', { name: 'Show in folder' }).click()
      // Tool approvals take precedence over Settings without changing ApprovalCard.
      await page.evaluate(() => {
        const harness = (
          window as unknown as { e2e: { pushApproval: (prompt: ApprovalPrompt) => void } }
        ).e2e
        harness.pushApproval({
          id: 'settings-approval',
          runId: 'run',
          toolUseId: null,
          tool: 'write_file',
          kind: 'write',
          summary: 'Write notes.md',
          detail: 'A small change',
        })
      })
      await expect(page.getByRole('dialog', { name: 'Settings' })).toHaveCount(0)
      await expect(page.getByRole('alertdialog')).toBeVisible()
      await expect(page.getByRole('button', { name: 'Deny', exact: true })).toBeFocused()
      await page.getByRole('button', { name: 'Deny', exact: true }).click()
      await expect(page.getByRole('alertdialog')).toHaveCount(0)
      await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible()
      await expect(page.getByRole('dialog', { name: 'Settings' })).toBeFocused()

      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      )
      await page.keyboard.press('Escape')
      await expect(
        width > 540 ? page.getByRole('button', { name: 'Manage folders' }) : opener,
      ).toBeFocused()
    } finally {
      await app.close()
    }
  })
}
