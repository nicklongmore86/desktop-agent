import { _electron as electron, expect, test, type Page } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { ApprovalPrompt, ChatEvent } from '../src/shared/ipc'

/**
 * The Chat | Command switch in real Electron: the header control, Ctrl+Alt+\, the command
 * line in place of the composer, a command card in the conversation and the approval
 * prompt a typed command gets. Screenshots (command-*) go to e2e-artifacts/ui/.
 */

const OUT = join(__dirname, '../e2e-artifacts/ui')
const ROOT = 'C:\\Users\\me\\Projects'

interface E2eWindow {
  e2e: {
    pushChat: (event: ChatEvent) => void
    pushApproval: (prompt: ApprovalPrompt) => void
    commandRuns: () => { command: string; cwd: string }[]
    responses: () => { id: string; approved: boolean }[]
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

const push = (page: Page, event: ChatEvent): Promise<void> =>
  page.evaluate((next) => {
    ;(window as unknown as E2eWindow).e2e.pushChat(next)
  }, event)

const OUTPUT = [
  'exit code: 0',
  `cwd: ${ROOT}`,
  '--- stdout ---',
  '',
  '    Directory: C:\\Users\\me\\Projects',
  '',
  'Mode                 LastWriteTime         Length Name',
  '----                 -------------         ------ ----',
  'd-----        14/10/2026     09:12                desktop-agent',
  '-a----        15/10/2026     17:40           2048 notes.md',
  '',
  '--- stderr ---',
  '',
].join('\n')

for (const viewport of [1280, 400]) {
  for (const scheme of ['light', 'dark'] as const) {
    test(`command mode at ${String(viewport)}px, ${scheme}`, async () => {
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
        const view = page.getByRole('group', { name: 'View' })
        await expect(view.getByRole('button', { name: 'Chat' })).toHaveAttribute(
          'aria-pressed',
          'true',
        )

        // Ctrl+Alt+\ from the message box switches to the command line, focused.
        await page.getByRole('textbox', { name: 'Message' }).click()
        await page.keyboard.press('Control+Alt+Backslash')
        const command = page.getByRole('textbox', { name: 'Command' })
        await expect(command).toBeFocused()
        await expect(view.getByRole('button', { name: 'Command' })).toHaveAttribute(
          'aria-pressed',
          'true',
        )
        await expect(page.getByRole('textbox', { name: 'Message' })).toBeHidden()

        await command.fill('Get-ChildItem')
        await command.press('Enter')
        expect(
          await page.evaluate(() => (window as unknown as E2eWindow).e2e.commandRuns()),
        ).toEqual([{ command: 'Get-ChildItem', cwd: ROOT }])
        await expect(command).toHaveValue('')

        // What main sends back: the card, the approval, then the output.
        await push(page, {
          type: 'command_started',
          runId: 'run-1',
          id: 'cmd-1',
          command: 'Get-ChildItem',
          cwd: ROOT,
        })
        await page.evaluate((root) => {
          ;(window as unknown as E2eWindow).e2e.pushApproval({
            id: 'ap-1',
            runId: 'run-1',
            toolUseId: 'cmd-1',
            tool: 'run_shell',
            kind: 'shell',
            summary: `Run a command in ${root}`,
            detail: `cwd: ${root}\nshell: C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe -NoProfile -NonInteractive -EncodedCommand\n\nGet-ChildItem`,
            origin: 'user-terminal',
          })
        }, ROOT)
        const dialog = page.getByRole('alertdialog')
        await expect(dialog).toBeVisible()
        await expect(dialog.getByText(/Typed in the command bar/)).toBeVisible()
        await settle(page)
        await page.screenshot({
          path: join(OUT, `command-approval-${scheme}-${String(viewport)}.png`),
        })
        // The hotkey does nothing while the approval is open.
        await page.keyboard.press('Control+Alt+Backslash')
        await expect(view.getByRole('button', { name: 'Command' })).toHaveAttribute(
          'aria-pressed',
          'true',
        )
        await dialog.getByRole('button', { name: 'Approve' }).click()
        await expect(dialog).toBeHidden()
        expect(await page.evaluate(() => (window as unknown as E2eWindow).e2e.responses())).toEqual(
          [{ id: 'ap-1', approved: true }],
        )

        await push(page, {
          type: 'tool_result',
          runId: 'run-1',
          id: 'cmd-1',
          content: OUTPUT,
          isError: false,
          declined: false,
        })
        await push(page, { type: 'run_finished', runId: 'run-1', stopReason: 'end_turn' })
        const card = page.getByRole('region', { name: 'Command you ran' })
        await expect(card.getByLabel('Command output')).toContainText('notes.md')
        await expect(card.getByText('done')).toBeVisible()

        // No horizontal page scroll at either width.
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
          ),
        ).toBe(true)
        await command.focus()
        await settle(page)
        await page.screenshot({ path: join(OUT, `command-${scheme}-${String(viewport)}.png`) })

        await page.keyboard.press('Control+Alt+Backslash')
        await expect(page.getByRole('textbox', { name: 'Message' })).toBeFocused()
      } finally {
        await app.close()
      }
    })
  }
}
