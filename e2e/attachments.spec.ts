import { _electron as electron, expect, test, type Page } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Attaching files in real Electron: a real DataTransfer carrying real Files is dropped on the
 * message box and chat column, a stubbed picker answers the paperclip, and a sent message shows
 * its chips. Screenshots (360 / 1280, light / dark) are written when ATTACHMENT_SHOTS_DIR is set.
 */

const SHOTS = process.env['ATTACHMENT_SHOTS_DIR']
  ? process.env['ATTACHMENT_SHOTS_DIR']
  : join(__dirname, '../.polly/ui-v2-shots/attachments')

interface E2e {
  setPickResult: (outcomes: unknown[]) => void
  sendCalls: () => { text: string; ids: string[] }[]
}
const launch = (width: number, height = 800, extra: Record<string, string> = {}) =>
  electron.launch({
    args: [
      ...(process.platform === 'linux' ? ['--no-sandbox'] : []),
      join(__dirname, 'harness/main.cjs'),
    ],
    cwd: join(__dirname, '..'),
    env: { ...process.env, E2E_WIDTH: String(width), E2E_HEIGHT: String(height), ...extra },
  })

/** Dispatches a drag event carrying real Files (name, text) at `selector`. */
const dragFiles = (
  page: Page,
  selector: string,
  type: 'dragenter' | 'dragover' | 'drop',
  files: { name: string; body: string; type: string }[] = [],
) =>
  page.evaluate(
    ({ selector, type, files }) => {
      const target = document.querySelector(selector)
      if (!target) throw new Error(`no ${selector}`)
      const data = new DataTransfer()
      for (const file of files)
        data.items.add(
          // The body is a binary string: one byte per character.
          new File([Uint8Array.from(file.body, (c) => c.charCodeAt(0))], file.name, {
            type: file.type,
          }),
        )
      const event = new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: data })
      target.dispatchEvent(event)
      return event.defaultPrevented
    },
    { selector, type, files },
  )

const PNG_BYTES =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

test('drops real files on the composer, attaches them, sends, and sees the chips on the message', async () => {
  const app = await launch(1280)
  try {
    const page = await app.firstWindow()
    await expect(page.getByRole('heading', { name: 'Workspace chat' })).toBeVisible()
    const url = page.url()

    // The hint says "Drop to attach" over the chat column, with the same overlay styling.
    await dragFiles(page, '.chat .chat-toolbar', 'dragenter', [
      { name: 'budget-notes.txt', body: 'hello', type: 'text/plain' },
    ])
    await expect(page.getByTestId('external-drop-hint')).toHaveText('Drop to attach')
    await expect(page.getByTestId('external-drop-hint')).toHaveCSS('pointer-events', 'none')

    const files = [
      { name: 'budget-notes.txt', body: 'hello', type: 'text/plain' },
      { name: 'screenshot.png', body: atob(PNG_BYTES), type: 'image/png' },
    ]
    expect(await dragFiles(page, '.chat .chat-toolbar', 'drop', files)).toBe(true)
    await expect(page.getByTestId('external-drop-hint')).toHaveCount(0)
    const staged = page.getByRole('list', { name: 'Attached files' })
    await expect(staged.getByText('budget-notes.txt')).toBeVisible()
    await expect(staged.getByText('screenshot.png')).toBeVisible()
    // The image chip is greyed, with the reason; the text file is not.
    const imageChip = staged.getByRole('listitem').filter({ hasText: 'screenshot.png' })
    await expect(imageChip).toHaveAttribute('title', /This model can’t see images/)
    // The preview is an object URL of the dropped File, which the CSP lets the image load.
    await expect(imageChip.locator('img')).toHaveAttribute('src', /^blob:/)
    await expect
      .poll(() => imageChip.locator('img').evaluate((img: HTMLImageElement) => img.naturalWidth))
      .toBeGreaterThan(0)
    await expect(
      staged.getByRole('listitem').filter({ hasText: 'budget-notes.txt' }),
    ).not.toHaveClass(/attachment-chip-muted/)
    expect(page.url()).toBe(url)

    // An in-grant text file becomes an @ reference in the text, a secret a toast.
    await dragFiles(page, 'textarea[aria-label="Message"]', 'drop', [
      { name: 'plan.reference.md', body: '#', type: 'text/markdown' },
    ])
    await expect(page.getByRole('textbox', { name: 'Message' })).toHaveValue(
      /@"C:.*plan\.reference\.md"/,
    )
    await dragFiles(page, 'textarea[aria-label="Message"]', 'drop', [
      { name: '.env', body: 'KEY=1', type: '' },
    ])
    await expect(
      page.getByRole('status').getByText('Secret files are never attached.'),
    ).toBeVisible()

    await page.getByRole('textbox', { name: 'Message' }).fill('Please read these')
    await page.getByRole('button', { name: 'Send' }).click()

    const sent = page.getByRole('list', { name: 'Messages' }).getByText('Please read these')
    await expect(sent).toBeVisible()
    const message = page.locator('.message-user')
    await expect(
      message.getByRole('list', { name: 'Attached files' }).getByText('budget-notes.txt'),
    ).toBeVisible()
    // Sending revokes the staged previews; the sent chip shows the kind icon.
    await expect(message.locator('img')).toHaveCount(0)
    await expect(message.getByRole('button', { name: /^Remove/ })).toHaveCount(0)
    await expect(
      page.locator('.composer').getByRole('list', { name: 'Attached files' }),
    ).toHaveCount(0)
    const calls = await page.evaluate(() => (window as unknown as { e2e: E2e }).e2e.sendCalls())
    expect(calls).toHaveLength(1)
    expect(calls[0]?.text).toBe('Please read these')
    expect(calls[0]?.ids).toHaveLength(2)
  } finally {
    await app.close()
  }
})

