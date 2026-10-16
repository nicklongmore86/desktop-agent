import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type {
  ApprovalPrompt,
  ChatEvent,
  ProviderLoginState,
  ProviderStatus,
} from '../src/shared/ipc'

/**
 * Screenshots of the main screens (chat, approval dialog, Settings, sign-in) in
 * light and dark at a desktop and a phone-narrow width, for design review in CI.
 * They go to e2e-artifacts/ui/. The only assertions are that each screen
 * renders and that nothing overflows the window sideways.
 */

const OUT = join(__dirname, '../e2e-artifacts/ui')

interface E2eWindow {
  e2e: {
    pushChat: (event: ChatEvent) => void
    pushApproval: (prompt: ApprovalPrompt) => void
    setProvider: (status: ProviderStatus) => void
    pushLoginState: (state: ProviderLoginState) => void
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

for (const width of [1280, 400]) {
  for (const scheme of ['light', 'dark'] as const) {
    test(`screens at ${String(width)}px, ${scheme}`, async () => {
      mkdirSync(OUT, { recursive: true })
      const { app, page } = await launch(width)
      const shot = async (name: string): Promise<void> => {
        // Let the frame settle (media-query changes repaint asynchronously) before capturing.
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
      try {
        // Reduced motion keeps the screenshots from catching a colour transition mid-way.
        await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' })

        // Empty chat.
        await expect(
          page.getByRole('heading', { name: 'What would you like to work on?' }),
        ).toBeVisible()
        await shot('chat-empty')

        // A conversation with a tool call and a streamed reply.
        await page.evaluate(() => {
          const { pushChat } = (window as unknown as E2eWindow).e2e
          pushChat({ type: 'run_started', runId: 'r', text: 'Can you find the RFI folder?' })
          pushChat({
            type: 'text_delta',
            runId: 'r',
            turn: 1,
            text: 'I found **RFI** in Downloads.\n\n## Contents\n\n- `plan.docx`\n- `budget.xlsx`\n\n```\nC:\\Users\\me\\Downloads\\RFI\n```',
          })
          pushChat({
            type: 'tool_use',
            runId: 'r',
            turn: 1,
            id: 't1',
            name: 'list_directory',
            input: { path: 'C:\\Users\\me\\Downloads' },
          })
          pushChat({
            type: 'tool_result',
            runId: 'r',
            id: 't1',
            content: 'RFI\nInvoices',
            isError: false,
          })
        })
        await expect(page.getByText('I found')).toBeVisible()
        await shot('chat-conversation')

        // Approval dialog.
        await page.evaluate(() => {
          ;(window as unknown as E2eWindow).e2e.pushApproval({
            id: 'a1',
            runId: 'r',
            toolUseId: 't2',
            tool: 'write_file',
            kind: 'write',
            summary: 'Write C:\\Users\\me\\Projects\\notes.md',
            detail:
              '--- a/notes.md\n+++ b/notes.md\n@@ -1,2 +1,2 @@\n # Notes\n-old line\n+new line\n',
          })
        })
        await expect(page.getByRole('alertdialog')).toBeVisible()
        await shot('approval')
        await page.getByRole('button', { name: 'Deny' }).click()
        await expect(page.getByRole('alertdialog')).toBeHidden()
        expect(await noSidewaysScroll(page)).toBe(true)

        // Settings, API mode.
        await page.getByRole('button', { name: 'Preferences' }).click()
        await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible()
        await shot('settings-api')

        // Settings, Claude subscription mid sign-in.
        await page.evaluate(() => {
          const { setProvider, pushLoginState } = (window as unknown as E2eWindow).e2e
          setProvider({
            provider: 'claude-subscription',
            state: 'signed-out',
            message: 'Sign in with your subscription.',
          })
          pushLoginState({
            provider: 'claude-subscription',
            active: true,
            url: 'https://claude.ai/oauth/authorize?code=true&client_id=e2e&state=e2e',
            result: null,
          })
        })
        await page.getByLabel('Access provider').selectOption('claude-subscription')
        await expect(page.getByLabel('Sign-in link')).toBeVisible()
        await shot('settings-signin')
        expect(await noSidewaysScroll(page)).toBe(true)
      } finally {
        await app.close()
      }
    })
  }
}
