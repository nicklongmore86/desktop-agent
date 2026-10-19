import { _electron as electron, expect, test, type Page } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { ApprovalPrompt, HistoryState } from '../src/shared/ipc'
import type { LayoutPrefs } from '../src/shared/ipc-layout'

/**
 * The two-pane shell in real Electron: collapsing and resizing the sidebars at desktop
 * width, the drawers at phone width, in light and dark. Screenshots (shell-*) go to
 * e2e-artifacts/ui/ for design review.
 */

const OUT = join(__dirname, '../e2e-artifacts/ui')

interface E2eWindow {
  e2e: {
    setHistory: (history: HistoryState) => void
    pushApproval: (prompt: ApprovalPrompt) => void
    layoutSaves: () => LayoutPrefs[]
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

const width = (page: Page, selector: string): Promise<number> =>
  page.evaluate(
    (query) => document.querySelector(query)?.getBoundingClientRect().width ?? -1,
    selector,
  )

for (const viewport of [1280, 400]) {
  for (const scheme of ['light', 'dark'] as const) {
    test(`app shell at ${String(viewport)}px, ${scheme}`, async () => {
      mkdirSync(OUT, { recursive: true })
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
          await page.screenshot({ path: join(OUT, `${name}-${scheme}-${String(viewport)}.png`) })
        }
        const noSidewaysScroll = (): Promise<boolean> =>
          page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
        const leftToggle = page.getByRole('button', { name: 'Chats sidebar' })
        const rightToggle = page.getByRole('button', { name: 'Workspace panel' })

        if (viewport > 540) {
          const left = page.getByRole('complementary', { name: 'Conversations' })
          const right = page.getByRole('complementary', { name: 'Workspace' })
          await expect(left).toBeVisible()
          await expect(right).toBeVisible()
          await expect(right.getByRole('heading', { name: 'Folder access' })).toBeVisible()
          // One Settings entry: the sidebar gear, not the header.
          await expect(page.getByRole('button', { name: 'Settings' })).toHaveCount(1)
          await expect(left.getByRole('button', { name: 'Settings' })).toBeVisible()
          await expect.poll(() => width(page, '.shell-pane-left')).toBe(272)
          await expect.poll(() => width(page, '.shell-pane-right')).toBe(320)
          expect(await noSidewaysScroll()).toBe(true)
          await shot('shell')

          // Collapse with the buttons, then expand with the shortcuts.
          await leftToggle.click()
          await expect(left).toBeHidden()
          await rightToggle.click()
          await expect(right).toBeHidden()
          await expect(leftToggle).toHaveAttribute('aria-expanded', 'false')
          // The gear stays in reach, on the rail where the left pane was.
          await expect(page.getByRole('button', { name: 'Settings' })).toBeVisible()
          await expect(
            page.locator('.shell-rail').getByRole('button', { name: 'Settings' }),
          ).toBeVisible()
          expect(await noSidewaysScroll()).toBe(true)
          await shot('shell-collapsed')
          await page.keyboard.press('Control+Alt+BracketLeft')
          await expect(left).toBeVisible()
          await page.keyboard.press('Control+Alt+BracketRight')
          await expect(right).toBeVisible()
          // Reduced motion: the pane's transition is effectively instant (0.01ms).
          const seconds = await page.evaluate(() =>
            parseFloat(
              getComputedStyle(document.querySelector('.shell-pane-left') as Element)
                .transitionDuration,
            ),
          )
          expect(seconds).toBeLessThanOrEqual(0.001)

          // Resize with the keyboard: arrows step 16px, End goes to the limit.
          const bar = page.getByRole('separator', { name: 'Resize chats sidebar' })
          await bar.focus()
          await page.keyboard.press('ArrowRight')
          await expect.poll(() => width(page, '.shell-pane-left')).toBe(288)
          await page.keyboard.press('End')
          await expect.poll(() => width(page, '.shell-pane-left')).toBe(512)
          // The chat column never drops under 400px, whatever the panes ask for.
          const rbar = page.getByRole('separator', { name: 'Resize workspace panel' })
          await rbar.focus()
          await page.keyboard.press('End')
          await expect.poll(() => width(page, '.workspace-main')).toBeGreaterThanOrEqual(400)
          await page.keyboard.press('Home')
          await expect.poll(() => width(page, '.shell-pane-right')).toBe(240)

          // Resize with the mouse: drag the left handle 50px to the left.
          await bar.focus()
          await page.keyboard.press('Home')
          await expect.poll(() => width(page, '.shell-pane-left')).toBe(220)
          const box = await bar.boundingBox()
          expect(box).not.toBeNull()
          if (box) {
            const x = box.x + box.width / 2
            const y = box.y + box.height / 2
            await page.mouse.move(x, y)
            await page.mouse.down()
            await page.mouse.move(x + 60, y, { steps: 4 })
            await page.mouse.up()
          }
          await expect.poll(() => width(page, '.shell-pane-left')).toBe(280)

          // The layout is saved (debounced) with numbers and a tab, never a path. A slow run
          // can save an earlier step first, so wait for the save of the final layout.
          const layoutSaves = (): Promise<LayoutPrefs[]> =>
            page.evaluate(() => (window as unknown as E2eWindow).e2e.layoutSaves())
          await expect
            .poll(async () => (await layoutSaves()).at(-1))
            .toMatchObject({
              version: 1,
              leftOpen: true,
              rightOpen: true,
              leftWidth: 280,
            })
          expect(JSON.stringify(await layoutSaves())).not.toContain('Projects')

          // Tabs: Git is an empty host.
          await right.getByRole('tab', { name: 'Git' }).click()
          await expect(right.getByRole('tabpanel', { name: 'Git' })).toBeVisible()
          await shot('shell-git')
        } else {
          // Phone width: no docked pane; each opens as a drawer.
          await expect(page.getByRole('complementary')).toHaveCount(0)
          expect(await noSidewaysScroll()).toBe(true)
          await shot('shell')

          await leftToggle.click()
          const chats = page.getByRole('dialog', { name: 'Chats' })
          await expect(chats).toBeVisible()
          await expect(chats).toBeFocused()
          expect(await noSidewaysScroll()).toBe(true)
          // A strip of the chat stays visible beside the drawer.
          const drawer = await chats.boundingBox()
          expect(drawer && drawer.width <= viewport - 56 + 1).toBe(true)
          // The Settings gear is in the drawer, and the header has no second Settings button.
          await expect(chats.getByRole('button', { name: 'Settings' })).toBeVisible()
          await expect(
            page
              .getByRole('navigation', { name: 'Header' })
              .getByRole('button', { name: 'Settings' }),
          ).toHaveCount(0)
          await shot('shell-left-drawer')
          await page.keyboard.press('Escape')
          await expect(chats).toBeHidden()
          await expect(leftToggle).toBeFocused()

          await rightToggle.click()
          const workspace = page.getByRole('dialog', { name: 'Workspace' })
          await expect(workspace).toBeVisible()
          await expect(workspace.getByRole('heading', { name: 'Folder access' })).toBeVisible()
          expect(await noSidewaysScroll()).toBe(true)
          await shot('shell-right-drawer')

          // An approval wins focus over the open drawer, and Escape denies it.
          await page.evaluate(() => {
            ;(window as unknown as E2eWindow).e2e.pushApproval({
              id: 'shell-approval',
              runId: 'run',
              toolUseId: null,
              tool: 'write_file',
              kind: 'write',
              summary: 'Write notes.md',
              detail: 'A small change',
            })
          })
          await expect(page.getByRole('alertdialog')).toBeVisible()
          await expect(page.getByRole('button', { name: 'Deny', exact: true })).toBeFocused()
          await expect(workspace).toBeHidden()
          await page.keyboard.press('Escape')
          await expect(page.getByRole('alertdialog')).toHaveCount(0)
          await expect(workspace).toBeVisible()
          await expect(workspace).toBeFocused()
          await page.keyboard.press('Escape')
          await expect(workspace).toBeHidden()
          await expect(rightToggle).toBeFocused()
        }
        expect(await noSidewaysScroll()).toBe(true)
      } finally {
        await app.close()
      }
    })
  }
}
