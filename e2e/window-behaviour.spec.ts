import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ApprovalPrompt, DesktopApi } from '../src/shared/ipc'

/**
 * The real main bundle (out/main/index.js) in a real window: where it opens and what it
 * remembers, the warning before closing during work, the notification and taskbar flash, and
 * developer tools in an installed build. Each test starts the app on a fresh data folder.
 * Run `pnpm build` first.
 */

const harness = join(__dirname, 'harness/traced-app-main.cjs')
const WINDOWS = process.platform === 'win32'

interface Launched {
  app: ElectronApplication
  page: Page
  userData: string
}

function seedData(options: { settings?: unknown; grants?: string[] } = {}): {
  userData: string
  folder: string
} {
  const userData = mkdtempSync(join(tmpdir(), 'window-behaviour-'))
  // .native: the long form of a Windows 8.3 short name (RUNNER~1), which grants are compared with.
  const folder = realpathSync.native(mkdtempSync(join(tmpdir(), 'window-behaviour-folder-')))
  mkdirSync(userData, { recursive: true })
  if (options.settings !== undefined)
    writeFileSync(join(userData, 'settings.json'), JSON.stringify(options.settings))
  writeFileSync(
    join(userData, 'grants.json'),
    JSON.stringify({ version: 1, roots: options.grants ?? [folder] }),
  )
  return { userData, folder }
}

/** Every app a test started: whatever is still running when it ends (a failure) is killed. */
const started: ElectronApplication[] = []
test.afterEach(() => {
  for (const app of started.splice(0)) {
    try {
      const child = app.process()
      if (child.exitCode === null && child.signalCode === null) {
        // Windows: also the commands it started, or they keep the test run waiting.
        if (WINDOWS && child.pid) execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'])
        else child.kill('SIGKILL')
      }
    } catch {
      // Already closed: the connection is gone with it.
    }
  }
})

async function launch(userData: string, env: Record<string, string> = {}): Promise<Launched> {
  const app = await electron.launch({
    args: [
      ...(process.platform === 'linux' ? ['--no-sandbox'] : []),
      `--user-data-dir=${userData}`,
      harness,
    ],
    cwd: join(__dirname, '..'),
    env: { ...process.env, ...env } as Record<string, string>,
  })
  started.push(app)
  const page = await app.firstWindow()
  await page.waitForFunction(() => 'desktopApi' in window)
  // The page has mounted and listens for approvals (one pushed earlier would find no card).
  await page.locator('textarea').first().waitFor({ state: 'attached' })
  return { app, page, userData }
}

const bounds = (app: ElectronApplication) =>
  app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]
    if (!window) throw new Error('no window')
    return { ...window.getBounds(), maximized: window.isMaximized() }
  })

const workArea = (app: ElectronApplication) =>
  app.evaluate(({ screen }) => screen.getPrimaryDisplay().workArea)

/** Closes the window and waits for the app to end. */
async function closeAndWait(app: ElectronApplication): Promise<void> {
  const closed = app.waitForEvent('close')
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.close()
  })
  await closed
}

const savedWindow = (userData: string): unknown => {
  try {
    return (
      JSON.parse(readFileSync(join(userData, 'settings.json'), 'utf8')) as { windowState?: unknown }
    ).windowState
  } catch {
    return undefined
  }
}

