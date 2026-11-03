import { _electron as electron, expect, test, type Page } from '@playwright/test'
import { join } from 'node:path'
import type { ChatEvent, HistoryState } from '../src/shared/ipc'

/**
 * A chat's context menu, opened while the agent is replying, must survive tool steps:
 * the transcript follows each step (a scroll event) and the list refreshes, neither of
 * which may close or defocus a menu the user opened.
 */

interface E2eWindow {
  e2e: { setHistory: (history: HistoryState) => void; pushChat: (event: ChatEvent) => void }
}

const DAY = 24 * 60 * 60 * 1000
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

const push = (page: Page, events: ChatEvent[]): Promise<void> =>
  page.evaluate((list) => {
    for (const event of list) (window as unknown as E2eWindow).e2e.pushChat(event)
  }, events)

test('chat menu stays open and focused while tool steps run', async () => {
  const app = await electron.launch({
    args: [
      ...(process.platform === 'linux' ? ['--no-sandbox'] : []),
      join(__dirname, 'harness/main.cjs'),
    ],
    cwd: join(__dirname, '..'),
    env: { ...process.env, E2E_WIDTH: '1280', E2E_HEIGHT: '800' },
  })
  try {
    const page = await app.firstWindow()
    await expect(page.getByRole('heading', { name: 'Workspace chat' })).toBeVisible()
    const now = Date.now()
    const entry = (id: string, title: string, age: number) => ({
      id,
      title,
      createdAt: now - age,
      updatedAt: now - age,
    })
    const history: HistoryState = {
      activeId: A,
      conversations: [entry(A, 'Current chat', 0), entry(B, 'Old chat to delete', 3 * DAY)],
    }
    await page.evaluate((h) => {
      ;(window as unknown as E2eWindow).e2e.setHistory(h)
    }, history)

    const list = page.getByRole('complementary', { name: 'Conversations' })
    await list
      .getByRole('button', { name: 'Old chat to delete', exact: true })
      .click({ button: 'right' })
    const menu = page.getByRole('menu', { name: 'Options for Old chat to delete' })
    await expect(menu).toBeVisible()

    // Enough text that the transcript overflows, so following the newest step really scrolls.
    const steps: ChatEvent[] = [
      { type: 'run_started', runId: 'r1', text: 'Go' },
      { type: 'text_delta', runId: 'r1', turn: 0, text: 'A long reply.\n\n'.repeat(120) },
    ]
    for (let i = 0; i < 12; i++) {
      steps.push(
        {
          type: 'tool_use',
          runId: 'r1',
          turn: i,
          id: `t${String(i)}`,
          name: 'list_files',
          input: {},
        },
        {
          type: 'tool_result',
          runId: 'r1',
          id: `t${String(i)}`,
          content: 'ok',
          isError: false,
          declined: false,
        },
      )
    }
    for (const step of steps) {
      await push(page, [step])
      await page.waitForTimeout(30)
    }
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
    const scrolled = await page.evaluate(() =>
      [...document.querySelectorAll('*')].some((el) => el.scrollTop > 0),
    )
    expect(scrolled).toBe(true)
    await expect(menu).toBeVisible()
    await expect(menu.getByRole('menuitem', { name: 'Pin' })).toBeFocused()
    // The menu is still on the same chat, and still works.
    await menu.getByRole('menuitem', { name: 'Delete…' }).click()
    await expect(page.getByRole('alertdialog', { name: 'Delete chat?' })).toBeVisible()
  } finally {
    await app.close()
  }
})
