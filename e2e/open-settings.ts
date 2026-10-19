import type { Page } from '@playwright/test'

/**
 * Clicks the sidebar's Settings gear. Where the sidebar is a drawer (phone width) it is
 * opened first; the gear is the one Settings button there is, so there is no header route.
 */
export async function clickSettings(page: Page): Promise<void> {
  const gear = page.getByRole('button', { name: 'Settings', exact: true })
  if (!(await gear.isVisible()))
    await page.getByRole('button', { name: 'Chats sidebar', exact: true }).click()
  await gear.click()
}