test('the paperclip uses the picker, and the Files tree is not an attach target', async () => {
  const app = await launch(1280)
  try {
    const page = await app.firstWindow()
    await expect(page.getByRole('heading', { name: 'Workspace chat' })).toBeVisible()
    await page.evaluate(() => {
      ;(window as unknown as { e2e: E2e }).e2e.setPickResult([
        {
          ok: true,
          kind: 'attachment',
          outsideGrant: true,
          attachment: {
            id: 'ab'.repeat(32),
            name: 'outside-contract.txt',
            kind: 'text',
            mime: 'text/plain',
            size: 4096,
          },
        },
      ])
    })
    const clip = page.getByRole('button', { name: 'Attach files' })
    await clip.focus()
    await page.keyboard.press('Enter')
    const staged = page.getByRole('list', { name: 'Attached files' })
    await expect(staged.getByText('outside-contract.txt')).toBeVisible()
    await expect(staged.getByRole('button', { name: 'Copy into folder…' })).toBeVisible()
    await staged.getByRole('button', { name: 'Remove outside-contract.txt' }).click()
    await expect(staged).toHaveCount(0)

    await dragFiles(page, '[role="tree"]', 'dragenter', [
      { name: 'a.txt', body: 'a', type: 'text/plain' },
    ])
    await expect(page.getByTestId('external-drop-hint')).toContainText(
      'Drop files on the message box to attach them',
    )
    await dragFiles(page, '[role="tree"]', 'drop', [
      { name: 'a.txt', body: 'a', type: 'text/plain' },
    ])
    await expect(staged).toHaveCount(0)
  } finally {
    await app.close()
  }
})

for (const width of [360, 1280]) {
  for (const scheme of ['light', 'dark'] as const) {
    test(`screenshots at ${String(width)}px, ${scheme}`, async () => {
      const app = await launch(width, width === 360 ? 760 : 800)
      try {
        const page = await app.firstWindow()
        await page.emulateMedia({ colorScheme: scheme })
        await expect(page.getByRole('heading', { name: 'Workspace chat' })).toBeVisible()
        const outcomes = [
          {
            id: 'a1'.repeat(32),
            name: 'quarterly-financial-summary-final-v2.xlsx.txt',
            kind: 'text',
            size: 183_000,
          },
          { id: 'b2'.repeat(32), name: 'screenshot.png', kind: 'image', size: 912_000 },
          { id: 'c3'.repeat(32), name: 'contract-signed.pdf', kind: 'pdf', size: 2_400_000 },
        ].map((a, i) => ({
          ok: true,
          kind: 'attachment',
          outsideGrant: i === 0,
          attachment: {
            ...a,
            mime:
              a.kind === 'text' ? 'text/plain' : a.kind === 'pdf' ? 'application/pdf' : 'image/png',
          },
        }))
        await page.evaluate((o) => {
          ;(window as unknown as { e2e: E2e }).e2e.setPickResult(o)
        }, outcomes)
        // Stage a real image through a drop so the chip shows its preview.
        await dragFiles(page, '.chat .chat-toolbar', 'drop', [
          { name: 'photo.png', body: atob(PNG_BYTES), type: 'image/png' },
        ])
        await page.getByRole('button', { name: 'Attach files' }).click()
        await expect(page.getByRole('list', { name: 'Attached files' })).toBeVisible()
        await page.getByRole('textbox', { name: 'Message' }).fill('Compare these')
        await page.getByRole('button', { name: 'Send' }).click()
        await expect(page.locator('.message-user')).toBeVisible()
        // Stage again, so the shot shows both the sent chips and the composer chips.
        await dragFiles(page, '.chat .chat-toolbar', 'drop', [
          { name: 'notes.txt', body: 'n', type: 'text/plain' },
          { name: 'diagram.png', body: atob(PNG_BYTES), type: 'image/png' },
        ])
        await expect(
          page.locator('.composer').getByRole('list', { name: 'Attached files' }),
        ).toBeVisible()
        // No horizontal overflow, even at 360px.
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
        ).toBe(true)
        mkdirSync(SHOTS, { recursive: true })
        await page.screenshot({ path: join(SHOTS, `attachments-${scheme}-${String(width)}.png`) })
      } finally {
        await app.close()
      }
    })
  }
}
