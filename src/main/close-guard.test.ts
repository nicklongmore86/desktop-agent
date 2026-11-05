import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  closeWarning,
  createCloseGuard,
  isIdle,
  type Activity,
  type CloseWarning,
} from './close-guard'

const IDLE: Activity = { run: null, approvals: 0 }

describe('closeWarning', () => {
  it('names each kind of work that will stop, with Cancel as the default', () => {
    const warning = closeWarning({ run: 'reply', approvals: 2 })
    expect(warning.detail).toContain('a reply that is still being written')
    expect(warning.detail).toContain('2 approvals that are waiting for your answer')
    expect(warning.buttons).toEqual(['Cancel', 'Stop and quit'])
    expect(warning.defaultId).toBe(0)
    expect(warning.cancelId).toBe(0)
  })

  it.each([
    [{ run: 'command', approvals: 0 }, 'a command that is still running'],
    [{ run: 'action', approvals: 0 }, 'a file action that is still running'],
    [{ run: null, approvals: 1 }, 'an approval that is waiting for your answer'],
  ] as const)('says what is running for %j', (activity, text) => {
    expect(closeWarning(activity).detail).toContain(text)
  })

  it('is idle only with no run and no approval', () => {
    expect(isIdle(IDLE)).toBe(true)
    expect(isIdle({ run: 'reply', approvals: 0 })).toBe(false)
    expect(isIdle({ run: null, approvals: 1 })).toBe(false)
  })
})

class FakeApp extends EventEmitter {
  quit = vi.fn(() => {
    // Like Electron: before-quit first; the quit goes ahead unless it was prevented.
    const event = { prevented: false, preventDefault: () => (event.prevented = true) }
    this.emit('before-quit', event)
    if (!event.prevented) this.quitCompleted = true
  })
  quitCompleted = false
  override prependListener(name: string, listener: (event: never) => void): this {
    return super.prependListener(name, listener as (...args: unknown[]) => void)
  }
}

class FakeWindow extends EventEmitter {
  destroyed = false
  closes = 0
  isDestroyed = () => this.destroyed
  /** A close request: the close event first, then the window really closes unless prevented. */
  close = () => {
    this.closes += 1
    const event = { prevented: false, preventDefault: () => (event.prevented = true) }
    this.emit('close', event)
    if (!event.prevented) this.destroyed = true
    return event.prevented
  }
}

function setup(
  options: {
    activity?: () => Activity
    confirm?: (warning: CloseWarning, signal: AbortSignal) => Promise<boolean>
    stopWork?: () => Promise<void>
    flushState?: () => Promise<void>
    skipPrompt?: () => boolean
    timeoutMs?: number
  } = {},
) {
  const app = new FakeApp()
  const window = new FakeWindow()
  const calls: string[] = []
  const deps = {
    app,
    activity: options.activity ?? (() => IDLE),
    confirm: vi.fn(options.confirm ?? (() => Promise.resolve(true))),
    stopWork: vi.fn(
      options.stopWork ??
        (() => {
          calls.push('stop')
          return Promise.resolve()
        }),
    ),
    flushState: vi.fn(
      options.flushState ??
        (() => {
          calls.push('flush')
          return Promise.resolve()
        }),
    ),
    skipPrompt: options.skipPrompt ?? (() => false),
    timeoutMs: options.timeoutMs ?? 50,
    onError: vi.fn(),
  }
  const guard = createCloseGuard(deps)
  guard.attach(window)
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 100; i++) await Promise.resolve()
  }
  return { app, window, deps, guard, calls, settle }
}

