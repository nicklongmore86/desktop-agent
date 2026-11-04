import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test'
import { join } from 'node:path'
import { contextMenuTemplate, type ContextMenuParams } from '../src/main/context-menu-template'

/**
 * Right-click in the real renderer under real Electron: what Chromium reports in the
 * 'context-menu' params for each kind of target, the menu the app builds from it, and
 * that keyboard editing shortcuts work in the window. (The harness records the params
 * instead of popping a native menu, which a test cannot inspect.)
 */
async function launch(): Promise<ElectronApplication> {
  return electron.launch({
    args: [
      ...(process.platform === 'linux' ? ['--no-sandbox'] : []),
      join(__dirname, 'harness/main.cjs'),
    ],
    cwd: join(__dirname, '..'),
    env: { ...process.env, E2E_WIDTH: '1280', E2E_HEIGHT: '800' },
  })
}

test('right-click params map to the right menu; shortcuts work', async () => {
  const app = await launch()
  try {
    const page = await app.firstWindow()
    await expect(page.getByRole('heading', { name: 'Workspace chat' })).toBeVisible()
    await app.evaluate(({ BrowserWindow }) => {
      const g = globalThis as unknown as { lastMenu?: unknown }
      const [window] = BrowserWindow.getAllWindows()
      window?.webContents.on('context-menu', (_e, params) => {
        g.lastMenu = {
          isEditable: params.isEditable,
          selectionText: params.selectionText,
          formControlType: params.formControlType,
          editFlags: params.editFlags,
        }
      })
    })
    await page.evaluate(() => {
      document.body.insertAdjacentHTML(
        'beforeend',
        `<div id="probe" style="position:fixed;top:0;left:0;z-index:99999;background:#fff;padding:8px">
           <input id="p-text" value="hello world" />
           <input id="p-pass" type="password" value="sekret" />
           <p id="p-read">read only words</p>
           <p id="p-none">other</p>
         </div>`,
      )
    })
    const lastMenu = async (): Promise<ContextMenuParams> => {
      await expect
        .poll(() => app.evaluate(() => (globalThis as { lastMenu?: unknown }).lastMenu))
        .toBeTruthy()
      const value = await app.evaluate(() => (globalThis as { lastMenu?: unknown }).lastMenu)
      await app.evaluate(() => {
        delete (globalThis as { lastMenu?: unknown }).lastMenu
      })
      return value as ContextMenuParams
    }
    const roles = (p: ContextMenuParams): string[] =>
      contextMenuTemplate(p).flatMap((i) => (i.role ? [i.role] : []))

    // Editable text with a selection: the full set, Cut/Copy enabled.
    await page.locator('#p-text').click()
    await page.keyboard.press('Control+A')
    await page.locator('#p-text').click({ button: 'right' })
    const text = await lastMenu()
    expect(text.isEditable).toBe(true)
    expect(roles(text)).toEqual(['undo', 'redo', 'cut', 'copy', 'paste', 'selectAll'])
    expect(text.editFlags.canCut).toBe(true)
    expect(text.editFlags.canCopy).toBe(true)

    // Password field: Chromium reports it, and the menu drops Cut and Copy.
    await page.locator('#p-pass').click()
    await page.keyboard.press('Control+A')
    await page.locator('#p-pass').click({ button: 'right' })
    const pass = await lastMenu()
    expect(pass.formControlType).toBe('input-password')
    expect(roles(pass)).toEqual(['undo', 'redo', 'paste', 'selectAll'])

    // Selected read-only text: Copy and Select All.
    await page.locator('#p-read').click({ clickCount: 3 })
    await page.locator('#p-read').click({ button: 'right' })
    const read = await lastMenu()
    expect(read.isEditable).toBe(false)
    expect(read.selectionText).toContain('read only words')
    expect(roles(read)).toEqual(['copy', 'selectAll'])

    // Nothing selected, not editable: no menu.
    await page.locator('#p-none').click()
    await page.mouse.click(1000, 700, { button: 'right' })
    expect(roles(await lastMenu())).toEqual([])

    // Keyboard shortcuts work with the default (hidden) menu bar.
    const field = page.locator('#p-text')
    await field.click()
    await page.keyboard.press('Control+A')
    await page.keyboard.press('Control+X')
    await expect(field).toHaveValue('')
    await page.keyboard.press('Control+V')
    await expect(field).toHaveValue('hello world')
    await page.keyboard.press('Control+A')
    await page.keyboard.press('Control+C')
    await page.keyboard.press('End')
    await page.keyboard.type('!')
    await page.keyboard.press('Control+Z')
    await expect(field).toHaveValue('hello world')
  } finally {
    await app.close()
  }
})

test('the app’s own right-click menus suppress the native event', async () => {
  const app = await launch()
  try {
    const page = await app.firstWindow()
    await expect(page.getByRole('heading', { name: 'Workspace chat' })).toBeVisible()
    await app.evaluate(({ BrowserWindow }) => {
      const g = globalThis as unknown as { menuEvents: number }
      g.menuEvents = 0
      const [window] = BrowserWindow.getAllWindows()
      window?.webContents.on('context-menu', () => {
        g.menuEvents += 1
      })
    })
    await page.evaluate(() => {
      document.body.insertAdjacentHTML(
        'beforeend',
        `<div id="own" style="position:fixed;top:0;left:0;z-index:99999;padding:20px;background:#fff">own menu</div>`,
      )
      document.getElementById('own')?.addEventListener('contextmenu', (e) => {
        e.preventDefault()
      })
    })
    await page.locator('#own').click({ button: 'right' })
    await page.mouse.click(1000, 700, { button: 'right' })
    await expect
      .poll(() => app.evaluate(() => (globalThis as unknown as { menuEvents: number }).menuEvents))
      .toBe(1)
  } finally {
    await app.close()
  }
})