test.describe('window position and size', () => {
  test('opens at 1000x720, centred, when nothing is saved', async () => {
    const { userData } = seedData()
    const { app } = await launch(userData)
    try {
      const area = await workArea(app)
      const win = await bounds(app)
      expect(win).toMatchObject({ width: 1000, height: 720, maximized: false })
      expect(Math.abs(win.x - (area.x + (area.width - 1000) / 2))).toBeLessThanOrEqual(2)
      expect(Math.abs(win.y - (area.y + (area.height - 720) / 2))).toBeLessThanOrEqual(2)
    } finally {
      await app.close()
    }
  })

  test('restores the saved size and position', async () => {
    const { userData } = seedData({
      settings: {
        version: 3,
        windowState: { x: 40, y: 60, width: 900, height: 650, maximized: false },
      },
    })
    const { app } = await launch(userData)
    try {
      expect(await bounds(app)).toMatchObject({ x: 40, y: 60, width: 900, height: 650 })
    } finally {
      await app.close()
    }
  })

  for (const [name, windowState] of [
    [
      'off every display (monitor unplugged)',
      { x: 40_000, y: 30_000, width: 900, height: 650, maximized: false },
    ],
    ['invalid (not numbers)', { x: 'left', y: null, width: 'wide', height: 650, maximized: false }],
    ['absent from an older settings file', undefined],
  ] as const) {
    test(`falls back to the default centred window when the saved bounds are ${name}`, async () => {
      const { userData } = seedData({
        settings: { version: 3, ...(windowState ? { windowState } : {}) },
      })
      const { app } = await launch(userData)
      try {
        const area = await workArea(app)
        const win = await bounds(app)
        expect(win).toMatchObject({ width: 1000, height: 720 })
        expect(Math.abs(win.x - (area.x + (area.width - 1000) / 2))).toBeLessThanOrEqual(2)
      } finally {
        await app.close()
      }
    })
  }

  test('does not open below the minimum size', async () => {
    const { userData } = seedData({
      settings: {
        version: 3,
        windowState: { x: 40, y: 60, width: 120, height: 90, maximized: false },
      },
    })
    const { app } = await launch(userData)
    try {
      expect(await bounds(app)).toMatchObject({ width: 480, height: 400 })
    } finally {
      await app.close()
    }
  })

  test('saves on close, and the next start restores it; older settings are kept', async () => {
    const { userData } = seedData({
      settings: { version: 3, theme: 'dark', model: 'claude-opus-5-5' },
    })
    const first = await launch(userData)
    await first.app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setBounds({ x: 30, y: 50, width: 860, height: 600 })
    })
    // Straight away: before the debounce could have fired, so only the close flush saves it.
    await closeAndWait(first.app)
    expect(savedWindow(userData)).toEqual({
      x: 30,
      y: 50,
      width: 860,
      height: 600,
      maximized: false,
    })
    const file = JSON.parse(readFileSync(join(userData, 'settings.json'), 'utf8')) as Record<
      string,
      unknown
    >
    expect(file).toMatchObject({ theme: 'dark', model: 'claude-opus-5-5' })

    const second = await launch(userData)
    try {
      expect(await bounds(second.app)).toMatchObject({ x: 30, y: 50, width: 860, height: 600 })
    } finally {
      await second.app.close()
    }
  })

  test('saves a move shortly after it happens, without closing', async () => {
    const { userData } = seedData()
    const { app } = await launch(userData)
    try {
      await app.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows()[0]?.setBounds({ x: 70, y: 80, width: 800, height: 590 })
      })
      await expect
        .poll(() => savedWindow(userData), { timeout: 10_000 })
        .toEqual({
          x: 70,
          y: 80,
          width: 800,
          height: 590,
          maximized: false,
        })
    } finally {
      await app.close()
    }
  })

  test('remembers a maximized window and its restored size', async () => {
    test.skip(!WINDOWS, 'needs a window manager: Linux CI runs without one')
    const { userData } = seedData({
      settings: {
        version: 3,
        windowState: { x: 50, y: 50, width: 900, height: 640, maximized: true },
      },
    })
    const { app } = await launch(userData)
    try {
      expect((await bounds(app)).maximized).toBe(true)
      await closeAndWait(app)
      expect(savedWindow(userData)).toMatchObject({ width: 900, height: 640, maximized: true })
    } finally {
      await app.close().catch(() => undefined)
    }
  })
})

interface Probe {
  dialogs: {
    message: string
    detail: string
    buttons: string[]
    defaultId: number
    cancelId: number
  }[]
}

/** Replaces the native message box in main: records it and answers as the test says. */
async function stubDialog(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ dialog }) => {
    const probe: { dialogs: unknown[]; answer: number; hold: (() => void) | null; held: boolean } =
      {
        dialogs: [],
        answer: 0,
        hold: null,
        held: false,
      }
    ;(globalThis as Record<string, unknown>)['__probe'] = probe
    dialog.showMessageBox = ((options: Record<string, unknown>) => {
      probe.dialogs.push(options)
      if (probe.held)
        return new Promise((resolve) => {
          probe.hold = () => {
            resolve({ response: probe.answer, checkboxChecked: false })
          }
        })
      return Promise.resolve({ response: probe.answer, checkboxChecked: false })
    }) as unknown as typeof dialog.showMessageBox
  })
}

/** Ends an app that still has work in it: the warning is answered "Stop and quit". */
async function endApp(app: ElectronApplication): Promise<void> {
  await stubDialog(app)
  await answerWith(app, 1)
  await app.close()
}

