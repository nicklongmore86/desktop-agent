import { describe, expect, it, vi } from 'vitest'
import { parseWindowState } from './storage/window-state-schema'
import {
  DEFAULT_WINDOW_SIZE,
  defaultBounds,
  isReachable,
  MIN_WINDOW_SIZE,
  planWindow,
  trackWindowState,
  type Rect,
  type TrackedWindow,
} from './window-state'

const screen1: Rect = { x: 0, y: 0, width: 1920, height: 1040 }
/** A second monitor to the right. */
const screen2: Rect = { x: 1920, y: 0, width: 1280, height: 984 }
const state = (over: Partial<Rect & { maximized: boolean }> = {}) => ({
  x: 100,
  y: 80,
  width: 1100,
  height: 760,
  maximized: false,
  ...over,
})

describe('planWindow', () => {
  it('uses the saved bounds when they are on a display', () => {
    expect(planWindow(state(), [screen1], screen1)).toEqual({
      bounds: { x: 100, y: 80, width: 1100, height: 760 },
      maximized: false,
    })
  })

  it('falls back to the default size, centred on the primary, with nothing saved', () => {
    const plan = planWindow(undefined, [screen1], screen1)
    expect(plan.bounds).toEqual({
      x: (1920 - DEFAULT_WINDOW_SIZE.width) / 2,
      y: (1040 - DEFAULT_WINDOW_SIZE.height) / 2,
      width: 1000,
      height: 720,
    })
    expect(plan.maximized).toBe(false)
  })

  it('falls back to the default when the saved monitor is gone', () => {
    // Saved on the second monitor, which is now unplugged.
    const plan = planWindow(state({ x: 2200, y: 100 }), [screen1], screen1)
    expect(plan.bounds).toEqual(defaultBounds(screen1))
  })

  it('keeps a window that is on the second monitor when it is still there', () => {
    const plan = planWindow(state({ x: 2200, y: 100 }), [screen1, screen2], screen1)
    expect(plan.bounds).toMatchObject({ x: 2200, y: 100 })
  })

  it('keeps a window that straddles two monitors', () => {
    const plan = planWindow(state({ x: 1500 }), [screen1, screen2], screen1)
    expect(plan.bounds.x).toBe(1500)
  })

  it('falls back when the title bar is above the screen, out of reach', () => {
    expect(planWindow(state({ y: -400 }), [screen1], screen1).bounds).toEqual(
      defaultBounds(screen1),
    )
  })

  it('falls back when only a sliver of the window is on the display', () => {
    expect(planWindow(state({ x: 1900 }), [screen1], screen1).bounds).toEqual(
      defaultBounds(screen1),
    )
  })

  it('raises a saved size below the minimum to the minimum', () => {
    const plan = planWindow(state({ width: 100, height: 50 }), [screen1], screen1)
    expect(plan.bounds).toMatchObject({
      width: MIN_WINDOW_SIZE.width,
      height: MIN_WINDOW_SIZE.height,
    })
  })

  it('keeps maximized even when the bounds are no longer usable', () => {
    const plan = planWindow(state({ x: 9000, maximized: true }), [screen1], screen1)
    expect(plan).toEqual({ bounds: defaultBounds(screen1), maximized: true })
  })

  it('restores maximized with its normal bounds', () => {
    expect(planWindow(state({ maximized: true }), [screen1], screen1)).toEqual({
      bounds: { x: 100, y: 80, width: 1100, height: 760 },
      maximized: true,
    })
  })

  it('never makes the default window bigger than a small display', () => {
    const small: Rect = { x: 0, y: 0, width: 800, height: 560 }
    const bounds = defaultBounds(small)
    expect(bounds).toEqual({ x: 0, y: 0, width: 800, height: 560 })
    const tiny: Rect = { x: 0, y: 0, width: 300, height: 200 }
    expect(defaultBounds(tiny)).toMatchObject({
      width: MIN_WINDOW_SIZE.width,
      height: MIN_WINDOW_SIZE.height,
    })
  })

  it('centres on a primary display that is not at the origin', () => {
    const primary: Rect = { x: -1920, y: 0, width: 1920, height: 1040 }
    expect(defaultBounds(primary)).toMatchObject({ x: -1920 + 460, y: 160 })
  })
})

describe('isReachable', () => {
  it('needs the title bar, not just any corner, on a display', () => {
    const win = { x: 0, y: -700, width: 1000, height: 720 }
    // The body is on the display but the title bar is above it.
    expect(isReachable(win, [screen1])).toBe(false)
    expect(isReachable({ ...win, y: -10 }, [screen1])).toBe(true)
  })
})