describe('createCloseGuard', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('closes with no prompt when idle, after saving the window state', async () => {
    const { window, deps, calls, settle } = setup()
    expect(window.close()).toBe(true) // held while the state is written
    await settle()
    expect(deps.confirm).not.toHaveBeenCalled()
    expect(calls).toEqual(['flush'])
    expect(window.destroyed).toBe(true)
  })

  it('quits with no prompt when idle', async () => {
    const { app, deps, settle } = setup()
    app.quit()
    await settle()
    expect(deps.confirm).not.toHaveBeenCalled()
    expect(deps.stopWork).toHaveBeenCalledTimes(1) // what quitting always did
  })

  it.each([
    { run: 'reply', approvals: 0 },
    { run: 'command', approvals: 0 },
    { run: 'action', approvals: 0 },
    { run: null, approvals: 1 },
  ] as const)('asks before a close while %j', async (activity) => {
    const { window, deps, settle } = setup({ activity: () => activity })
    expect(window.close()).toBe(true)
    await settle()
    expect(deps.confirm).toHaveBeenCalledTimes(1)
    expect(deps.confirm.mock.calls[0]?.[0].defaultId).toBe(0)
  })

  it('on Cancel: stops nothing, keeps the window, and asks again next time', async () => {
    const { window, deps, settle } = setup({
      activity: () => ({ run: 'reply', approvals: 1 }),
      confirm: () => Promise.resolve(false),
    })
    window.close()
    await settle()
    expect(deps.stopWork).not.toHaveBeenCalled()
    expect(window.destroyed).toBe(false)
    window.close()
    await settle()
    expect(deps.confirm).toHaveBeenCalledTimes(2)
  })

  it('on confirm: stops the work and saves the state first, then closes', async () => {
    const { window, calls, settle } = setup({ activity: () => ({ run: 'reply', approvals: 1 }) })
    window.close()
    await settle()
    expect(calls).toEqual(['stop', 'flush'])
    expect(window.destroyed).toBe(true)
  })

  it('on confirm from a quit: stops the work, then quits, without asking again', async () => {
    const { app, deps, calls, settle } = setup({
      activity: () => ({ run: 'command', approvals: 0 }),
    })
    app.quit()
    await settle()
    expect(deps.confirm).toHaveBeenCalledTimes(1)
    expect(calls).toEqual(['stop', 'flush'])
    expect(deps.stopWork).toHaveBeenCalledTimes(1)
    expect(app.quitCompleted).toBe(true)
  })

  it('never shows the prompt twice when closed and quit while it is open', async () => {
    let answer: (value: boolean) => void = () => {}
    const { app, window, deps, settle } = setup({
      activity: () => ({ run: 'reply', approvals: 0 }),
      confirm: () =>
        new Promise<boolean>((resolve) => {
          answer = resolve
        }),
    })
    window.close()
    app.quit()
    window.close()
    app.quit()
    await settle()
    expect(deps.confirm).toHaveBeenCalledTimes(1)
    expect(app.quitCompleted).toBe(false)
    answer(false)
    await settle()
    expect(window.destroyed).toBe(false)
    expect(app.quitCompleted).toBe(false)
  })

  it('cannot loop: after confirming, the quit and close events pass', async () => {
    const { app, window, deps, settle } = setup({
      activity: () => ({ run: 'reply', approvals: 0 }),
    })
    app.quit()
    await settle()
    expect(deps.confirm).toHaveBeenCalledTimes(1)
    expect(app.quit.mock.calls.length).toBeLessThanOrEqual(2)
    expect(app.quitCompleted).toBe(true)
    expect(window.closes).toBeLessThanOrEqual(1)
  })

  it('treats a dialog that fails to show as Cancel', async () => {
    const { window, deps, settle } = setup({
      activity: () => ({ run: 'reply', approvals: 0 }),
      confirm: () => Promise.reject(new Error('no dialog')),
    })
    window.close()
    await settle()
    expect(window.destroyed).toBe(false)
    expect(deps.onError).toHaveBeenCalled()
  })

  it('does not hang when stopping the run never finishes', async () => {
    const { window } = setup({
      activity: () => ({ run: 'reply', approvals: 0 }),
      stopWork: () => new Promise<void>(() => {}),
    })
    window.close()
    await vi.advanceTimersByTimeAsync(200)
    expect(window.destroyed).toBe(true)
  })

  it('does not hang when saving the state never finishes', async () => {
    const { window } = setup({ flushState: () => new Promise<void>(() => {}) })
    window.close()
    await vi.advanceTimersByTimeAsync(200)
    expect(window.destroyed).toBe(true)
  })

  it('does not ask while the OS is ending the session, and does not hold the close', async () => {
    const { app, window, deps, settle } = setup({
      activity: () => ({ run: 'reply', approvals: 1 }),
      skipPrompt: () => true,
    })
    expect(window.close()).toBe(false) // not held: Windows will not wait
    await settle()
    app.quit()
    await settle()
    expect(deps.confirm).not.toHaveBeenCalled()
    expect(app.quitCompleted).toBe(true)
    expect(deps.stopWork).toHaveBeenCalled()
  })

  it('allowQuit lets a quit the app chose itself through without a prompt', async () => {
    const { app, guard, deps, settle } = setup({ activity: () => ({ run: 'reply', approvals: 0 }) })
    guard.allowQuit()
    app.quit()
    await settle()
    expect(deps.confirm).not.toHaveBeenCalled()
    expect(app.quitCompleted).toBe(true)
  })

  it('allowQuit still stops the work and saves the window state', async () => {
    const { guard, deps, settle } = setup({ activity: () => ({ run: 'reply', approvals: 0 }) })
    guard.allowQuit()
    await settle()
    expect(deps.stopWork).toHaveBeenCalledOnce()
    expect(deps.flushState).toHaveBeenCalledOnce()
    guard.allowQuit()
    await settle()
    expect(deps.stopWork).toHaveBeenCalledOnce()
  })

  /** The warning stays up until it is aborted or `answer` is called. */
  const heldConfirm = () => {
    const held: { signal?: AbortSignal; answer?: (yes: boolean) => void } = {}
    const confirm = (_warning: CloseWarning, signal: AbortSignal) =>
      new Promise<boolean>((resolve) => {
        held.signal = signal
        held.answer = resolve
        signal.addEventListener('abort', () => {
          resolve(false)
        })
      })
    return { held, confirm }
  }

  it('allowQuit takes down a showing warning, and a late Cancel cannot undo it', async () => {
    const { held, confirm } = heldConfirm()
    const { app, guard, deps, settle } = setup({
      activity: () => ({ run: 'reply', approvals: 0 }),
      confirm,
    })
    app.quit()
    await settle()
    expect(app.quitCompleted).toBe(false)
    guard.allowQuit()
    expect(held.signal?.aborted).toBe(true)
    await settle()
    expect(guard.isClosing()).toBe(true)
    app.quit()
    expect(app.quitCompleted).toBe(true)
    expect(deps.confirm).toHaveBeenCalledOnce()
  })

  it('dismissWarning cancels a showing warning, and the next close asks again', async () => {
    const { held, confirm } = heldConfirm()
    const { app, window, guard, deps, settle } = setup({
      activity: () => ({ run: 'reply', approvals: 0 }),
      confirm,
    })
    app.quit()
    await settle()
    guard.dismissWarning()
    expect(held.signal?.aborted).toBe(true)
    expect(guard.isClosing()).toBe(false)
    await settle()
    expect(app.quit).toHaveBeenCalledOnce()
    expect(window.destroyed).toBe(false)
    window.close()
    await settle()
    expect(deps.confirm).toHaveBeenCalledTimes(2)
  })

  it('dismissWarning does nothing to a close that is already going ahead', async () => {
    const { window, guard, settle } = setup()
    window.close()
    guard.dismissWarning()
    expect(guard.isClosing()).toBe(true)
    await settle()
    expect(window.destroyed).toBe(true)
  })

  describe('isClosing', () => {
    const working = () => ({ run: 'reply', approvals: 0 }) as const

    it('is false while the warning is up and after it is cancelled', async () => {
      const { held, confirm } = heldConfirm()
      const { app, guard, settle } = setup({ activity: working, confirm })
      expect(guard.isClosing()).toBe(false)
      app.quit()
      await settle()
      expect(guard.isClosing()).toBe(false)
      held.answer?.(false)
      await settle()
      expect(guard.isClosing()).toBe(false)
    })

    it('is true once the warning is confirmed, while the work is being stopped', async () => {
      const { held, confirm } = heldConfirm()
      const { app, guard, settle } = setup({
        activity: working,
        confirm,
        stopWork: () => new Promise(() => undefined),
      })
      app.quit()
      await settle()
      held.answer?.(true)
      await settle()
      expect(app.quitCompleted).toBe(false)
      expect(guard.isClosing()).toBe(true)
    })

    it('is true when an idle quit is let through, before its window has closed', () => {
      const { app, guard } = setup()
      app.quit()
      expect(app.quitCompleted).toBe(true)
      expect(guard.isClosing()).toBe(true)
    })

    it('is false again in a window opened later', () => {
      const { app, guard } = setup()
      app.quit()
      guard.attach(new FakeWindow())
      expect(guard.isClosing()).toBe(false)
    })
  })

  it('asks again for a window opened later (macOS reopen)', async () => {
    const { guard, deps, settle } = setup({ activity: () => ({ run: 'reply', approvals: 0 }) })
    guard.allowQuit()
    const next = new FakeWindow()
    guard.attach(next)
    next.close()
    await settle()
    expect(deps.confirm).toHaveBeenCalledTimes(1)
  })
})
