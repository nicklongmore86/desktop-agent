/**
 * The saved window size and position (settings.json, `windowState`). Numbers and one boolean:
 * never a path. `x`, `y`, `width` and `height` are the window's normal (not maximized) bounds
 * in device-independent pixels; `maximized` is kept apart so un-maximizing returns there.
 */
export interface WindowState {
  x: number
  y: number
  width: number
  height: number
  maximized: boolean
}