const dialogs = (app: ElectronApplication): Promise<Probe['dialogs']> =>
  app.evaluate(() => (globalThis as unknown as { __probe: Probe }).__probe.dialogs)
const answerWith = (app: ElectronApplication, answer: number, held = false): Promise<void> =>
  app.evaluate(
    (_electron, args) => {
      const probe = (globalThis as unknown as { __probe: { answer: number; held: boolean } })
        .__probe
      probe.answer = args.answer
      probe.held = args.held
    },
    { answer, held },
  )
const requestClose = (app: ElectronApplication): Promise<void> =>
  app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.close()
  })
const windowCount = (app: ElectronApplication): Promise<number> =>
  app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)

/** Collects approval prompts in the page, and starts a typed command. */
async function startCommand(page: Page, command: string, cwd: string): Promise<ApprovalPrompt> {
  await page.evaluate(() => {
    const api = (window as unknown as { desktopApi: DesktopApi }).desktopApi
    const seen: ApprovalPrompt[] = []
    const events: string[] = []
    ;(window as unknown as { __approvals: ApprovalPrompt[] }).__approvals = seen
    ;(window as unknown as { __events: string[] }).__events = events
    api.onApprovalRequest((prompt) => seen.push(prompt))
    // Kept for the failure message: what the chat said if no approval came.
    api.onChatEvent((event) => {
      events.push(
        event.type === 'tool_result' ? `${event.type}: ${event.content.slice(0, 200)}` : event.type,
      )
    })
  })
  const sent = await page.evaluate(
    ([text, folder]) =>
      (window as unknown as { desktopApi: DesktopApi }).desktopApi.command.run(
        text as string,
        folder as string,
      ),
    [command, cwd],
  )
  expect(sent).toEqual({ ok: true })
  try {
    await expect
      .poll(
        () =>
          page.evaluate(() => (window as unknown as { __approvals: unknown[] }).__approvals.length),
        { timeout: 15_000 },
      )
      .toBe(1)
  } catch (error) {
    const events = await page.evaluate(() => (window as unknown as { __events: string[] }).__events)
    throw new Error(
      `no approval for the command (folder ${cwd}); chat events: ${JSON.stringify(events)}`,
      { cause: error },
    )
  }
  return page.evaluate(
    () => (window as unknown as { __approvals: ApprovalPrompt[] }).__approvals[0] as ApprovalPrompt,
  )
}

/**
 * Whether the command that wrote its process id to `file` in `folder` is still alive. The
 * command writes the id itself, so this is the same on every platform and needs no process
 * listing (the shell that runs it may be a different process from the one that sleeps).
 */
