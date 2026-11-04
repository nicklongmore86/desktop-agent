import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * The real main bundle with a real window. ELECTRON_FORCE_IS_PACKAGED makes app.isPackaged true,
 * which is all the menu looks at; the installer itself is not started.
 *
 * Keys go in through webContents.sendInputEvent: Playwright's keyboard (CDP) never reaches menu
 * accelerators, so with it Ctrl+R would "do nothing" whatever the menu said.
 */

interface Launched {
  app: ElectronApplication
  userData: string
}

async function launch(packaged: boolean): Promise<Launched> {
  const userData = mkdtempSync(join(tmpdir(), 'desktop-agent-menu-'))
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && key !== 'ELECTRON_RENDERER_URL') env[key] = value
  }
  if (packaged) env['ELECTRON_FORCE_IS_PACKAGED'] = 'true'
  const app = await electron.launch({
    args: [
      ...(process.platform === 'linux' ? ['--no-sandbox'] : []),
      join(__dirname, 'harness/app-main.cjs'),
      `--user-data-dir=${userData}`,
    ],
    cwd: join(__dirname, '..'),
    env,
  })
  const page = await app.firstWindow()
  await expect(page.getByRole('heading', { name: 'Workspace chat' })).toBeVisible()
  await app.evaluate(({ BrowserWindow }) => {
    const contents = BrowserWindow.getAllWindows()[0]?.webContents
    const state = { loads: 0 }
    ;(globalThis as unknown as { menuTest: typeof state }).menuTest = state
    contents?.on('did-start-loading', () => {
      state.loads += 1
    })
  })
  return { app, userData }
}

const press = (app: ElectronApplication, keyCode: string, modifiers: string[]): Promise<void> =>
  app.evaluate(
    ({ BrowserWindow }, key) => {
      const window = BrowserWindow.getAllWindows()[0]
      if (!window) throw new Error('no window')
      window.focus()
      window.webContents.focus()
      const modifiers = key.modifiers as NonNullable<Electron.KeyboardInputEvent['modifiers']>
      window.webContents.sendInputEvent({ type: 'keyDown', keyCode: key.keyCode, modifiers })
      window.webContents.sendInputEvent({ type: 'keyUp', keyCode: key.keyCode, modifiers })
    },
    { keyCode, modifiers },
  )

const loads = (app: ElectronApplication): Promise<number> =>
  app.evaluate(() => (globalThis as unknown as { menuTest: { loads: number } }).menuTest.loads)
