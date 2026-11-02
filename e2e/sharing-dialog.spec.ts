import { _electron as electron, expect, test, type Page } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { ApprovalPrompt, SharingPrompt } from '../src/shared/ipc'

/**
 * Sending a chat with local content to a cloud connection, in real Electron: main (the
 * fake preload) refuses the send with 'confirmation_required'; the dialog names what is
 * sent and where, fits a phone-narrow and a desktop width, Escape and Cancel confirm
 * nothing and keep the draft, an approval takes priority, and Confirm records it in main
 * and sends the same message again. Screenshots go to e2e-artifacts/.
 */

interface E2e {
  requireSharing: (prompt: SharingPrompt | null) => void
  sharingCalls: () => string[]
  sendCalls: () => { text: string; ids: string[] }[]
  pushApproval: (prompt: ApprovalPrompt) => void
}

const SHOTS = join(__dirname, '..', 'e2e-artifacts')

const PROMPT: SharingPrompt = {
  id: 'share-1',
  chat: { provider: 'ollama', id: '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d' },
  connection: 'gemini-api',
  destination: 'Gemini · API',
  reasons: ['local-to-cloud', 'gemini-free-tier'],
  sources: ['Ollama · Local'],
  includes: { messages: 12, toolOutput: true, attachments: 1 },
  notice: {
    title: 'Free Gemini API keys share your data with Google',
    text: 'On the Gemini API free tier, Google may use your prompts, files the agent reads and the responses to improve its products, and people may review them.',
  },
}

const launch = (width: number) =>
  electron.launch({
    args: [
      ...(process.platform === 'linux' ? ['--no-sandbox'] : []),
      join(__dirname, 'harness/main.cjs'),
    ],
    cwd: join(__dirname, '..'),
    env: { ...process.env, E2E_WIDTH: String(width), E2E_HEIGHT: '800' },
  })

const requireSharing = (page: Page, prompt: SharingPrompt) =>
  page.evaluate((value) => {
    ;(window as unknown as { e2e: E2e }).e2e.requireSharing(value)
  }, prompt)
const sharingCalls = (page: Page) =>
  page.evaluate(() => (window as unknown as { e2e: E2e }).e2e.sharingCalls())
const sentTexts = (page: Page) =>
  page.evaluate(() => (window as unknown as { e2e: E2e }).e2e.sendCalls().map((call) => call.text))
const pushApproval = (page: Page, prompt: ApprovalPrompt) =>
  page.evaluate((value) => {
    ;(window as unknown as { e2e: E2e }).e2e.pushApproval(value)
  }, prompt)

for (const width of [360, 1280]) {
  test(`asks before a local chat goes to the cloud at ${String(width)}px`, async () => {
    const app = await launch(width)
    try {
      const page = await app.firstWindow()
      const box = page.getByRole('textbox', { name: 'Message' })
      await expect(box).toBeVisible()
      await requireSharing(page, PROMPT)

      await box.fill('Keep going in the cloud')
      await box.press('Enter')
      const dialog = page.getByRole('alertdialog', { name: /Send this chat to Gemini · API/ })
      await expect(dialog).toBeVisible()
      await expect(dialog).toContainText('Ollama · Local')
      await expect(dialog).toContainText('12 earlier messages')
      await expect(dialog).toContainText('File contents and command output')
      await expect(dialog).toContainText('1 attached file')
      await expect(dialog).toContainText('Free Gemini API keys share your data with Google')
      await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused()
      for (const name of ['Cancel', 'Confirm'])
        await expect(dialog.getByRole('button', { name })).toBeInViewport()
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
        ),
      ).toBe(true)
      mkdirSync(SHOTS, { recursive: true })
      await page.screenshot({ path: join(SHOTS, `sharing-dialog-${String(width)}.png`) })

      // Escape cancels: nothing confirmed, the draft kept, no error banner.
      await page.keyboard.press('Escape')
      await expect(dialog).toHaveCount(0)
      await expect(box).toHaveValue('Keep going in the cloud')
      expect(await sharingCalls(page)).toEqual([])
      await expect(page.getByRole('alert')).toHaveCount(0)

      // An approval comes first: the dialog is hidden under it.
      await box.press('Enter')
      await expect(dialog).toBeVisible()
      await pushApproval(page, {
        id: 'approval-1',
        runId: 'r0',
        toolUseId: null,
        tool: 'write_file',
        kind: 'write',
        summary: 'Write notes.txt',
        detail: '+hello',
        origin: 'agent',
      })
      await expect(page.getByRole('button', { name: 'Deny' })).toBeVisible()
      await expect(dialog).toBeHidden()
      await page.getByRole('button', { name: 'Deny' }).click()
      await expect(dialog).toBeVisible()

      // Cancel: the same as Escape.
      await dialog.getByRole('button', { name: 'Cancel' }).click()
      await expect(dialog).toHaveCount(0)
      expect(await sharingCalls(page)).toEqual([])

      // Confirm: main records it, then the same message is sent again and goes through.
      await box.press('Enter')
      await dialog.getByRole('button', { name: 'Confirm' }).click()
      await expect(dialog).toHaveCount(0)
      await expect.poll(() => sharingCalls(page)).toEqual(['share-1'])
      // Four sends: refused (Escape), refused (approval, then Cancel), refused then confirmed.
      await expect
        .poll(() => sentTexts(page))
        .toEqual([
          'Keep going in the cloud',
          'Keep going in the cloud',
          'Keep going in the cloud',
          'Keep going in the cloud',
        ])
      await expect(box).toHaveValue('')
    } finally {
      await app.close()
    }
  })
}