const running = (folder: string, file: string): boolean => {
  try {
    const pid = Number(readFileSync(join(folder, file), 'utf8').trim())
    if (!Number.isInteger(pid) || pid <= 0) return false
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

test.describe('warning before closing during work', () => {
  /** Writes its own process id to `file` (in the granted folder), then sleeps 40 seconds. */
  const sleep = (file: string): string =>
    WINDOWS
      ? `$pid | Set-Content -NoNewline ${file}; Start-Sleep -Seconds 40`
      : `echo $$ > ${file}; sleep 40`

  test('no prompt when idle: the window just closes', async () => {
    const { userData } = seedData()
    const { app } = await launch(userData)
    await stubDialog(app)
    const closed = app.waitForEvent('close')
    await requestClose(app)
    await closed
  })

  test('Cancel keeps the app and the open approval; stopping denies it and quits', async () => {
    const { userData, folder } = seedData()
    const marker = `pid-deny-${String(Date.now())}.txt`
    const { app, page } = await launch(userData)
    await stubDialog(app)
    await startCommand(page, sleep(marker), folder)

    await requestClose(app) // Cancel is answer 0
    await expect.poll(async () => (await dialogs(app)).length).toBe(1)
    const [dialog] = await dialogs(app)
    expect(dialog).toMatchObject({
      buttons: ['Cancel', 'Stop and quit'],
      defaultId: 0,
      cancelId: 0,
    })
    expect(dialog?.detail).toContain('an approval that is waiting for your answer')
    // Nothing from the command is in the dialog.
    expect(JSON.stringify(dialog)).not.toContain(marker)
    await new Promise((resolve) => setTimeout(resolve, 500))
    expect(await windowCount(app)).toBe(1)
    expect(running(folder, marker)).toBe(false)

    await answerWith(app, 1)
    const closed = app.waitForEvent('close')
    await requestClose(app)
    await closed
    // The approval was denied on the way out, so the command never started.
    expect(running(folder, marker)).toBe(false)
  })

  test('a running command is named, and is stopped when the user confirms', async () => {
    const { userData, folder } = seedData()
    const marker = `pid-run-${String(Date.now())}.txt`
    const { app, page } = await launch(userData)
    await stubDialog(app)
    const prompt = await startCommand(page, sleep(marker), folder)
    await page.evaluate(
      (id) =>
        (window as unknown as { desktopApi: DesktopApi }).desktopApi.approvals.respond(id, true),
      prompt.id,
    )
    await expect.poll(() => running(folder, marker), { timeout: 15_000 }).toBe(true)

    // First Cancel: the dialog names the command, and the command keeps running.
    await requestClose(app)
    await expect.poll(async () => (await dialogs(app)).length).toBe(1)
    expect((await dialogs(app))[0]?.detail).toContain('a command that is still running')
    expect(JSON.stringify(await dialogs(app))).not.toContain(marker)
    await new Promise((resolve) => setTimeout(resolve, 500))
    expect(await windowCount(app)).toBe(1)
    expect(running(folder, marker)).toBe(true)

    // Then confirm: the app ends and takes the command's process with it.
    await answerWith(app, 1)
    const closed = app.waitForEvent('close')
    await requestClose(app)
    await closed
    await expect.poll(() => running(folder, marker), { timeout: 15_000 }).toBe(false)
  })

  test('the prompt never shows twice when closed and quit repeatedly while it is open', async () => {
    const { userData, folder } = seedData()
    const { app, page } = await launch(userData)
    await stubDialog(app)
    await startCommand(page, sleep(`pid-twice-${String(Date.now())}.txt`), folder)
    await answerWith(app, 0, true) // the dialog stays open until released
    await requestClose(app)
    await requestClose(app)
    await app.evaluate(({ app: electronApp }) => {
      electronApp.quit()
    })
    await requestClose(app)
    await new Promise((resolve) => setTimeout(resolve, 600))
    expect(await dialogs(app)).toHaveLength(1)
    expect(await windowCount(app)).toBe(1)
    // Release it as Cancel: still running, and closing asks again, once.
    await app.evaluate(() => {
      ;(globalThis as unknown as { __probe: { hold: () => void } }).__probe.hold()
    })
    await answerWith(app, 1)
    const closed = app.waitForEvent('close')
    await requestClose(app)
    await closed
  })
})

test.describe('the warning together with the app menu and crash recovery', () => {
  const sleep = (file: string): string =>
    WINDOWS
      ? `$pid | Set-Content -NoNewline ${file}; Start-Sleep -Seconds 40`
      : `echo $$ > ${file}; sleep 40`

  interface DialogProbe {
    shown: string[][]
    answers: string[]
    holding: string[]
    aborted: string[][]
  }
  const probe = () => (globalThis as unknown as { __quit: DialogProbe }).__quit

  /**
   * Replaces the native message box. A box is answered with the first of `answers` it offers, or
   * left open if it offers one of `holding`, until its signal takes it down, as a real one does.
   * Each box is logged too: the log outlives the app, which is gone by the time some tests check.
   */
  async function stubBoxes(app: ElectronApplication, answers: string[]): Promise<void> {
    await app.evaluate(({ dialog }, labels) => {
      const state: DialogProbe = { shown: [], answers: labels, holding: [], aborted: [] }
      ;(globalThis as unknown as { __quit: DialogProbe }).__quit = state
      dialog.showMessageBox = ((...args: unknown[]) => {
        const options = args[args.length - 1] as {
          buttons: string[]
          cancelId: number
          signal?: AbortSignal
        }
        state.shown.push(options.buttons)
        console.info(`test box: ${options.buttons.join(' / ')}`)
        if (options.buttons.some((button) => state.holding.includes(button)))
          return new Promise((resolve) => {
            options.signal?.addEventListener('abort', () => {
              state.aborted.push(options.buttons)
              resolve({ response: options.cancelId, checkboxChecked: false })
            })
          })
        const response = options.buttons.findIndex((button) => state.answers.includes(button))
        return Promise.resolve({
          response: response < 0 ? options.cancelId : response,
          checkboxChecked: false,
        })
      }) as unknown as typeof dialog.showMessageBox
    }, answers)
  }
  const answerBoxes = (app: ElectronApplication, labels: string[]): Promise<void> =>
    app.evaluate((_electron, next) => {
      ;(globalThis as unknown as { __quit: DialogProbe }).__quit.answers = next
    }, labels)
  const holdBoxes = (app: ElectronApplication, labels: string[]): Promise<void> =>
    app.evaluate((_electron, next) => {
      ;(globalThis as unknown as { __quit: DialogProbe }).__quit.holding = next
    }, labels)
  const boxes = (app: ElectronApplication): Promise<DialogProbe> => app.evaluate(probe)
  const logOf = (userData: string): string =>
    readFileSync(join(userData, 'logs', 'main.log'), 'utf8')

  const WARNING = ['Cancel', 'Stop and quit']
  const CRASHED = ['Reload', 'Quit']
  const HUNG = ['Keep waiting', 'Reload', 'Quit']

  /** The real item in the File menu, clicked the way the menu does. */
  const fileQuit = (app: ElectronApplication): Promise<void> =>
    app.evaluate(({ BrowserWindow, Menu }) => {
      const window = BrowserWindow.getAllWindows()[0]
      const item = Menu.getApplicationMenu()
        ?.items.flatMap((top) => top.submenu?.items ?? [])
        .find((sub) => sub.role?.toLowerCase() === 'quit')
      if (!item) throw new Error('no Quit in the menu')
      ;(item as unknown as { click: (...args: unknown[]) => void }).click(
        undefined,
        window,
        window?.webContents,
      )
    })
  const crashPage = (app: ElectronApplication): Promise<void> =>
    app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.webContents.forcefullyCrashRenderer()
    })
  /** The page is up again. Playwright's Page ends with a crash, so this asks main. */
  const pageIsBack = (app: ElectronApplication): Promise<boolean> =>
    app.evaluate(async ({ BrowserWindow }) => {
      const contents = BrowserWindow.getAllWindows()[0]?.webContents
      if (!contents || contents.isCrashed() || contents.isLoading()) return false
      return (await contents.executeJavaScript("'desktopApi' in window")) as boolean
    })
  const emitOnPage = (app: ElectronApplication, event: 'unresponsive' | 'responsive') =>
    app.evaluate(({ BrowserWindow }, name) => {
      BrowserWindow.getAllWindows()[0]?.webContents.emit(name)
    }, event)

  /** The app, with an approval waiting: work is active until someone answers it. */
  async function withWork(name: string) {
    const { userData, folder } = seedData()
    const launched = await launch(userData)
    await stubBoxes(launched.app, ['Cancel'])
    const prompt = await startCommand(
      launched.page,
      sleep(`pid-${name}-${String(Date.now())}.txt`),
      folder,
    )
    return { ...launched, folder, prompt }
  }

  test('File > Quit warns during work: Cancel keeps the app, Stop and quit ends it', async () => {
    const { app } = await withWork('file-quit')
    await fileQuit(app)
    await expect.poll(async () => (await boxes(app)).shown).toEqual([WARNING])
    await new Promise((resolve) => setTimeout(resolve, 500))
    expect(await windowCount(app)).toBe(1)

    await answerBoxes(app, ['Stop and quit'])
    const closed = app.waitForEvent('close')
    await fileQuit(app)
    await closed
  })

  test('File > Quit does not warn when idle', async () => {
    const { userData } = seedData()
    const { app } = await launch(userData)
    await stubBoxes(app, ['Cancel'])
    const closed = app.waitForEvent('close')
    await fileQuit(app)
    await closed
    expect(logOf(userData)).not.toContain('test box')
  })

  test('a crash after a cancelled warning still gets the recovery prompt', async () => {
    const { app, userData } = await withWork('cancel-crash')
    await fileQuit(app)
    await expect.poll(async () => (await boxes(app)).shown).toEqual([WARNING])

    await answerBoxes(app, ['Cancel', 'Reload'])
    await crashPage(app)
    await expect.poll(async () => (await boxes(app)).shown).toEqual([WARNING, CRASHED])
    await expect.poll(() => pageIsBack(app), { timeout: 15_000 }).toBe(true)
    expect(logOf(userData)).toContain('recovery (crashed): reload')
    await endApp(app)
  })

  test('a normal exit after a cancelled warning reloads; a clean quit then works', async () => {
    const { app, userData } = await withWork('cancel-clean-exit')
    await fileQuit(app)
    await expect.poll(async () => (await boxes(app)).shown).toEqual([WARNING])
    await app.evaluate(({ BrowserWindow }) => {
      const contents = BrowserWindow.getAllWindows()[0]?.webContents
      ;(globalThis as Record<string, unknown>)['__loads'] = 0
      contents?.on('did-start-loading', () => {
        ;(globalThis as unknown as { __loads: number }).__loads += 1
      })
      contents?.emit('render-process-gone', {}, { reason: 'clean-exit', exitCode: 0 })
    })
    await expect
      .poll(() => app.evaluate(() => (globalThis as unknown as { __loads: number }).__loads))
      .toBeGreaterThan(0)
    await expect.poll(() => pageIsBack(app), { timeout: 15_000 }).toBe(true)

    // The reload ended the work, so this quit has nothing to ask about.
    const closed = app.waitForEvent('close')
    await fileQuit(app)
    await closed
    expect(logOf(userData).match(/test box/g)).toHaveLength(1)
  })

  test('a clean quit works after a cancelled warning and the work finishing', async () => {
    const { app, page, userData, prompt } = await withWork('cancel-quit')
    await fileQuit(app)
    await expect.poll(async () => (await boxes(app)).shown).toEqual([WARNING])

    await page.evaluate(
      (id) =>
        (window as unknown as { desktopApi: DesktopApi }).desktopApi.approvals.respond(id, false),
      prompt.id,
    )
    await new Promise((resolve) => setTimeout(resolve, 500))
    const closed = app.waitForEvent('close')
    await fileQuit(app)
    await closed
    expect(logOf(userData).match(/test box/g)).toHaveLength(1)
  })

  test('a fatal error with a command running quits without the warning, and stops it', async () => {
    const { userData, folder } = seedData()
    const marker = `pid-fatal-${String(Date.now())}.txt`
    const { app, page } = await launch(userData)
    await stubBoxes(app, ['Cancel'])
    const prompt = await startCommand(page, sleep(marker), folder)
    await page.evaluate(
      (id) =>
        (window as unknown as { desktopApi: DesktopApi }).desktopApi.approvals.respond(id, true),
      prompt.id,
    )
    await expect.poll(() => running(folder, marker), { timeout: 15_000 }).toBe(true)

    const closed = app.waitForEvent('close')
    await app.evaluate(({ dialog }) => {
      dialog.showErrorBox = () => undefined
      setTimeout(() => {
        throw new Error('boom')
      }, 0)
    })
    await closed
    const log = logOf(userData)
    expect(log).toContain('fatal: uncaught exception')
    expect(log).not.toContain('test box')
    await expect.poll(() => running(folder, marker), { timeout: 15_000 }).toBe(false)
  })

  test('crash-recovery Quit with a command running quits without the warning', async () => {
    const { userData, folder } = seedData()
    const marker = `pid-recover-${String(Date.now())}.txt`
    const { app, page } = await launch(userData)
    await stubBoxes(app, ['Cancel'])
    const prompt = await startCommand(page, sleep(marker), folder)
    await page.evaluate(
      (id) =>
        (window as unknown as { desktopApi: DesktopApi }).desktopApi.approvals.respond(id, true),
      prompt.id,
    )
    await expect.poll(() => running(folder, marker), { timeout: 15_000 }).toBe(true)

    await answerBoxes(app, ['Quit'])
    const closed = app.waitForEvent('close')
    await crashPage(app)
    await closed
    const log = logOf(userData)
    expect(log).toContain('recovery (crashed): quit')
    expect(log).toContain(`test box: ${CRASHED.join(' / ')}`)
    expect(log).not.toContain(`test box: ${WARNING.join(' / ')}`)
    await expect.poll(() => running(folder, marker), { timeout: 15_000 }).toBe(false)
  })

  test('a crash while the warning is up takes it down: one question at a time', async () => {
    const { app } = await withWork('stack-crash')
    await holdBoxes(app, ['Cancel'])
    await fileQuit(app)
    await expect.poll(async () => (await boxes(app)).shown).toEqual([WARNING])

    await answerBoxes(app, ['Reload'])
    await crashPage(app)
    await expect.poll(async () => (await boxes(app)).shown).toEqual([WARNING, CRASHED])
    expect((await boxes(app)).aborted).toEqual([WARNING])
    await expect.poll(() => pageIsBack(app), { timeout: 15_000 }).toBe(true)
    expect(await windowCount(app)).toBe(1)
    await endApp(app)
  })

  test('a hang prompt replaces the warning, and the guard works once the page recovers', async () => {
    const { app } = await withWork('stack-hang')
    await holdBoxes(app, ['Cancel', 'Keep waiting'])
    await fileQuit(app)
    await expect.poll(async () => (await boxes(app)).shown).toEqual([WARNING])

    await emitOnPage(app, 'unresponsive')
    await expect.poll(async () => (await boxes(app)).shown).toEqual([WARNING, HUNG])
    expect((await boxes(app)).aborted).toEqual([WARNING])
    await emitOnPage(app, 'responsive')
    await expect.poll(async () => (await boxes(app)).aborted).toEqual([WARNING, HUNG])

    await holdBoxes(app, [])
    await fileQuit(app)
    await expect.poll(async () => (await boxes(app)).shown).toEqual([WARNING, HUNG, WARNING])
    expect(await windowCount(app)).toBe(1)
    await endApp(app)
  })

  test('an open About box does not get in the way of the warning or the quit', async () => {
    const { app } = await withWork('about')
    await holdBoxes(app, ['OK'])
    await app.evaluate(({ BrowserWindow, Menu }) => {
      const window = BrowserWindow.getAllWindows()[0]
      Menu.getApplicationMenu()
        ?.getMenuItemById('about')
        ?.click(undefined, window, window?.webContents)
    })
    await expect.poll(async () => (await boxes(app)).shown).toEqual([['OK']])

    await fileQuit(app)
    await expect.poll(async () => (await boxes(app)).shown).toEqual([['OK'], WARNING])
    expect(await windowCount(app)).toBe(1)

    await answerBoxes(app, ['Stop and quit'])
    const closed = app.waitForEvent('close')
    await fileQuit(app)
    await closed
  })
})

