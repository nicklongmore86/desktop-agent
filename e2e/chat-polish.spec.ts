import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { ApprovalPrompt, ChatEvent, ProviderStatus } from '../src/shared/ipc'

/**
 * The polished chat in real Electron: rich messages, activity group, streaming,
 * composer pickers and the usage indicator, in light and dark at desktop and
 * phone-narrow widths. Screenshots go to e2e-artifacts/chat-polish/.
 */

const OUT = join(__dirname, '../e2e-artifacts/chat-polish')

interface E2eWindow {
  e2e: {
    pushChat: (event: ChatEvent) => void
    pushApproval: (prompt: ApprovalPrompt) => void
    setProvider: (status: ProviderStatus) => void
    setAllowance: (allowance: object) => void
    setCodexModels: (options: object[]) => void
    stopCalls: () => number
  }
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

const noSidewaysScroll = (page: Page): Promise<boolean> =>
  page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)

const MARKDOWN = [
  'Here is what I found in **Downloads**:',
  '',
  '| Folder | Files | Status |',
  '| --- | ---: | :---: |',
  '| RFI | 12 | done |',
  '| Invoices | 48 | ~~old~~ new |',
  '',
  '- [x] Listed folders',
  '- [ ] Summarise RFI',
  '',
  '```ts',
  'export function total(files: number[]): number {',
  '  // sum them up',
  '  return files.reduce((a, b) => a + b, 0)',
  '}',
  '```',
].join('\n')

for (const width of [1280, 400]) {
  for (const scheme of ['light', 'dark'] as const) {
    test(`chat polish at ${String(width)}px, ${scheme}`, async () => {
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
      try {
        await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' })

        // Pickers stay in the composer, even at phone width.
        const provider = page.getByRole('combobox', { name: 'Active provider' })
        await expect(provider).toBeInViewport()
        await expect(page.getByRole('combobox', { name: 'Model' })).toBeInViewport()

        // A conversation: tool activity, then a table, task list and code block.
        await push({ type: 'run_started', runId: 'r', text: 'What is in my Downloads folder?' })
        for (const id of ['t1', 't2', 't3']) {
          await push({
            type: 'tool_use',
            runId: 'r',
            turn: 1,
            id,
            name: 'list_dir',
            input: { path: `C:\\Users\\me\\Downloads\\${id}` },
          })
        }
        await push({ type: 'tool_result', runId: 'r', id: 't1', content: 'RFI', isError: false })
        await push({
          type: 'tool_result',
          runId: 'r',
          id: 't2',
          content: 'Invoices',
          isError: false,
        })
        // Streaming: one tool still running.
        await expect(page.getByRole('button', { name: /Using 3 tools/ })).toBeVisible()
        await expect(page.locator('.typing-dots')).toBeVisible()
        await shot('streaming')

        await push({ type: 'tool_result', runId: 'r', id: 't3', content: 'Logs', isError: false })
        await push({ type: 'text_delta', runId: 'r', turn: 2, text: MARKDOWN })
        await push({ type: 'run_finished', runId: 'r', stopReason: 'end_turn' })
        await expect(page.getByRole('table')).toBeVisible()
        await expect(page.locator('.hljs-keyword').first()).toBeVisible()
        await expect(page.getByRole('button', { name: /Used 3 tools/ })).toBeVisible()
        await shot('conversation-activity-collapsed')
        await page.getByRole('button', { name: /Used 3 tools/ }).click()
        await expect(page.getByText('C:\\Users\\me\\Downloads\\t1')).toBeVisible()
        await shot('activity-group-open')
        await page.getByRole('button', { name: /Used 3 tools/ }).click()
        expect(await noSidewaysScroll(page)).toBe(true)

        // Message actions are reachable by keyboard.
        const retry = page.getByRole('button', { name: 'Retry' })
        await retry.focus()
        await expect(retry).toBeVisible()
        await expect(retry).toBeEnabled()
        await shot('message-actions-focus')

        // Usage: amber, then red; the indicator opens account settings.
        await page.evaluate(() => {
          const { setAllowance, setCodexModels } = (window as unknown as E2eWindow).e2e
          setCodexModels([
            {
              id: 'gpt-5.6-terra',
              label: 'GPT-5.6 Terra',
              defaultReasoningEffort: 'medium',
              supportedReasoningEfforts: ['medium'],
              isDefault: true,
            },
            {
              id: 'gpt-5.6-sol',
              label: 'GPT-5.6 Sol',
              defaultReasoningEffort: 'medium',
              supportedReasoningEfforts: ['medium'],
              isDefault: false,
            },
          ])
          setAllowance({
            plan: 'Plus',
            state: 'available',
            resetsAt: null,
            windows: [{ limitId: 'codex:secondary', remainingPercent: 18, resetsAt: null }],
            lastError: null,
          })
        })
        await provider.selectOption('codex-subscription')
        await expect(page.getByRole('combobox', { name: 'Model' })).toBeVisible()
        await expect(page.getByRole('button', { name: /82% of weekly limit used/ })).toBeVisible()
        await shot('usage-amber')

        await page.evaluate(() => {
          ;(window as unknown as E2eWindow).e2e.setAllowance({
            plan: 'Plus',
            state: 'limited',
            resetsAt: new Date(Date.now() + 2 * 24 * 3_600_000).toISOString(),
            windows: [{ limitId: 'codex:secondary', remainingPercent: 0, resetsAt: null }],
            lastError: null,
          })
        })
        await provider.selectOption('claude-subscription')
        await provider.selectOption('codex-subscription')
        await expect(page.getByRole('button', { name: /Limit reached – resets/ })).toBeVisible()
        await shot('usage-red')
        expect(await noSidewaysScroll(page)).toBe(true)

        // Esc stops a running reply.
        await push({ type: 'run_started', runId: 's', text: 'again' })
        await expect(page.getByRole('button', { name: 'Stop' })).toBeVisible()
        await page.keyboard.press('Escape')
        await expect
          .poll(() => page.evaluate(() => (window as unknown as E2eWindow).e2e.stopCalls()))
          .toBe(1)
      } finally {
        await app.close()
      }
    })
  }
}

