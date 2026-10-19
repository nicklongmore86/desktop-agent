import { _electron as electron, expect, test, type Page } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { ApprovalPrompt, HistoryState } from '../src/shared/ipc'

/**
 * Review screenshots for the shell polish (Settings gear, sidebar header, 3-column layout):
 * 360px (phone, drawers), 900px (all three columns at the squeezed minimums), 1280px and
 * 1600px, light and dark. SHOT_DIR / SHOT_PHASE pick where they go and the file prefix
 * ("before" / "after"); without them they are not written, so CI only checks the layout.
 * Only controls that exist in both the old and the new shell are used to reach each state.
 */

const OUT = process.env['SHOT_DIR']
const PHASE = process.env['SHOT_PHASE'] ?? 'after'

interface E2eWindow {
  e2e: {
    setHistory: (history: HistoryState) => void
    pushApproval: (prompt: ApprovalPrompt) => void
  }
}

const DAY = 24 * 60 * 60 * 1000
const ids = [
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
] as const

const sample = (now: number): HistoryState => ({
  activeId: ids[0],
  conversations: [
    ['Summarise the RFI responses in Downloads', 0],
    ['Draft a reply to the landlord about the boiler service visit next week', 60_000],
    ['Rename the holiday photos by date', 5 * DAY],
  ].map(([title, age], index) => ({
    id: ids[index] as string,
    title: title as string,
    createdAt: now - (age as number),
    updatedAt: now - (age as number),
  })),
})

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

const widthOf = (page: Page, selector: string): Promise<number> =>
  page.evaluate(
    (query) => document.querySelector(query)?.getBoundingClientRect().width ?? -1,
    selector,
  )

for (const viewport of [360, 900, 1280, 1600]) {
  for (const scheme of ['light', 'dark'] as const) {
    test(`shell polish at ${String(viewport)}px, ${scheme}`, async () => {
      if (OUT) mkdirSync(OUT, { recursive: true })
      const app = await electron.launch({
        args: [
          ...(process.platform === 'linux' ? ['--no-sandbox'] : []),
          join(__dirname, 'harness/main.cjs'),
        ],
        cwd: join(__dirname, '..'),
        env: { ...process.env, E2E_WIDTH: String(viewport), E2E_HEIGHT: '800' },
      })
      try {
        const page = await app.firstWindow()
        await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' })
        await expect(page.getByRole('heading', { name: 'Workspace chat' })).toBeVisible()
        await page.evaluate((history) => {
          ;(window as unknown as E2eWindow).e2e.setHistory(history)
        }, sample(Date.now()))
        const shot = async (name: string): Promise<void> => {
          await settle(page)
          if (OUT)
            await page.screenshot({
              path: join(OUT, `${PHASE}-${name}-${scheme}-${String(viewport)}.png`),
            })
        }
        const noSidewaysScroll = (): Promise<boolean> =>
          page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)

        await shot('main')
        expect(await noSidewaysScroll()).toBe(true)

        if (viewport > 540) {
          // The chat column, left pane and right pane are usable at once, and the chat
          // is pushed (not overlaid): the three widths add up to the window.
          if (PHASE === 'after') {
            const [l, c, r] = await Promise.all([
              widthOf(page, '.shell-pane-left'),
              widthOf(page, '.workspace-main'),
              widthOf(page, '.shell-pane-right'),
            ])
            expect(c).toBeGreaterThanOrEqual(400)
            expect(l + c + r).toBeLessThanOrEqual(viewport + 2)
            await expect(page.locator('.shell-drawer')).toHaveCount(0)
          }
          await page.getByRole('button', { name: 'Chats sidebar' }).click()
          await shot('left-collapsed')
          await page.getByRole('button', { name: 'Chats sidebar' }).click()
          await page.keyboard.press('Control+,')
          await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible()
          await shot('settings')
        } else {
          await page.getByRole('button', { name: 'Chats sidebar' }).click()
          await expect(page.getByRole('dialog', { name: 'Chats' })).toBeVisible()
          await shot('left-drawer')
          await page.keyboard.press('Escape')
          await page.getByRole('button', { name: 'Workspace panel' }).click()
          await expect(page.getByRole('dialog', { name: 'Workspace' })).toBeVisible()
          await shot('right-drawer')
        }

        // The approval dialog still takes priority and is fully inside the window.
        if (PHASE === 'after') {
          await page.keyboard.press('Escape')
          await page.evaluate(() => {
            ;(window as unknown as E2eWindow).e2e.pushApproval({
              id: 'polish-approval',
              runId: 'run',
              toolUseId: null,
              tool: 'write_file',
              kind: 'write',
              summary: 'Write notes.md',
              detail: 'A small change',
            })
          })
          const approval = page.getByRole('alertdialog')
          await expect(approval).toBeVisible()
          await expect(page.getByRole('button', { name: 'Deny', exact: true })).toBeFocused()
          const box = await approval.boundingBox()
          expect(box).not.toBeNull()
          if (box) {
            expect(box.x).toBeGreaterThanOrEqual(0)
            expect(box.x + box.width).toBeLessThanOrEqual(viewport)
            expect(box.y + box.height).toBeLessThanOrEqual(800)
          }
          await shot('approval')
        }
      } finally {
        await app.close()
      }
    })
  }
}
