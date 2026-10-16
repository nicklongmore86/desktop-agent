import { _electron as electron, expect, test, type Page } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { FileEntry, FileLocation } from '../src/shared/ipc-files'

/**
 * The Workspace panel's Files tree in real Electron: the colour-coded tree, keyboard
 * and context menu, watcher refresh, dragging a reference into the message box and
 * the `@` menu, in light and dark at desktop and phone width. Screenshots (files-*)
 * go to e2e-artifacts/ui/ for design review.
 */

const OUT = join(__dirname, '../e2e-artifacts/ui')
const ROOT = 'C:\\Users\\me\\Projects'

interface E2eWindow {
  e2e: {
    setFolder: (rel: string, entries: FileEntry[]) => void
    filesCalls: () => {
      watch: FileLocation[][]
      reveal: FileLocation[]
      copy: FileLocation[]
      reference: FileLocation[]
      search: string[]
    }
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

const calls = (page: Page) => page.evaluate(() => (window as unknown as E2eWindow).e2e.filesCalls())

for (const viewport of [1280, 400]) {
  for (const scheme of ['light', 'dark'] as const) {
    test(`files tree at ${String(viewport)}px, ${scheme}`, async () => {
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
        const shot = async (name: string): Promise<void> => {
          await settle(page)
          await page.screenshot({ path: join(OUT, `${name}-${scheme}-${String(viewport)}.png`) })
        }
        const noSidewaysScroll = (): Promise<boolean> =>
          page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)

        if (viewport <= 540) await page.getByRole('button', { name: 'Workspace panel' }).click()
        const tree = page.getByRole('tree', { name: 'Files in granted folders' })
        const row = (name: string | RegExp) => tree.getByRole('treeitem', { name })
        await expect(row(/^Projects/)).toHaveAttribute('aria-expanded', 'true')
        await expect(row(/^contract\.pdf/)).toBeVisible()

        // Colour coding: each type has its own token colour and icon.
        const iconColor = (name: RegExp) =>
          row(name)
            .locator('svg')
            .evaluate((svg) => getComputedStyle(svg).color)
        const colors = await Promise.all(
          [/^contract\.pdf/, /^budget-2026\.xlsx/, /^kickoff\.pptx/, /^logo\.png/].map(iconColor),
        )
        expect(new Set(colors).size).toBe(4)

        // Locked entries are listed, greyed and not draggable.
        await expect(row(/^\.env\b.*Blocked/)).toHaveAttribute('draggable', 'false')
        await expect(row(/^secrets\.json.*contents hidden/)).toHaveAttribute('draggable', 'false')
        await expect(row(/^shared-drive.*outside granted folders/)).toBeVisible()

        // Expand src and its components folder with the mouse, then the keyboard.
        await row(/^src\b/).click()
        await expect(row(/^App\.tsx/)).toBeVisible()
        await page.keyboard.press('ArrowDown')
        await page.keyboard.press('ArrowRight')
        await expect(row(/^FileTree\.tsx/)).toBeVisible()
        await expect
          .poll(async () => (await calls(page)).watch.at(-1)?.map((l) => l.rel))
          .toEqual(['', 'src', 'src/components'])
        expect(await noSidewaysScroll()).toBe(true)
        await shot('files')

        // The watcher: a change pushed for an expanded folder shows up.
        await row(/^docs\b/).click()
        await expect(row(/^plan\.docx/)).toBeVisible()
        await page.evaluate(() => {
          ;(window as unknown as E2eWindow).e2e.setFolder('docs', [
            { name: 'brief.md', rel: 'docs/brief.md', kind: 'file' },
            { name: 'minutes.md', rel: 'docs/minutes.md', kind: 'file' },
          ])
        })
        await expect(row(/^minutes\.md/)).toBeVisible()
        await expect(row(/^plan\.docx/)).toHaveCount(0)

        // The context menu, from the keyboard.
        await row(/^contract\.pdf/).click()
        await page.keyboard.press('Shift+F10')
        const menu = page.getByRole('menu', { name: 'Actions for contract.pdf' })
        await expect(menu).toBeVisible()
        await expect(
          menu.getByRole('menuitem', { name: 'Insert reference into chat' }),
        ).toBeFocused()
        if (viewport > 540) await shot('files-menu')
        await page.keyboard.press('ArrowDown')
        await page.keyboard.press('Enter')
        await expect(menu).toBeHidden()
        expect((await calls(page)).copy).toEqual([
          { rootId: expect.any(String) as unknown, rel: 'contract.pdf' },
        ])

        if (viewport > 540) {
          // Drag a file into the message box: a reference is inserted, nothing moves.
          const box = page.getByRole('textbox', { name: 'Message' })
          await row(/^README\.md/).dragTo(box)
          await expect(box).toHaveValue(`@"${ROOT}\\README.md" `)

          // The @ menu.
          await box.press('End')
          await box.pressSequentially('and @brie')
          const list = page.getByRole('listbox', { name: 'Files to reference' })
          await expect(list.getByRole('option', { name: /brief\.md/ })).toBeVisible()
          await shot('files-mention')
          await page.keyboard.press('Enter')
          await expect(box).toHaveValue(`@"${ROOT}\\README.md" and @"${ROOT}\\docs\\brief.md" `)
          await expect(list).toBeHidden()
        } else {
          // Insert into chat from the drawer, then close it to see the message box.
          await row(/^README\.md/).click()
          await page.keyboard.press('Enter')
          await page.keyboard.press('Escape')
          await expect(page.getByRole('textbox', { name: 'Message' })).toHaveValue(
            `@"${ROOT}\\README.md" `,
          )
        }
        expect(await noSidewaysScroll()).toBe(true)
      } finally {
        await app.close()
      }
    })
  }
}