test.describe('notifications and taskbar flash', () => {
  /** Records what main would show or flash, and chooses whether the window is "focused". */
  async function probeAlerts(app: ElectronApplication, focused: boolean): Promise<void> {
    await app.evaluate(({ BrowserWindow, Notification }, isFocused) => {
      const window = BrowserWindow.getAllWindows()[0]
      if (!window) throw new Error('no window')
      const probe = {
        shown: [] as { title: string; body: string }[],
        flashes: [] as boolean[],
        focusCalls: 0,
      }
      ;(globalThis as Record<string, unknown>)['__alerts'] = probe
      window.isFocused = () => isFocused
      // A Linux test machine has no notification service, so it would say "unsupported".
      Notification.isSupported = () => true
      window.flashFrame = (flash: boolean) => {
        probe.flashes.push(flash)
      }
      const focus = window.focus.bind(window)
      window.focus = () => {
        probe.focusCalls += 1
        focus()
      }
      Notification.prototype.show = function (this: Electron.Notification) {
        probe.shown.push({ title: this.title, body: this.body })
        ;(globalThis as Record<string, unknown>)['__lastNotification'] = this
      }
    }, focused)
  }
  const alerts = (app: ElectronApplication) =>
    app.evaluate(
      () =>
        (
          globalThis as unknown as {
            __alerts: {
              shown: { title: string; body: string }[]
              flashes: boolean[]
              focusCalls: number
            }
          }
        ).__alerts,
    )

  test('an approval behind the window shows fixed text, flashes, and clicking only focuses', async () => {
    const { userData, folder } = seedData()
    const secret = `secret-file-${String(Date.now())}.txt`
    const { app, page } = await launch(userData)
    await probeAlerts(app, false)
    await startCommand(page, WINDOWS ? `Get-Content ${secret}` : `cat ${secret}`, folder)
    await expect.poll(async () => (await alerts(app)).shown.length).toBe(1)
    const seen = await alerts(app)
    expect(seen.shown[0]).toEqual({
      title: 'Desktop Agent',
      body: 'An approval is waiting for your answer.',
    })
    expect(JSON.stringify(seen)).not.toContain(secret)
    expect(JSON.stringify(seen)).not.toContain(folder)
    // The window may also really gain focus on the test display: only the flash on counts.
    expect(seen.flashes.filter(Boolean)).toEqual([true])

    // Clicking the notification brings the window back and answers nothing.
    await app.evaluate(() => {
      ;(
        globalThis as unknown as { __lastNotification: { emit: (e: string) => void } }
      ).__lastNotification.emit('click')
    })
    expect((await alerts(app)).focusCalls).toBe(1)
    const pending = await page.evaluate(
      () => (window as unknown as { __approvals: unknown[] }).__approvals.length,
    )
    expect(pending).toBe(1)
    // Still unanswered: nothing was approved or denied, and no command ran.
    const events = await page.evaluate(() => (window as unknown as { __events: string[] }).__events)
    expect(events).not.toContain('approval_closed')
    expect(events.some((event) => event.startsWith('tool_result'))).toBe(false)

    // Focus stops the flashing; the same approval is not announced again.
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.emit('focus')
    })
    const after = (await alerts(app)).flashes
    expect(after.filter(Boolean)).toEqual([true])
    expect(after.at(-1)).toBe(false)
    expect((await alerts(app)).shown).toHaveLength(1)
    await endApp(app)
  })

  test('nothing while the window is in front', async () => {
    const { userData, folder } = seedData()
    const { app, page } = await launch(userData)
    await probeAlerts(app, true)
    await startCommand(page, WINDOWS ? 'Get-Date' : 'date', folder)
    await new Promise((resolve) => setTimeout(resolve, 600))
    const quiet = await alerts(app)
    expect(quiet.shown).toEqual([])
    expect(quiet.flashes).not.toContain(true)
    await endApp(app)
  })

  test('the Settings toggle turns it off for good, and is saved', async () => {
    const { userData, folder } = seedData()
    const { app, page } = await launch(userData)
    await probeAlerts(app, false)
    const saved = await page.evaluate(() =>
      (window as unknown as { desktopApi: DesktopApi }).desktopApi.notifications.set(false),
    )
    expect(saved).toBe(false)
    expect(JSON.parse(readFileSync(join(userData, 'settings.json'), 'utf8'))).toMatchObject({
      notifications: false,
    })
    await startCommand(page, WINDOWS ? 'Get-Date' : 'date', folder)
    await new Promise((resolve) => setTimeout(resolve, 600))
    const quiet = await alerts(app)
    expect(quiet.shown).toEqual([])
    expect(quiet.flashes).not.toContain(true)
    await endApp(app)
  })

  test('a typed command that finishes does not notify', async () => {
    const { userData, folder } = seedData()
    const { app, page } = await launch(userData)
    await probeAlerts(app, false)
    const prompt = await startCommand(page, WINDOWS ? 'Get-Date' : 'date', folder)
    await expect.poll(async () => (await alerts(app)).shown.length).toBe(1) // the approval
    await page.evaluate(
      (id) =>
        (window as unknown as { desktopApi: DesktopApi }).desktopApi.approvals.respond(id, true),
      prompt.id,
    )
    await new Promise((resolve) => setTimeout(resolve, 1500))
    expect((await alerts(app)).shown).toHaveLength(1)
    await endApp(app)
  })
})

