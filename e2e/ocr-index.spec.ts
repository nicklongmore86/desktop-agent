import { _electron as electron, expect, test, type Page } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { ApprovalPrompt } from '../src/shared/ipc'
import type { FileLocation } from '../src/shared/ipc-files'
import type { OcrIndexJob } from '../src/shared/ipc-ocr-index'

/**
 * Background indexing of scanned documents in the Files panel, in real Electron: starting it
 * from a folder's context menu (pointer and keyboard), its progress, Pause/Resume, Cancel and
 * Dismiss, and that an approval dialog keeps the focus while progress comes in. In light and
 * dark at desktop and phone width. Screenshots (ocr-index-*) go to e2e-artifacts/ui/.
 */

const OUT = join(__dirname, '../e2e-artifacts/ui')
const ROOT = 'C:\\Users\\me\\Projects'
const ROOT_ID = 'r00000000000000a1'

interface E2eWindow {
  e2e: {
    setOcrIndex: (jobs: OcrIndexJob[]) => void
    ocrIndexCalls: () => {
      start: FileLocation[]
      pause: string[]
      resume: string[]
      cancel: string[]
      dismiss: string[]
    }
    pushApproval: (prompt: ApprovalPrompt) => void
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

const calls = (page: Page) =>
  page.evaluate(() => (window as unknown as E2eWindow).e2e.ocrIndexCalls())
const setJobs = (page: Page, jobs: OcrIndexJob[]) =>
  page.evaluate((next) => {
    ;(window as unknown as E2eWindow).e2e.setOcrIndex(next)
  }, jobs)

const job = (over: Partial<OcrIndexJob> = {}): OcrIndexJob => ({
  id: '0000000000000001',
  rootId: ROOT_ID,
  rel: 'docs',
  name: 'docs',
  path: `${ROOT}\\docs`,
  state: 'reading',
  filesChecked: 1712,
  filesTotal: 1712,
  pagesDone: 1240,
  pagesTotal: 3104,
  pagesFailed: 0,
  minutesLeft: 18,
  cloudOnly: 0,
  skipped: 0,
  message: 'Reading scanned pages at low priority. Searches come first.',
  ...over,
})

for (const viewport of [1280, 400]) {
  for (const scheme of ['light', 'dark'] as const) {
    test(`indexing scanned documents at ${String(viewport)}px, ${scheme}`, async () => {
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
        await expect(row(/^docs/)).toBeVisible()

        // Start from the folder's context menu.
        await row(/^docs/).click({ button: 'right' })
        const menu = page.getByRole('menu', { name: 'Actions for docs' })
        await expect(menu.getByRole('menuitem', { name: 'Index scanned documents' })).toBeVisible()
        await shot('ocr-index-menu')
        await menu.getByRole('menuitem', { name: 'Index scanned documents' }).click()
        expect((await calls(page)).start).toEqual([{ rootId: ROOT_ID, rel: 'docs' }])
        const panel = page.getByRole('region', { name: 'Scanned documents' })
        // The state, as announced: the folder's name (for screen readers) and the state.
        const state = panel.locator('.ocr-job-state')
        await expect(state).toHaveText('docs: Finding scanned pages')

        // Progress as main pushes it.
        await setJobs(page, [job()])
        const bar = panel.getByRole('progressbar', { name: 'Indexing docs' })
        await expect(bar).toHaveAttribute('aria-valuenow', '40')
        await expect(
          panel.getByText('1,240 of 3,104 pages read · about 18 minutes left'),
        ).toBeVisible()
        expect(await noSidewaysScroll()).toBe(true)
        await shot('ocr-index-reading')

        // The folder holding it can't be started too; the menu says why.
        await row(/^Projects/).click({ button: 'right' })
        const rootItem = page
          .getByRole('menu', { name: 'Actions for Projects' })
          .getByRole('menuitem', { name: 'Index scanned documents' })
        await expect(rootItem).toHaveAttribute('aria-disabled', 'true')
        await page.keyboard.press('Escape')

        // Pause, resume, cancel.
        await panel.getByRole('button', { name: 'Pause indexing docs' }).click()
        await expect(state).toHaveText('docs: Paused')
        await shot('ocr-index-paused')
        await panel.getByRole('button', { name: 'Resume indexing docs' }).click()
        await expect(panel.getByRole('button', { name: 'Pause indexing docs' })).toBeVisible()
        await panel.getByRole('button', { name: 'Cancel indexing docs' }).click()
        await expect(panel).toBeHidden()
        expect(await calls(page)).toMatchObject({
          pause: ['0000000000000001'],
          resume: ['0000000000000001'],
          cancel: ['0000000000000001'],
        })

        // From the keyboard: Shift+F10 on the folder row.
        await row(/^docs/).click()
        await page.keyboard.press('Shift+F10')
        await page
          .getByRole('menu', { name: 'Actions for docs' })
          .getByRole('menuitem', { name: 'Index scanned documents' })
          .focus()
        await page.keyboard.press('Enter')
        await expect(panel).toBeVisible()
        expect((await calls(page)).start).toHaveLength(2)

        // An approval dialog keeps the focus while progress keeps coming in.
        await page.evaluate(() => {
          ;(window as unknown as E2eWindow).e2e.pushApproval({
            id: 'ocr-approval',
            runId: 'run-1',
            toolUseId: null,
            tool: 'delete_path',
            kind: 'delete',
            summary: 'Move C:\\Users\\me\\Projects\\old.txt to the Recycle Bin',
            detail: 'C:\\Users\\me\\Projects\\old.txt',
          })
        })
        const deny = page.getByRole('button', { name: 'Deny', exact: true })
        await expect(deny).toBeFocused()
        for (const done of [1300, 1360, 1420]) {
          await setJobs(page, [job({ id: '0000000000000002', pagesDone: done })])
        }
        await expect(deny).toBeFocused()
        await deny.click()

        // Finished, with the notes, then dismissed.
        await setJobs(page, [
          job({
            id: '0000000000000002',
            state: 'finished',
            pagesDone: 3104,
            minutesLeft: null,
            cloudOnly: 4,
            pagesFailed: 2,
            skipped: 1,
            message: 'Every scanned page that could be read has been read.',
          }),
        ])
        await expect(state).toHaveText('docs: Done')
        await expect(panel.getByText(/4 online-only files not downloaded/)).toBeVisible()
        expect(await noSidewaysScroll()).toBe(true)
        await shot('ocr-index-finished')
        await panel.getByRole('button', { name: 'Dismiss indexing of docs' }).click()
        await expect(panel).toBeHidden()

        // Stopped: the reason, and Try again.
        await setJobs(page, [
          job({
            id: '0000000000000003',
            state: 'stopped',
            message: 'Stopped: OCR failed on several pages in a row. Resume to try again.',
          }),
        ])
        await expect(panel.getByRole('button', { name: 'Try indexing docs again' })).toBeVisible()
        await shot('ocr-index-stopped')
      } finally {
        await app.close()
      }
    })
  }
}
