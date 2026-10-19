import { _electron as electron, expect, test, type Page } from '@playwright/test'
import { join } from 'node:path'

/**
 * Files dragged in from outside the app, in real Electron: a real DataTransfer
 * carrying a real File is dispatched onto the message box, the chat column and the
 * Files tree. Each shows the hint, accepts the drag so `drop` fires, refuses with the
 * toast, and the window neither navigates nor inserts anything.
 */

const MESSAGE = /Settings → Folders, or drag from the Files panel/

/** Dispatches `type` carrying a real File at `selector`; returns whether the event was default-prevented. */
const dragFile = (page: Page, selector: string, type: 'dragenter' | 'dragover' | 'drop') =>
  page.evaluate(
    ({ selector, type }) => {
      const target = document.querySelector(selector)
      if (!target) throw new Error(`no ${selector}`)
      const w = window as unknown as { dragData?: DataTransfer }
      if (!w.dragData) {
        w.dragData = new DataTransfer()
        w.dragData.items.add(new File(['secret body'], 'notes.txt', { type: 'text/plain' }))
      }
      const event = new DragEvent(type, {
        bubbles: true,
        cancelable: true,
        dataTransfer: w.dragData,
      })
      target.dispatchEvent(event)
      if (type === 'drop') delete w.dragData
      return {
        prevented: event.defaultPrevented,
        types: Array.from(event.dataTransfer?.types ?? []),
      }
    },
    { selector, type },
  )

test('files dragged in from outside are refused with a hint and a toast', async () => {
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
    const tree = page.getByRole('tree', { name: 'Files in granted folders' })
    await expect(tree.getByRole('treeitem', { name: /^README\.md/ })).toBeVisible()
    const composer = page.getByRole('textbox', { name: 'Message' })
    await page.evaluate(() => {
      ;(window as unknown as { marker: string }).marker = 'same-document'
    })
    const url = page.url()

    for (const [name, selector] of [
      ['message box', 'textarea[aria-label="Message"]'],
      ['chat column', '.chat .chat-toolbar'],
      ['file tree', '[role="tree"]'],
    ] as const) {
      const enter = await dragFile(page, selector, 'dragenter')
      expect(enter.types, name).toEqual(['Files'])
      expect(enter.prevented, `${name}: dragenter accepted`).toBe(true)
      expect((await dragFile(page, selector, 'dragover')).prevented, `${name}: dragover`).toBe(true)
      await expect(page.getByTestId('external-drop-hint'), `${name}: hint`).toContainText(MESSAGE)
      expect((await dragFile(page, selector, 'drop')).prevented, `${name}: drop handled`).toBe(true)
      await expect(page.getByRole('status').getByText(MESSAGE)).toBeVisible()
      await expect(page.getByTestId('external-drop-hint')).toHaveCount(0)
      await expect(composer).toHaveValue('')
      expect(page.url()).toBe(url)
      expect(await page.evaluate(() => (window as unknown as { marker?: string }).marker)).toBe(
        'same-document',
      )
    }

    // The hint is not interactive: it never intercepts the pointer.
    await dragFile(page, '.chat .chat-toolbar', 'dragenter')
    await expect(page.getByTestId('external-drop-hint')).toHaveCSS('pointer-events', 'none')
  } finally {
    await app.close()
  }
})