test.describe('developer tools', () => {
  test('stay available in a development build', async () => {
    const { userData } = seedData()
    const { app } = await launch(userData)
    try {
      const opened = await app.evaluate(async ({ BrowserWindow }) => {
        const contents = BrowserWindow.getAllWindows()[0]?.webContents
        if (!contents) throw new Error('no window')
        contents.openDevTools({ mode: 'detach' })
        await new Promise((resolve) => setTimeout(resolve, 800))
        return contents.isDevToolsOpened()
      })
      expect(opened).toBe(true)
    } finally {
      await app.close()
    }
  })

  test('are off in a packaged build, even when asked for', async () => {
    const { userData } = seedData()
    const { app } = await launch(userData, { E2E_PACKAGED: '1' })
    try {
      expect(await app.evaluate(({ app: electronApp }) => electronApp.isPackaged)).toBe(true)
      const opened = await app.evaluate(async ({ BrowserWindow }) => {
        const contents = BrowserWindow.getAllWindows()[0]?.webContents
        if (!contents) throw new Error('no window')
        contents.openDevTools({ mode: 'detach' })
        await new Promise((resolve) => setTimeout(resolve, 800))
        return contents.isDevToolsOpened()
      })
      expect(opened).toBe(false)
    } finally {
      await app.close()
    }
  })
})
