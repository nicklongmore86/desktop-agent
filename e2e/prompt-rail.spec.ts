import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { ChatEvent } from '../src/shared/ipc'

/**
 * The prompt navigator rail and the richer tool status in real Electron, in light and dark
 * at desktop and phone-narrow widths. Screenshots go to e2e-artifacts/prompt-rail/.
 */

const OUT = join(__dirname, '../e2e-artifacts/prompt-rail')

interface E2eWindow {
  e2e: { pushChat: (event: ChatEvent) => void }
}

async function launch(width: number): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({
    args: [
      ...(process.platform === 'linux' ? ['--no-sandbox'] : []),
      join(__dirname, 'harness/main.cjs'),
    ],
    cwd: join(__dirname, '..'),
    env: { ...process.env, E2E_WIDTH: String(width), E2E_HEIGHT: '800' },
  })
  const page = await app.firstWindow()
  await expect(page.getByRole('heading', { name: 'Workspace chat' })).toBeVisible()
  return { app, page }
}

for (const width of [1280, 400]) {
  for (const scheme of ['light', 'dark'] as const) {
    test(`prompt rail and tool status at ${String(width)}px, ${scheme}`, async () => {
      mkdirSync(OUT, { recursive: true })
      const { app, page } = await launch(width)
      const shot = async (name: string): Promise<void> => {
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
        await page.screenshot({ path: join(OUT, `${name}-${scheme}-${String(width)}.png`) })
      }
      const push = (event: ChatEvent): Promise<void> =>
        page.evaluate((e) => {
          ;(window as unknown as E2eWindow).e2e.pushChat(e)
        }, event)
      const tool = (runId: string, id: string, name: string, path: string): Promise<void> =>
        push({ type: 'tool_use', runId, turn: 1, id, name, input: { path } })
      const result = (
        runId: string,
        id: string,
        content: string,
        isError = false,
        declined = false,
      ): Promise<void> => push({ type: 'tool_result', runId, id, content, isError, declined })
      try {
        await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' })

        // Turn 1: finished, folded once a later prompt arrives.
        await push({ type: 'run_started', runId: 'a', text: 'What is in my Downloads folder?' })
        await tool('a', 'a1', 'list_dir', 'C:\\Users\\me\\Downloads')
        await page.waitForTimeout(1200)
        await result('a', 'a1', 'RFI\nInvoices')
        await push({
          type: 'text_delta',
          runId: 'a',
          turn: 2,
          text: 'Two folders: **RFI** and **Invoices**.',
        })
        await push({ type: 'run_finished', runId: 'a', stopReason: 'end_turn' })

        // Turn 2: a failure (stays open) and a declined write.
        await push({
          type: 'run_started',
          runId: 'b',
          text: 'Move the invoices into a dated folder, then write a summary.',
        })
        await tool('b', 'b1', 'move_file', 'C:\\Users\\me\\Downloads\\Invoices')
        await result('b', 'b1', 'Access denied: outside granted folders', true)
        await tool('b', 'b2', 'write_file', 'C:\\Users\\me\\Downloads\\summary.txt')
        await result(
          'b',
          'b2',
          'The user declined the write to summary.txt. Nothing was changed.',
          true,
          true,
        )
        await push({ type: 'text_delta', runId: 'b', turn: 2, text: 'I could not move them.' })
        await push({ type: 'run_finished', runId: 'b', stopReason: 'end_turn' })

        // Turn 3: streaming, five steps; the oldest folds away.
        await push({ type: 'run_started', runId: 'c', text: 'Search for large PDFs.' })
        for (const id of ['c1', 'c2', 'c3', 'c4', 'c5'])
          await tool('c', id, 'search_files', `C:\\Users\\me\\Downloads\\${id}`)
        for (const id of ['c1', 'c2', 'c3']) await result('c', id, 'ok')
        await page.waitForTimeout(1100)

        await expect(page.getByRole('button', { name: /^Worked for / })).toHaveCount(2)
        await expect(page.getByRole('button', { name: /Show 2 earlier steps/ })).toBeVisible()
        await shot('chat-activity')

        const ticks = page.getByRole('button', { name: /^Jump to prompt/ })
        if (width === 1280) {
          await expect(ticks).toHaveCount(3)
          await ticks.nth(1).hover()
          await expect(page.locator('.prompt-preview')).toContainText('Move the invoices')
          await shot('rail-hover')
          // Clicking centres that prompt; the active tick follows.
          await ticks.nth(0).click()
          await expect(ticks.nth(0)).toHaveAttribute('aria-current', 'location')
          await page.keyboard.press('Control+Alt+ArrowDown')
          await expect(ticks.nth(1)).toHaveAttribute('aria-current', 'location')
        } else {
          await expect(ticks).toHaveCount(0)
        }
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
        ).toBe(true)
      } finally {
        await app.close()
      }
    })
  }
}