test('narrow 360px keeps the composer pickers and Send reachable', async () => {
  mkdirSync(OUT, { recursive: true })
  const { app, page } = await launch(360)
  try {
    await expect(page.getByRole('combobox', { name: 'Active provider' })).toBeInViewport()
    await expect(page.getByRole('combobox', { name: 'Model' })).toBeInViewport()
    await page.getByRole('textbox', { name: 'Message' }).fill('hello')
    await expect(page.getByRole('button', { name: 'Send' })).toBeInViewport()
    expect(await noSidewaysScroll(page)).toBe(true)
    await page.screenshot({ path: join(OUT, 'narrow-360.png') })
  } finally {
    await app.close()
  }
})

test('Windows High Contrast keeps flagged characters and the focus ring visible', async () => {
  const { app, page } = await launch(1280)
  try {
    await page.emulateMedia({ forcedColors: 'active' })
    await page.evaluate(() => {
      ;(window as unknown as E2eWindow).e2e.pushApproval({
        id: 'a1',
        runId: 'r',
        toolUseId: 't',
        tool: 'write_file',
        kind: 'write',
        summary: 'Write C:\\work\\notes\u202e.txt',
        detail: '+x\n',
      })
    })
    const flagged = page.locator('.unsafe-char').first()
    await expect(flagged).toBeVisible()
    const style = await flagged.evaluate((el) => {
      const own = getComputedStyle(el)
      const dialog = getComputedStyle(el.closest('[role="alertdialog"]') as Element)
      return {
        bg: own.backgroundColor,
        dialogBg: dialog.backgroundColor,
        border: own.borderTopWidth,
      }
    })
    expect(style.bg).not.toBe(style.dialogBg)
    expect(style.border).toBe('1px')
    mkdirSync(OUT, { recursive: true })
    await page.screenshot({ path: join(OUT, 'forced-colors-approval.png') })
    // Deny has the initial focus, with a visible outline.
    const outline = await page
      .getByRole('button', { name: 'Deny' })
      .evaluate((el) => getComputedStyle(el).outlineStyle)
    expect(outline).not.toBe('none')
  } finally {
    await app.close()
  }
})
