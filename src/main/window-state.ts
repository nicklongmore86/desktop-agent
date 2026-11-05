import type { WindowState } from '../shared/window-state'

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/** The window's first size when nothing usable is saved. */
export const DEFAULT_WINDOW_SIZE = { width: 1000, height: 720 } as const
/** The smallest the window may be (the same numbers createMainWindow gives Electron). */
export const MIN_WINDOW_SIZE = { width: 480, height: 400 } as const

/** How much of the title bar must lie on a display for the user to be able to grab it. */
const TITLE_BAR_HEIGHT = 32
const GRAB_MIN_WIDTH = 100
const GRAB_MIN_HEIGHT = 16

export interface PlannedWindow {
  /** Where and how big to create the window. */
  bounds: Rect
  /** Whether to maximize it right after creating it. */
  maximized: boolean
}

function overlap(a: Rect, b: Rect): { width: number; height: number } {
  const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)
  const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)
  return { width: Math.max(0, width), height: Math.max(0, height) }
}

/**
 * True when enough of the window's title bar is on one of the displays' work areas to move it
 * from there. A monitor that was unplugged, or a resolution that shrank, fails this; a window
 * that straddles two monitors, or hangs a little off an edge, passes.
 */
export function isReachable(bounds: Rect, workAreas: readonly Rect[]): boolean {
  const titleBar: Rect = { ...bounds, height: Math.min(TITLE_BAR_HEIGHT, bounds.height) }
  return workAreas.some((area) => {
    const shared = overlap(titleBar, area)
    return shared.width >= GRAB_MIN_WIDTH && shared.height >= GRAB_MIN_HEIGHT
  })
}

/** The default size, centred on a work area, and no bigger than it. */
export function defaultBounds(area: Rect): Rect {
  const width = Math.min(DEFAULT_WINDOW_SIZE.width, Math.max(MIN_WINDOW_SIZE.width, area.width))
  const height = Math.min(DEFAULT_WINDOW_SIZE.height, Math.max(MIN_WINDOW_SIZE.height, area.height))
  return {
    x: Math.round(area.x + (area.width - width) / 2),
    y: Math.round(area.y + (area.height - height) / 2),
    width,
    height,
  }
}

/**
 * Where to put the window: the saved bounds if they are valid, respect the minimum size and are
 * reachable on a current display; otherwise the default size centred on the primary display.
 * The maximized flag is kept either way (a maximized window fills whichever display it opens on).
 *
 * @param saved the parsed `windowState` setting, or undefined
 * @param workAreas the work area (screen minus taskbar) of every current display
 * @param primary the primary display's work area
 */
export function planWindow(
  saved: WindowState | undefined,
  workAreas: readonly Rect[],
  primary: Rect,
): PlannedWindow {
  const fallback = { bounds: defaultBounds(primary), maximized: saved?.maximized === true }
  if (!saved) return fallback
  const bounds: Rect = {
    x: saved.x,
    y: saved.y,
    width: Math.max(MIN_WINDOW_SIZE.width, saved.width),
    height: Math.max(MIN_WINDOW_SIZE.height, saved.height),
  }
  if (!isReachable(bounds, workAreas)) return fallback
  return { bounds, maximized: saved.maximized }
}

/** The pieces of a BrowserWindow that the tracker reads and listens to. */
export interface TrackedWindow {
  on(event: 'resize' | 'move' | 'maximize' | 'unmaximize' | 'close', listener: () => void): unknown
  isDestroyed(): boolean
  isMaximized(): boolean
  isFullScreen(): boolean
  /** The restored bounds, also while maximized or minimized. */
  getNormalBounds(): Rect
}

export interface WindowStateTracker {
  /** Writes the current state now if it changed since the last write. Never rejects. */
  flush: () => Promise<void>
}

export interface TrackerOptions {
  save: (state: WindowState) => Promise<void>
  debounceMs?: number
  onError?: (error: unknown) => void
  setTimer?: (callback: () => void, ms: number) => unknown
  clearTimer?: (timer: unknown) => void
}

/**
 * Saves the window's bounds and maximized state a moment after it stops moving or resizing, and
 * on `flush` (the caller flushes before the window closes). Changes during a drag collapse into
 * one write. `flush` resolves once the write finished, so a quit can wait for it.
 */
export function trackWindowState(
  window: TrackedWindow,
  options: TrackerOptions,
): WindowStateTracker {
  const debounceMs = options.debounceMs ?? 500
  const setTimer = options.setTimer ?? ((callback, ms) => setTimeout(callback, ms))
  const clearTimer =
    options.clearTimer ??
    ((timer) => {
      clearTimeout(timer as ReturnType<typeof setTimeout>)
    })
  let timer: unknown = null
  let lastSaved = ''
  let writing: Promise<void> = Promise.resolve()

  const snapshot = (): WindowState | null => {
    if (window.isDestroyed()) return null
    const { x, y, width, height } = window.getNormalBounds()
    return { x, y, width, height, maximized: window.isMaximized() }
  }
  const write = (): Promise<void> => {
    if (timer !== null) {
      clearTimer(timer)
      timer = null
    }
    const state = snapshot()
    if (state) {
      const key = JSON.stringify(state)
      if (key !== lastSaved) {
        lastSaved = key
        writing = writing
          .then(() => options.save(state))
          .catch((error: unknown) => {
            // Try again next time rather than believing it was saved.
            lastSaved = ''
            options.onError?.(error)
          })
      }
    }
    return writing
  }
  const schedule = (): void => {
    if (window.isFullScreen()) return
    if (timer !== null) clearTimer(timer)
    timer = setTimer(() => {
      timer = null
      void write()
    }, debounceMs)
  }
  for (const event of ['resize', 'move', 'maximize', 'unmaximize'] as const)
    window.on(event, schedule)
  window.on('close', () => {
    void write()
  })
  return { flush: write }
}
