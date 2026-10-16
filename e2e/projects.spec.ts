import { _electron as electron, expect, test, type Locator, type Page } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { HistoryState } from '../src/shared/ipc'
import type { Project, ProviderChat } from '../src/shared/ipc-projects'

/**
 * The chat list's projects, pins, archive, fork and drag and drop in real
 * Electron, at desktop width (docked sidebar) and phone width (drawer), light
 * and dark. Screenshots go to e2e-artifacts/ui/ as left-<state>-<scheme>-<width>.png.
 */

const OUT = join(__dirname, '../e2e-artifacts/ui')

interface E2eWindow {
  e2e: {
    setHistory: (history: HistoryState) => void
    setProjects: (projects: Project[], others?: ProviderChat[]) => void
    projectCalls: () => unknown[][]
    historyCalls: () => { open: string[] }
  }
}

const DAY = 24 * 60 * 60 * 1000
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const D = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const E = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
const X = '99999999-9999-4999-8999-999999999999'
const TAXES = '11111111-1111-4111-8111-111111111111'
const GARDEN = '22222222-2222-4222-8222-222222222222'

function sample(now: number): { history: HistoryState; others: ProviderChat[] } {
  const entry = (id: string, title: string, age: number) => ({
    id,
    title,
    createdAt: now - age,
    updatedAt: now - age,
  })
  return {
    history: {
      activeId: A,
      conversations: [
        { ...entry(A, 'Summarise the RFI responses in Downloads', 0), pinnedAt: now - 9 * DAY },
        { ...entry(B, 'Draft a reply to the landlord about the boiler', 60_000) },
        { ...entry(C, 'Reconcile March receipts', DAY), projectId: TAXES },
        { ...entry(D, 'Rename the holiday photos by date', 5 * DAY) },
        { ...entry(E, 'Old budget formulas', 40 * DAY), archivedAt: now - DAY },
      ],
    },
    others: [
      {
        ...entry(X, 'Estimate the 2026 tax bill', 2 * DAY),
        projectId: TAXES,
        provider: 'codex-subscription',
      },
    ],
  }
}

const projects: Project[] = [
  { id: TAXES, name: 'Taxes 2026', icon: '📊' },
  { id: GARDEN, name: 'Garden', icon: null },
]

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

const calls = (page: Page) =>
  page.evaluate(() => (window as unknown as E2eWindow).e2e.projectCalls())

/** Starts a drag of `row` and hovers it over `target`, without dropping. */
async function dragOver(page: Page, row: Locator, target: Locator): Promise<void> {
  const source = await row.elementHandle()
  const over = await target.elementHandle()
  await page.evaluate((from) => {
    from.dispatchEvent(
      new DragEvent('dragstart', { bubbles: true, dataTransfer: new DataTransfer() }),
    )
  }, source)
  await settle(page)
  await page.evaluate((to) => {
    const data = new DataTransfer()
    to.dispatchEvent(new DragEvent('dragenter', { bubbles: true, dataTransfer: data }))
    to.dispatchEvent(
      new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: data }),
    )
  }, over)
  await settle(page)
}

