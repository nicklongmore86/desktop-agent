import { _electron as electron, expect, test, type Page } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { HistoryState } from '../src/shared/ipc'

/**
 * The chat history list in real Electron: the sidebar at desktop width, the
 * header drawer at phone width, rename and the delete confirmation, in light
 * and dark. Screenshots go to e2e-artifacts/ui/ for design review.
 */

const OUT = join(__dirname, '../e2e-artifacts/ui')

interface E2eWindow {
  e2e: {
    setHistory: (history: HistoryState) => void
    historyCalls: () => { open: string[]; rename: [string, string][]; remove: string[] }
  }
}

const DAY = 24 * 60 * 60 * 1000
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const D = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const E = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'

function sample(now: number): HistoryState {
  const entry = (id: string, title: string, age: number) => ({
    id,
    title,
    createdAt: now - age,
    updatedAt: now - age,
  })
  return {
    activeId: A,
    conversations: [
      entry(A, 'Summarise the RFI responses in Downloads', 0),
      entry(B, 'Draft a reply to the landlord about the boiler service visit next week', 60_000),
      entry(C, 'ملخص الاجتماع', 2 * DAY),
      entry(D, 'Rename the holiday photos by date', 5 * DAY),
      entry(E, 'Budget spreadsheet formulas', 40 * DAY),
    ],
  }
}

const settle = (page: Page): Promise<void> =>
  page.evaluate(
    () =>
      new Promise<void>((done) => {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            done()
          })
        })
      }),
  )

for (const width of [1280, 400]) {
  for (const scheme of ['light', 'dark'] as const) {
    test(`chat history at ${String(width)}px, ${scheme}`, async () => {
      mkdirSync(OUT, { recursive: true })
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
        await expect(page.getByRole('heading', { name: 'Workspace chat' })).toBeVisible()
        const now = Date.now()
        await page.evaluate((history) => {
          ;(window as unknown as E2eWindow).e2e.setHistory(history)
        }, sample(now))
        const shot = async (name: string): Promise<void> => {
          await settle(page)
          await page.screenshot({ path: join(OUT, `${name}-${scheme}-${String(width)}.png`) })
        }
        const noSidewaysScroll = () =>
          page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)

        let list
        if (width > 540) {
          list = page.getByRole('complementary', { name: 'Conversations' })
        } else {
          await expect(page.getByRole('complementary', { name: 'Conversations' })).toBeHidden()
          await page.getByRole('button', { name: 'Chats sidebar', exact: true }).click()
          list = page.getByRole('dialog', { name: 'Chats' })
        }
        const nav = list.getByRole('navigation', { name: 'Chats' })
        await expect(nav.getByRole('region', { name: 'Today' })).toBeVisible()
        await expect(nav.getByRole('region', { name: 'Previous 7 days' })).toBeVisible()
        await expect(nav.getByRole('region', { name: 'Older' })).toBeVisible()
        const active = nav.getByRole('button', {
          name: 'Summarise the RFI responses in Downloads',
          exact: true,
        })
        await expect(active).toHaveAttribute('aria-current', 'page')
        // Long titles are cut with an ellipsis, inside the list.
        const long = nav.getByRole('button', { name: /^Draft a reply/ })
        const box = await long.boundingBox()
        const navBox = await nav.boundingBox()
        expect(box && navBox && box.x + box.width <= navBox.x + navBox.width + 1).toBe(true)
        expect(await noSidewaysScroll()).toBe(true)
        await shot('history-list')

        // Keyboard: arrow keys move between chats.
        await active.focus()
        await page.keyboard.press('ArrowDown')
        await expect(long).toBeFocused()

        // Rename from the menu.
        await nav
          .getByRole('button', { name: 'Options for Rename the holiday photos by date' })
          .click()
        await expect(page.getByRole('menuitem', { name: 'Pin' })).toBeFocused()
        await page.keyboard.press('ArrowDown')
        await page.keyboard.press('ArrowDown')
        await expect(page.getByRole('menuitem', { name: 'Rename' })).toBeFocused()
        await shot('history-menu')
        await page.keyboard.press('Enter')
        const field = nav.getByRole('textbox', { name: 'Chat name' })
        await expect(field).toBeFocused()
        await field.fill('Holiday photos')
        await shot('history-rename')
        await page.keyboard.press('Enter')
        await expect(nav.getByRole('button', { name: 'Holiday photos', exact: true })).toBeVisible()

        // Delete asks first.
        await nav.getByRole('button', { name: 'Options for Budget spreadsheet formulas' }).click()
        await page.getByRole('menuitem', { name: 'Delete…' }).click()
        const confirm = page.getByRole('alertdialog', { name: 'Delete chat?' })
        await expect(confirm).toBeVisible()
        await expect(confirm.getByRole('button', { name: 'Cancel' })).toBeFocused()
        expect(await noSidewaysScroll()).toBe(true)
        await shot('history-delete-confirm')
        await confirm.getByRole('button', { name: 'Delete', exact: true }).click()
        await expect(confirm).toBeHidden()
        await expect(nav.getByText('Budget spreadsheet formulas')).toHaveCount(0)

        expect(
          await page.evaluate(() => (window as unknown as E2eWindow).e2e.historyCalls()),
        ).toEqual({ open: [], rename: [[D, 'Holiday photos']], remove: [E] })

        // Opening another chat.
        await nav.getByRole('button', { name: 'ملخص الاجتماع', exact: true }).click()
        await expect
          .poll(() => page.evaluate(() => (window as unknown as E2eWindow).e2e.historyCalls().open))
          .toEqual([C])
        if (width <= 540) await expect(page.getByRole('dialog', { name: 'Chats' })).toBeHidden()
      } finally {
        await app.close()
      }
    })
  }
}
