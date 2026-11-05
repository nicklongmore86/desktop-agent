import { _electron as electron, expect, test } from '@playwright/test'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * A second copy of the real app must end before it touches the first one's data. The harness
 * (harness/traced-app-main.cjs) records every app.getPath() call: the app asks for its data
 * folder only when it is about to open grants, settings, history and the audit log.
 */

// In plain Node (as here) the electron package's export is the path of the binary.
const electronBinary = createRequire(__filename)('electron') as string
const harness = join(__dirname, 'harness/traced-app-main.cjs')
const baseArgs = (userData: string): string[] => [
  ...(process.platform === 'linux' ? ['--no-sandbox'] : []),
  `--user-data-dir=${userData}`,
  harness,
]
const read = (file: string): string => (existsSync(file) ? readFileSync(file, 'utf8') : '')

test('a second copy exits before any data access, and the first restores and focuses its window', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'single-instance-'))
  const userData = join(dir, 'data')
  const firstTrace = join(dir, 'first.trace')
  const secondTrace = join(dir, 'second.trace')
  const first = await electron.launch({
    args: baseArgs(userData),
    cwd: join(__dirname, '..'),
    env: { ...process.env, E2E_TRACE_FILE: firstTrace },
  })
  try {
    const page = await first.firstWindow()
    await page.waitForFunction(() => 'desktopApi' in window)
    expect(read(firstTrace)).toContain('getPath:userData')
    const log = join(userData, 'logs', 'main.log')
    const startLines = () =>
      read(log)
        .split('\n')
        .filter((line) => line.includes(' starting '))
    await expect.poll(() => startLines().length).toBe(1)

    // The first copy's window is minimized and hidden from focus; count what it is asked to do.
    await first.evaluate(({ BrowserWindow, app }) => {
      const window = BrowserWindow.getAllWindows()[0]
      if (!window) throw new Error('no window')
      const seen = { restore: 0, focus: 0, second: 0 }
      ;(globalThis as Record<string, unknown>)['__seen'] = seen
      const restore = window.restore.bind(window)
      const focus = window.focus.bind(window)
      window.restore = () => {
        seen.restore += 1
        restore()
      }
      window.focus = () => {
        seen.focus += 1
        focus()
      }
      window.isMinimized = () => true
      app.on('second-instance', () => {
        seen.second += 1
      })
    })

    const second = spawn(electronBinary, baseArgs(userData), {
      cwd: join(__dirname, '..'),
      env: { ...process.env, E2E_TRACE_FILE: secondTrace },
      stdio: 'ignore',
    })
    const exit = await new Promise<{ code: number | null; signal: string | null }>(
      (resolve, reject) => {
        const timer = setTimeout(() => {
          second.kill('SIGKILL')
          reject(new Error('the second copy did not exit within 20 s'))
        }, 20_000)
        second.on('exit', (code, signal) => {
          clearTimeout(timer)
          resolve({ code, signal })
        })
      },
    )
    expect(exit).toEqual({ code: 0, signal: null })
    // It never reached the code that opens the app's data, logs or settings.
    expect(read(secondTrace)).toContain('started')
    // Its diagnostics never started: the log still has only the first copy's start.
    expect(startLines()).toHaveLength(1)
    expect(read(secondTrace)).not.toContain('getPath')

    // The first copy was told, restored its minimized window and focused it.
    await expect
      .poll(() => first.evaluate(() => (globalThis as Record<string, unknown>)['__seen']))
      .toEqual({ restore: 1, focus: 1, second: 1 })
    expect(await first.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(
      1,
    )
  } finally {
    await first.close()
  }
})