for (const width of [1280, 400]) {
  for (const scheme of ['light', 'dark'] as const) {
    test(`projects, pins and archive at ${String(width)}px, ${scheme}`, async () => {
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
        const data = sample(Date.now())
        await page.evaluate(
          ([history, list, others]) => {
            const e2e = (window as unknown as E2eWindow).e2e
            e2e.setProjects(list, others)
            e2e.setHistory(history)
          },
          [data.history, projects, data.others] as const,
        )
        const shot = async (name: string): Promise<void> => {
          await settle(page)
          await page.screenshot({ path: join(OUT, `left-${name}-${scheme}-${String(width)}.png`) })
        }
        const noSidewaysScroll = () =>
          page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
        const openList = async (): Promise<Locator> => {
          if (width > 540) return page.getByRole('complementary', { name: 'Conversations' })
          const drawer = page.getByRole('dialog', { name: 'Chats' })
          if (!(await drawer.isVisible()))
            await page.getByRole('button', { name: 'Chats sidebar', exact: true }).click()
          return drawer
        }

        let list = await openList()
        const nav = () => list.getByRole('navigation', { name: 'Chats' })
        const pinned = () => nav().getByRole('region', { name: 'Pinned' })
        const projectsRegion = () => nav().getByRole('region', { name: 'Projects' })
        const chats = () => nav().getByRole('region', { name: 'Chats' })
        const chatRow = (title: string) => nav().getByRole('button', { name: title, exact: true })

        // Sections: the pinned chat, a project holding a chat of another provider, the rest.
        await expect(pinned().getByText('Summarise the RFI responses in Downloads')).toBeVisible()
        const taxes = projectsRegion().getByRole('button', { name: 'Taxes 2026', exact: true })
        await expect(taxes).toHaveAttribute('aria-expanded', 'true')
        await expect(projectsRegion().getByText('Reconcile March receipts')).toBeVisible()
        await expect(projectsRegion().getByText('Codex', { exact: true })).toBeVisible()
        await expect(chats().getByText('Old budget formulas')).toHaveCount(0)
        expect(await noSidewaysScroll()).toBe(true)
        await shot('projects')

        // Pin from the menu, by keyboard: Shift+F10 on the row, then Enter on Pin.
        await chatRow('Rename the holiday photos by date').focus()
        await page.keyboard.press('Shift+F10')
        await expect(page.getByRole('menuitem', { name: 'Pin', exact: true })).toBeFocused()
        await page.keyboard.press('Enter')
        await expect(pinned().getByText('Rename the holiday photos by date')).toBeVisible()
        await expect(page.getByRole('status').filter({ hasText: 'Unpinned' })).toHaveCount(0)
        await shot('pinned')

        // Unpin offers Undo.
        await nav()
          .getByRole('button', { name: 'Options for Rename the holiday photos by date' })
          .click()
        await page.getByRole('menuitem', { name: 'Unpin' }).click()
        const undo = page.locator('.undo-toast')
        await expect(undo).toContainText('Unpinned')
        await undo.getByRole('button', { name: 'Undo' }).click()
        await expect(pinned().getByText('Rename the holiday photos by date')).toBeVisible()

        // Move to project from the menu's submenu, by keyboard.
        await nav()
          .getByRole('button', {
            name: 'Options for Draft a reply to the landlord about the boiler',
          })
          .click()
        await page.keyboard.press('ArrowDown')
        await page.keyboard.press('ArrowDown')
        await page.keyboard.press('ArrowDown')
        await expect(page.getByRole('menuitem', { name: 'Move to project' })).toBeFocused()
        await page.keyboard.press('ArrowRight')
        await expect(page.getByRole('menu', { name: 'Move to project' })).toBeVisible()
        await expect(page.getByRole('menuitem', { name: 'Move to project' })).toBeFocused()
        await page.keyboard.press('ArrowDown')
        await page.keyboard.press('ArrowDown')
        await expect(page.getByRole('menuitem', { name: 'Garden' })).toBeFocused()
        expect(await noSidewaysScroll()).toBe(true)
        await shot('menu')
        await page.keyboard.press('Enter')
        const garden = projectsRegion()
          .getByRole('listitem')
          .filter({
            has: page.getByRole('button', { name: 'Garden', exact: true }),
          })
        await expect(
          garden.getByText('Draft a reply to the landlord about the boiler'),
        ).toBeVisible()
        await expect(undo).toContainText('Moved')

        // Drag and drop: a chat onto a project.
        const dragged = nav()
          .locator('.history-item')
          .filter({
            has: page.getByRole('button', {
              name: 'Draft a reply to the landlord about the boiler',
              exact: true,
            }),
          })
        const taxesFolder = projectsRegion()
          .getByRole('listitem')
          .filter({ has: page.getByRole('button', { name: 'Taxes 2026', exact: true }) })
          .first()
        await dragOver(page, dragged, taxesFolder)
        await expect(taxesFolder).toHaveAttribute('data-drop', 'over')
        await expect(pinned().getByText('Drop here to pin')).toHaveCount(0)
        await shot('dragging')
        await page.evaluate(
          (to) => {
            to.dispatchEvent(
              new DragEvent('drop', {
                bubbles: true,
                cancelable: true,
                dataTransfer: new DataTransfer(),
              }),
            )
          },
          await taxesFolder.elementHandle(),
        )
        await expect(
          taxesFolder.getByText('Draft a reply to the landlord about the boiler'),
        ).toBeVisible()
        expect(await calls(page)).toContainEqual([
          'projectId',
          { provider: 'anthropic-api', id: B },
          TAXES,
        ])

        // A real mouse drag: the chat out of its project, onto Chats.
        if (width > 540) {
          await taxesFolder
            .getByRole('button', {
              name: 'Draft a reply to the landlord about the boiler',
              exact: true,
            })
            .dragTo(chats().getByRole('heading', { name: 'Chats' }))
          await expect(
            chats().getByText('Draft a reply to the landlord about the boiler'),
          ).toBeVisible()
        }

        // Archive hides the chat; the Archived filter shows and restores it.
        await nav().getByRole('button', { name: 'Options for Reconcile March receipts' }).click()
        await page.getByRole('menuitem', { name: 'Archive' }).click()
        await expect(nav().getByText('Reconcile March receipts')).toHaveCount(0)
        await expect(undo).toContainText('Archived')
        await list.getByRole('button', { name: /^Archived/ }).click()
        await expect(nav().getByRole('region', { name: 'Archived' })).toBeVisible()
        await expect(nav().getByText('Reconcile March receipts')).toBeVisible()
        await expect(nav().getByText('Old budget formulas')).toBeVisible()
        expect(await noSidewaysScroll()).toBe(true)
        await shot('archived')
        await nav().getByRole('button', { name: 'Options for Reconcile March receipts' }).click()
        await page.getByRole('menuitem', { name: 'Restore' }).click()
        await list.getByRole('button', { name: /^Archived/ }).click()
        await expect(projectsRegion().getByText('Reconcile March receipts')).toBeVisible()

        // New project from the + button.
        await projectsRegion().getByRole('button', { name: 'New project' }).click()
        const create = page.getByRole('dialog', { name: 'New project' })
        await expect(create.getByRole('textbox', { name: 'Name' })).toBeFocused()
        await create.getByRole('textbox', { name: 'Name' }).fill('Trip to Lisbon')
        await create.getByRole('radio', { name: '🚀' }).click()
        await shot('new-project')
        await create.getByRole('button', { name: 'Create project' }).click()
        await expect(
          projectsRegion().getByRole('button', { name: 'Trip to Lisbon', exact: true }),
        ).toBeVisible()

        // Fork: the dialog says what is copied, and the fork opens.
        list = await openList()
        await nav().getByRole('button', { name: 'Options for Reconcile March receipts' }).click()
        await page.getByRole('menuitem', { name: 'Fork…' }).click()
        const fork = page.getByRole('dialog', { name: 'Fork chat' })
        await expect(fork).toContainText('keeps the full conversation')
        await expect(fork).toContainText('Approvals are not copied')
        await expect(fork.getByRole('button', { name: 'Fork' })).toBeFocused()
        await shot('fork')
        await fork.getByRole('button', { name: 'Fork' }).click()
        await expect
          .poll(() => page.evaluate(() => (window as unknown as E2eWindow).e2e.historyCalls().open))
          .toContain('f0f0f0f0-f0f0-4f0f-8f0f-f0f0f0f0f0f0')

        // Another provider's chat opens through a provider switch.
        list = await openList()
        await nav().getByRole('button', { name: 'Estimate the 2026 tax bill', exact: true }).click()
        await expect
          .poll(() => calls(page))
          .toContainEqual(['open', { provider: 'codex-subscription', id: X }])
      } finally {
        await app.close()
      }
    })
  }
}