const devToolsOpen = (app: ElectronApplication): Promise<boolean> =>
  app.evaluate(
    ({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]?.webContents.isDevToolsOpened() ?? false,
  )
const zoomLevel = (app: ElectronApplication): Promise<number> =>
  app.evaluate(
    ({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.webContents.getZoomLevel() ?? 0,
  )
const clickMenuItem = (app: ElectronApplication, id: string): Promise<void> =>
  app.evaluate(({ Menu, BrowserWindow }, itemId) => {
    const window = BrowserWindow.getAllWindows()[0]
    Menu.getApplicationMenu()
      ?.getMenuItemById(itemId)
      ?.click(undefined, window, window?.webContents)
  }, id)

/** Answers recovery prompts by button label and records what each offered. */
const stubPrompts = (app: ElectronApplication, answer: string): Promise<void> =>
  app.evaluate(({ dialog }, label) => {
    const offered: string[][] = []
    ;(globalThis as unknown as { offered: string[][] }).offered = offered
    dialog.showMessageBox = (...args: unknown[]) => {
      const options = args[args.length - 1] as { buttons: string[] }
      offered.push(options.buttons)
      const index = options.buttons.indexOf(label)
      return Promise.resolve({ response: index, checkboxChecked: false })
    }
  }, answer)
const offered = (app: ElectronApplication): Promise<string[][]> =>
  app.evaluate(() => (globalThis as unknown as { offered: string[][] }).offered)

/** Playwright's Page ends for good with a crash, so ask main what the window shows now. */
const windowShowsApp = (app: ElectronApplication): Promise<boolean> =>
  app.evaluate(async ({ BrowserWindow }) => {
    const contents = BrowserWindow.getAllWindows()[0]?.webContents
    if (!contents || contents.isCrashed() || contents.isLoading()) return false
    const text = (await contents.executeJavaScript('document.body.innerText')) as string
    return text.includes('Workspace chat')
  })

const crashRenderer = (app: ElectronApplication): Promise<void> =>
  app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.webContents.forcefullyCrashRenderer()
  })

/**
 * A window that has just opened can drop its first keys, and a dropped key would make "this key
 * does nothing" pass by itself. Presses a key known to act until it does, then undoes it.
 */
async function waitForKeys(app: ElectronApplication): Promise<void> {
  await expect(async () => {
    await press(app, 'Plus', ['control', 'shift'])
    await expect.poll(() => zoomLevel(app), { timeout: 1000 }).toBeGreaterThan(0)
  }).toPass({ timeout: 20_000 })
  await press(app, '0', ['control'])
  await expect.poll(() => zoomLevel(app)).toBe(0)
}

// Long enough for an accelerator to have acted, in the runs where it does.
const SETTLE_MS = 1000

test.describe('packaged build', () => {
  let launched: Launched
  test.beforeEach(async () => {
    launched = await launch(true)
  })
  test.afterEach(async () => {
    await launched.app.close().catch(() => undefined)
    rmSync(launched.userData, { recursive: true, force: true })
  })

  test('has no key or menu item for reload or developer tools', async () => {
    const { app } = launched
    const page = await app.firstWindow()
    expect(await app.evaluate(({ app: electronApp }) => electronApp.isPackaged)).toBe(true)
    await page.evaluate(() => {
      ;(window as unknown as { marker: number }).marker = 1
    })
    await waitForKeys(app)
    const before = await loads(app)
    const keys: [string, string[]][] = [
      ['R', ['control']],
      ['R', ['control', 'shift']],
      ['F5', []],
      ['F5', ['control']],
      ['I', ['control', 'shift']],
      ['J', ['control', 'shift']],
      ['C', ['control', 'shift']],
      ['F12', []],
    ]
    for (const [key, modifiers] of keys) await press(app, key, modifiers)
    await page.waitForTimeout(SETTLE_MS)

    expect(await loads(app)).toBe(before)
    expect(await page.evaluate(() => (window as unknown as { marker?: number }).marker)).toBe(1)
    expect(await devToolsOpen(app)).toBe(false)
    const roles = await app.evaluate(({ Menu }) =>
      Menu.getApplicationMenu()?.items.flatMap((item) =>
        (item.submenu?.items ?? []).map((sub) => sub.role ?? ''),
      ),
    )
    for (const role of ['reload', 'forcereload', 'toggledevtools'])
      expect(roles).not.toContain(role)
  })

  test('zooms by key, one step at a time', async () => {
    const { app } = launched
    await waitForKeys(app)
    await press(app, 'Plus', ['control', 'shift'])
    await expect.poll(() => zoomLevel(app)).toBe(0.5)
    await press(app, '-', ['control'])
    await expect.poll(() => zoomLevel(app)).toBe(0)
    await press(app, 'Plus', ['control', 'shift'])
    await expect.poll(() => zoomLevel(app)).toBe(0.5)
    await press(app, '0', ['control'])
    await expect.poll(() => zoomLevel(app)).toBe(0)
  })

  test('every zoom-in key steps once, and the menu bar stays hidden until Alt', async () => {
    const { app } = launched
    const page = await app.firstWindow()
    const barVisible = () =>
      app.evaluate(
        ({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isMenuBarVisible() ?? true,
      )
    await waitForKeys(app)
    // Plus is Shift+=, so plain Ctrl+Plus and Ctrl+Shift+Plus are one key on a US keyboard, and
    // Ctrl+= is what a keyboard with its own + key sends as well.
    let level = 0
    const keys: [string, string[]][] = [
      ['=', ['control']],
      ['Plus', ['control']],
      ['Plus', ['control', 'shift']],
      ['numadd', ['control']],
    ]
    for (const [key, modifiers] of keys) {
      await press(app, key, modifiers)
      level += 0.5
      await expect.poll(() => zoomLevel(app)).toBe(level)
      // A second handler would show up after the first.
      await page.waitForTimeout(300)
      expect(await zoomLevel(app)).toBe(level)
      expect(await barVisible()).toBe(false)
    }
    await press(app, '0', ['control'])
    await expect.poll(() => zoomLevel(app)).toBe(0)

    const listed = await app.evaluate(({ Menu }) =>
      Menu.getApplicationMenu()
        ?.items.flatMap((item) => item.submenu?.items ?? [])
        .filter((item) => item.role?.toLowerCase() === 'zoomin' && item.visible)
        .map((item) => item.label),
    )
    expect(listed).toHaveLength(1)

    await press(app, 'Alt', [])
    await expect.poll(barVisible).toBe(true)
  })

  test('Ctrl+N and Ctrl+, reach the page once; the menu items do the same job', async () => {
    const { app } = launched
    const page = await app.firstWindow()
    const settings = page.getByRole('dialog', { name: 'Settings' })

    // A command arriving alongside a key would be the double firing: count them.
    await page.evaluate(() => {
      const state = { commands: 0 }
      ;(window as unknown as { commandsSeen: typeof state }).commandsSeen = state
      ;(
        window as unknown as { desktopApi: { onMenuCommand: (l: () => void) => void } }
      ).desktopApi.onMenuCommand(() => {
        state.commands += 1
      })
    })
    const commands = () =>
      page.evaluate(
        () => (window as unknown as { commandsSeen: { commands: number } }).commandsSeen.commands,
      )

    // A fresh profile: the setup wizard opens. Dialogs hold the menu like they hold the keys.
    const wizard = page.getByRole('dialog', { name: 'Which AI do you want to use?' })
    await expect(wizard).toBeVisible()
    await press(app, ',', ['control'])
    await clickMenuItem(app, 'settings')
    await expect.poll(commands).toBe(1)
    await page.waitForTimeout(200)
    await expect(settings).toBeHidden()
    await wizard.getByRole('button', { name: 'Close' }).click()
    await expect(wizard).toBeHidden()

    // Only the page answers these keys: no menu command came with them.
    await press(app, 'N', ['control'])
    await press(app, ',', ['control'])
    await expect(settings).toBeVisible()
    await press(app, 'Escape', [])
    await expect(settings).toBeHidden()
    expect(await commands()).toBe(1)

    await clickMenuItem(app, 'settings')
    await expect.poll(commands).toBe(2)
    await expect(settings).toBeVisible()
  })

  test('recovers from a renderer crash, and stops offering reload when it keeps crashing', async () => {
    const { app, userData } = launched
    await stubPrompts(app, 'Reload')

    await crashRenderer(app)
    await expect.poll(() => offered(app)).toHaveLength(1)
    expect((await offered(app))[0]).toEqual(['Reload', 'Quit'])
    await expect.poll(() => windowShowsApp(app), { timeout: 15_000 }).toBe(true)

    await crashRenderer(app)
    await expect.poll(() => offered(app)).toHaveLength(2)
    await expect.poll(() => windowShowsApp(app), { timeout: 15_000 }).toBe(true)

    await crashRenderer(app)
    await expect.poll(() => offered(app)).toHaveLength(3)
    expect((await offered(app))[2]).toEqual(['Quit', 'Open logs folder and quit'])

    const log = readFileSync(join(userData, 'logs', 'main.log'), 'utf8')
    expect(log).toContain('starting')
    expect(log).toContain('renderer gone: crashed')
  })

  test('a page that exits normally comes back without asking or logging a crash', async () => {
    const { app, userData } = launched
    await stubPrompts(app, 'Quit')
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.webContents.emit(
        'render-process-gone',
        {},
        { reason: 'clean-exit', exitCode: 0 },
      )
    })
    await expect.poll(() => loads(app)).toBeGreaterThan(0)
    await expect.poll(() => windowShowsApp(app), { timeout: 15_000 }).toBe(true)
    expect(await offered(app)).toEqual([])
    const log = readFileSync(join(userData, 'logs', 'main.log'), 'utf8')
    expect(log).toContain('renderer exited normally (exit code 0)')
    expect(log).not.toContain('renderer gone')
  })

  test('a multi-line string reaches the file as its first line, in any position', async () => {
    const { app, userData } = launched
    const closed = new Promise<void>((resolve) => {
      app.once('close', () => {
        resolve()
      })
    })
    await app.evaluate(({ app: electronApp }) => {
      const prompt = 'first line\nmy private second line\nmy private third line'
      console.info(prompt, 'then', prompt)
      console.info('single line sk-ant-api03-abcDEF123456')
      electronApp.quit()
    })
    await closed
    const log = readFileSync(join(userData, 'logs', 'main.log'), 'utf8')
    expect(log).toContain('first line ...[truncated] then first line ...[truncated]')
    expect(log).toContain('single line [redacted]')
    expect(log).not.toContain('my private')
    expect(log).not.toContain('sk-ant-api03')
  })

  test('offers Reload or Quit when the page hangs, and Reload brings it back', async () => {
    const { app } = launched
    await stubPrompts(app, 'Reload')
    // The hang monitor takes 15-30 s to fire: this checks what happens once it does.
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.webContents.emit('unresponsive')
    })
    await expect.poll(() => offered(app)).toHaveLength(1)
    expect((await offered(app))[0]).toEqual(['Keep waiting', 'Reload', 'Quit'])
    await expect.poll(() => loads(app)).toBeGreaterThan(0)
    await expect.poll(() => windowShowsApp(app), { timeout: 15_000 }).toBe(true)
    // Killing the hung page on the way is not reported as a crash.
    expect(await offered(app)).toHaveLength(1)
  })

  test('an uncaught exception is logged without its secret, reported, and ends the app', async () => {
    const { app, userData } = launched
    const closed = new Promise<void>((resolve) => {
      app.once('close', () => {
        resolve()
      })
    })
    await app.evaluate(({ dialog }) => {
      dialog.showErrorBox = () => undefined
      console.error('a call site logs', { content: 'my private prompt' }, 'sk-ant-api03-abc123456')
      setTimeout(() => {
        throw new Error('boom sk-ant-api03-abcDEF123456')
      }, 0)
    })
    await closed
    const log = readFileSync(join(userData, 'logs', 'main.log'), 'utf8')
    expect(log).toContain('fatal: uncaught exception: Error: boom [redacted]')
    expect(log).toContain('a call site logs { content: [redacted] } [redacted]')
    expect(log).not.toContain('sk-ant-api03')
    expect(log).not.toContain('my private prompt')
  })
})

test('a dev build does have reload and developer tools by key', async () => {
  // Also shows the packaged test's keys are real: the same presses act here.
  const { app, userData } = await launch(false)
  try {
    expect(await app.evaluate(({ app: electronApp }) => electronApp.isPackaged)).toBe(false)
    await press(app, 'R', ['control'])
    await expect.poll(() => loads(app)).toBeGreaterThan(0)
    const page = await app.firstWindow()
    await expect(page.getByRole('heading', { name: 'Workspace chat' })).toBeVisible()
    await press(app, 'I', ['control', 'shift'])
    await expect.poll(() => devToolsOpen(app)).toBe(true)
  } finally {
    await app.close().catch(() => undefined)
    rmSync(userData, { recursive: true, force: true })
  }
})
