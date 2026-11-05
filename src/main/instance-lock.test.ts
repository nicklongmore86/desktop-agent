import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import {
  APP_USER_MODEL_ID,
  claimInstance,
  focusWindow,
  type FocusableWindow,
} from './instance-lock'

const appFake = (gotLock: boolean) => ({
  requestSingleInstanceLock: vi.fn(() => gotLock),
  exit: vi.fn(),
  setAppUserModelId: vi.fn(),
})

describe('claimInstance', () => {
  it('owns the app when it gets the lock, and does not exit', () => {
    const app = appFake(true)
    expect(claimInstance(app)).toBe(true)
    expect(app.exit).not.toHaveBeenCalled()
  })

  it('ends the process at once, not with a polite quit, when another copy holds the lock', () => {
    const app = appFake(false)
    expect(claimInstance(app)).toBe(false)
    expect(app.exit).toHaveBeenCalledWith(0)
  })

  it('sets the AppUserModelID first, for both', () => {
    for (const got of [true, false]) {
      const app = appFake(got)
      claimInstance(app)
      expect(app.setAppUserModelId).toHaveBeenCalledWith(APP_USER_MODEL_ID)
    }
  })

  it('uses the electron-builder appId as the AppUserModelID', () => {
    const config = readFileSync(new URL('../../electron-builder.yml', import.meta.url), 'utf8')
    expect(/^appId:\s*(\S+)\s*$/m.exec(config)?.[1]).toBe(APP_USER_MODEL_ID)
  })
})

describe('focusWindow', () => {
  const windowFake = (state: { minimized?: boolean; visible?: boolean; destroyed?: boolean }) => {
    const calls: string[] = []
    const window: FocusableWindow = {
      isDestroyed: () => state.destroyed === true,
      isMinimized: () => state.minimized === true,
      isVisible: () => state.visible !== false,
      restore: () => calls.push('restore'),
      show: () => calls.push('show'),
      focus: () => calls.push('focus'),
    }
    return { window, calls }
  }

  it('restores a minimized window, then focuses it', () => {
    const { window, calls } = windowFake({ minimized: true })
    focusWindow(window)
    expect(calls).toEqual(['restore', 'focus'])
  })

  it('shows a hidden window', () => {
    const { window, calls } = windowFake({ visible: false })
    focusWindow(window)
    expect(calls).toEqual(['show', 'focus'])
  })

  it('only focuses a normal window', () => {
    const { window, calls } = windowFake({})
    focusWindow(window)
    expect(calls).toEqual(['focus'])
  })

  it('does nothing for no window or a destroyed one', () => {
    expect(() => {
      focusWindow(null)
    }).not.toThrow()
    const { window, calls } = windowFake({ destroyed: true })
    focusWindow(window)
    expect(calls).toEqual([])
  })
})
