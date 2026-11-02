import { _electron as electron, expect, test, type Page } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { ChatItem, HistoryState } from '../src/shared/ipc'
import type { ProviderChat } from '../src/shared/ipc-projects'

/**
 * One chat history across connections, in real Electron: the merged list with a badge per
 * row, a chat that keeps going when the connection is switched, opening another
 * connection's chat without switching, and the per-message provider badges (only where the
 * connection or model changes). Screenshots: 360px and 1280px, light and dark, in
 * SHOTS_DIR (default e2e-artifacts/unified-history).
 */

const OUT = process.env['SHOTS_DIR'] ?? join(__dirname, '../e2e-artifacts/unified-history')

interface E2eWindow {
  e2e: {
    setHistory: (history: HistoryState) => void
    setProjects: (projects: never[], others: ProviderChat[]) => void
    setChat: (items: ChatItem[]) => void
    holdNextSwitch: () => void
    releaseSwitch: () => void
    connectionCalls: () => { set: string[] }
    projectCalls: () => unknown[][]
  }
}

const DAY = 24 * 60 * 60 * 1000
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const X = '99999999-9999-4999-8999-999999999999'
const Y = '88888888-8888-4888-8888-888888888888'
const OPEN = 'Summarise the RFI responses in Downloads'
const OTHER = 'Estimate the 2026 tax bill'
const LOCAL = 'Sort the scanned receipts'

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

const items = (...replies: [string, string, string][]): ChatItem[] =>
  replies.flatMap(([id, connection, model], index): ChatItem[] => [
    { kind: 'user', id: `u${String(index)}`, text: `Question ${String(index + 1)}` },
    { kind: 'assistant', id, text: `Answer ${String(index + 1)}`, connection, model },
  ])