describe('parseWindowState (older and broken settings files)', () => {
  it('reads a complete state', () => {
    expect(parseWindowState(state())).toEqual(state())
  })

  it.each([
    ['missing', undefined],
    ['null', null],
    ['a string', 'x'],
    ['an array', []],
    ['empty', {}],
    ['a fraction', { ...state(), x: 1.5 }],
    ['NaN', { ...state(), width: Number.NaN }],
    ['Infinity', { ...state(), height: Number.POSITIVE_INFINITY }],
    ['zero width', { ...state(), width: 0 }],
    ['huge width', { ...state(), width: 10 ** 9 }],
    ['a numeric string', { ...state(), x: '10' }],
    ['missing y', { x: 1, width: 500, height: 500, maximized: false }],
  ])('treats %s as no saved window', (_name, value) => {
    expect(parseWindowState(value)).toBeUndefined()
  })

  it('treats a missing or invalid maximized as false and drops unknown keys', () => {
    const { maximized: _gone, ...rest } = state()
    expect(parseWindowState(rest)).toEqual(state({ maximized: false }))
    expect(parseWindowState({ ...state(), maximized: 'yes', path: 'C:\\secret' })).toEqual(
      state({ maximized: false }),
    )
  })
})

class FakeWindow implements TrackedWindow {
  listeners = new Map<string, (() => void)[]>()
  destroyed = false
  maximized = false
  fullscreen = false
  normal: Rect = { x: 10, y: 20, width: 900, height: 700 }
  on(event: string, listener: () => void): void {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener])
  }
  emit(event: string): void {
    for (const listener of this.listeners.get(event) ?? []) listener()
  }
  isDestroyed = () => this.destroyed
  isMaximized = () => this.maximized
  isFullScreen = () => this.fullscreen
  getNormalBounds = () => ({ ...this.normal })
}

function harness(overrides: { save?: (s: unknown) => Promise<void> } = {}) {
  const window = new FakeWindow()
  const timers: { callback: () => void; ms: number; cleared: boolean }[] = []
  const save = vi.fn(overrides.save ?? (() => Promise.resolve()))
  const tracker = trackWindowState(window, {
    save,
    debounceMs: 500,
    setTimer: (callback, ms) => {
      const timer = { callback, ms, cleared: false }
      timers.push(timer)
      return timer
    },
    clearTimer: (timer) => {
      ;(timer as { cleared: boolean }).cleared = true
    },
    onError: vi.fn(),
  })
  const fire = (): void => {
    const live = timers.filter((timer) => !timer.cleared)
    live.at(-1)?.callback()
    for (const timer of live) timer.cleared = true
  }
  return { window, save, tracker, timers, fire }
}

describe('trackWindowState', () => {
  it('collapses a drag into one save after the debounce, with the normal bounds', async () => {
    const { window, save, timers, fire } = harness()
    for (let i = 0; i < 20; i++) window.emit('move')
    window.emit('resize')
    expect(save).not.toHaveBeenCalled()
    expect(timers.every((t) => t.ms === 500)).toBe(true)
    fire()
    await Promise.resolve()
    expect(save).toHaveBeenCalledTimes(1)
    expect(save).toHaveBeenCalledWith({ x: 10, y: 20, width: 900, height: 700, maximized: false })
  })

  it('records maximized without losing the restored bounds', async () => {
    const { window, save, fire } = harness()
    window.maximized = true
    window.emit('maximize')
    fire()
    await Promise.resolve()
    expect(save).toHaveBeenCalledWith({ x: 10, y: 20, width: 900, height: 700, maximized: true })
  })

  it('flushes immediately on close, and on demand, without waiting for the debounce', async () => {
    const { window, save, tracker } = harness()
    window.normal = { x: 5, y: 6, width: 800, height: 600 }
    window.emit('move')
    window.emit('close')
    await tracker.flush()
    expect(save).toHaveBeenCalledTimes(1)
    expect(save).toHaveBeenCalledWith({ x: 5, y: 6, width: 800, height: 600, maximized: false })
  })

  it('writes on the window close event itself, with no flush call and no timer', async () => {
    const { window, save } = harness()
    window.normal = { x: 1, y: 2, width: 700, height: 500 }
    window.emit('close')
    await Promise.resolve()
    await Promise.resolve()
    expect(save).toHaveBeenCalledWith({ x: 1, y: 2, width: 700, height: 500, maximized: false })
  })

  it('does not write the same state twice', async () => {
    const { save, tracker } = harness()
    await tracker.flush()
    await tracker.flush()
    expect(save).toHaveBeenCalledTimes(1)
  })

  it('flush resolves after the write finished, so a quit can wait for it', async () => {
    let finish: () => void = () => {}
    const { tracker } = harness({
      save: () =>
        new Promise<void>((resolve) => {
          finish = resolve
        }),
    })
    let done = false
    void tracker.flush().then(() => {
      done = true
    })
    await Promise.resolve()
    expect(done).toBe(false)
    finish()
    await tracker.flush()
    expect(done).toBe(true)
  })

  it('survives a failing save and tries again next time', async () => {
    let fail = true
    const { window, save, tracker } = harness({
      save: () => (fail ? Promise.reject(new Error('disk full')) : Promise.resolve()),
    })
    await expect(tracker.flush()).resolves.toBeUndefined()
    fail = false
    window.normal = { ...window.normal }
    await tracker.flush()
    expect(save).toHaveBeenCalledTimes(2)
  })

  it('ignores a destroyed window and full-screen changes', async () => {
    const { window, save, timers, tracker } = harness()
    window.fullscreen = true
    window.emit('resize')
    expect(timers).toHaveLength(0)
    window.destroyed = true
    await tracker.flush()
    expect(save).not.toHaveBeenCalled()
  })
})