for (const width of [360, 1280]) {
  for (const scheme of ['light', 'dark'] as const) {
    test(`one history across connections at ${String(width)}px, ${scheme}`, async () => {
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
        const entry = (id: string, title: string, age: number) => ({
          id,
          title,
          createdAt: now - age,
          updatedAt: now - age,
        })
        const others: ProviderChat[] = [
          {
            ...entry(X, OTHER, 2 * DAY),
            provider: 'codex-subscription',
            lastConnection: 'codex-subscription',
          },
          {
            ...entry(Y, LOCAL, 3 * DAY),
            provider: 'ollama',
            lastConnection: 'claude-subscription',
          },
        ]
        const history: HistoryState = {
          activeId: A,
          conversations: [entry(A, OPEN, 0), entry(B, 'Draft a reply to the landlord', DAY)],
        }
        await page.evaluate(
          ([h, o, chat]) => {
            const e2e = (window as unknown as E2eWindow).e2e
            e2e.setProjects([], o)
            e2e.setHistory(h)
            e2e.setChat(chat)
          },
          [
            history,
            others,
            items(
              ['a1', 'anthropic-api', 'claude-sonnet-5-5'],
              ['a2', 'anthropic-api', 'claude-sonnet-5-5'],
            ),
          ] as const,
        )
        const shot = async (name: string): Promise<void> => {
          await settle(page)
          expect(
            await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
          ).toBe(true)
          await page.screenshot({ path: join(OUT, `${name}-${scheme}-${String(width)}.png`) })
        }
        const openList = async () => {
          if (width > 540) return page.getByRole('complementary', { name: 'Conversations' })
          const drawer = page.getByRole('dialog', { name: 'Chats' })
          if (!(await drawer.isVisible()))
            await page.getByRole('button', { name: 'Chats sidebar', exact: true }).click()
          return drawer
        }
        const closeList = async (): Promise<void> => {
          if (width <= 540 && (await page.getByRole('dialog', { name: 'Chats' }).isVisible()))
            await page.keyboard.press('Escape')
        }
        const badges = () => page.locator('.message-assistant .message-badge')
        const picker = page.getByRole('combobox', { name: 'Active provider' })
        const switchingStatus = page.locator('.message-switching')

        // The merged list: chats of three connections, each with the connection that last answered.
        let list = await openList()
        const row = (title: string) =>
          list.getByRole('navigation', { name: 'Chats' }).getByRole('button', {
            name: title,
            exact: true,
          })
        const badgeOf = (title: string) => row(title).locator('.chat-provider')
        await expect(row(OPEN)).toHaveAttribute('aria-current', 'page')
        await expect(badgeOf(OPEN)).toHaveText('Claude API')
        await expect(badgeOf(OTHER)).toHaveText('Codex')
        await expect(badgeOf(LOCAL)).toHaveText('Claude') // home Ollama, last answered by Claude
        await shot('merged-list')
        await closeList()

        // Only the first reply is badged: the second has the same connection and model.
        await expect(badges()).toHaveCount(1)
        await expect(badges().first()).toContainText('Claude · API')
        await expect(badges().first()).toContainText('claude-sonnet-5-5')

        // Switch connection with the chat open: it stays on screen, input disabled.
        await page.evaluate(() => {
          ;(window as unknown as E2eWindow).e2e.holdNextSwitch()
        })
        await expect(picker.locator('option[value="codex-subscription"]')).toHaveCount(1)
        await picker.selectOption('codex-subscription')
        await expect(switchingStatus).toContainText('Switching to Codex · ChatGPT…')
        await expect(page.getByText('Answer 2')).toBeVisible()
        await expect(page.getByRole('textbox', { name: 'Message' })).toHaveJSProperty(
          'readOnly',
          true,
        )
        await shot('switching')
        list = await openList()
        await expect(row(OPEN)).toHaveAttribute('aria-current', 'page')
        await expect(row(OTHER)).toBeVisible()
        await closeList()

        await page.evaluate(() => {
          ;(window as unknown as E2eWindow).e2e.releaseSwitch()
        })
        await expect(switchingStatus).toHaveCount(0)
        await expect(page.getByText('Answer 2')).toBeVisible()
        await expect(page.getByRole('textbox', { name: 'Message' })).toHaveJSProperty(
          'readOnly',
          false,
        )
        await expect(picker).toHaveValue('codex-subscription')

        // The next reply comes from Codex: badged. The one after it (same) is not.
        await page.evaluate(
          (chat) => {
            ;(window as unknown as E2eWindow).e2e.setChat(chat)
          },
          items(
            ['a1', 'anthropic-api', 'claude-sonnet-5-5'],
            ['a2', 'anthropic-api', 'claude-sonnet-5-5'],
            ['a3', 'codex-subscription', 'gpt-5.5'],
            ['a4', 'codex-subscription', 'gpt-5.5'],
            ['a5', 'codex-subscription', 'gpt-5.5-mini'],
          ),
        )
        await expect(badges()).toHaveCount(3)
        await expect(badges().nth(1)).toContainText('Codex · ChatGPT')
        await expect(badges().nth(1)).toContainText('gpt-5.5')
        await expect(badges().nth(2)).toContainText('gpt-5.5-mini')
        await expect(page.getByText('Answer 5')).toBeVisible()
        await shot('message-badges')

        // Opening another connection's chat continues it here: no provider switch.
        const before = await page.evaluate(
          () => (window as unknown as E2eWindow).e2e.connectionCalls().set,
        )
        list = await openList()
        await row(OTHER).click()
        await expect
          .poll(() => page.evaluate(() => (window as unknown as E2eWindow).e2e.projectCalls()))
          .toContainEqual(['open', { provider: 'codex-subscription', id: X }])
        expect(
          await page.evaluate(() => (window as unknown as E2eWindow).e2e.connectionCalls().set),
        ).toEqual(before)
        await expect(picker).toHaveValue('codex-subscription')
        list = await openList()
        await expect(row(OTHER)).toHaveAttribute('aria-current', 'page')
        await expect(row(OPEN)).not.toHaveAttribute('aria-current', 'page')
        await shot('opened-other')
      } finally {
        await app.close()
      }
    })
  }
}
