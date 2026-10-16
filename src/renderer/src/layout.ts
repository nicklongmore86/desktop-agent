import {
  LEFT_MIN,
  PANE_MAX,
  RIGHT_MIN,
  type LayoutPrefs,
  type RightTabId,
} from '../../shared/ipc-layout'

/** The chat column is never narrower than this: the right pane shrinks, then gives way. */
export const CHAT_MIN = 480
/** Pane maximums as a share of the window. */
export const LEFT_MAX_SHARE = 0.4
export const RIGHT_MAX_SHARE = 0.45
/** One arrow-key press on a separator. */
export const RESIZE_STEP = 16

/**
 * Window width buckets (REPORT 4.2). The CSS media queries for the drawers use the
 * same numbers: keep `NARROW_MAX` in step with `@media (max-width: 540px)`.
 *   wide     >= 1100  both panes docked
 *   medium   760-1099 left docked, right is a drawer
 *   compact  541-759  both are drawers
 *   narrow   <= 540   both are (nearly) full-width drawers
 */
export type Viewport = 'wide' | 'medium' | 'compact' | 'narrow'
export const WIDE_MIN = 1100
export const MEDIUM_MIN = 760
export const NARROW_MAX = 540

export function viewportOf(width: number): Viewport {
  if (width >= WIDE_MIN) return 'wide'
  if (width >= MEDIUM_MIN) return 'medium'
  return width > NARROW_MAX ? 'compact' : 'narrow'
}

export const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value))

export interface PaneGeometry {
  /** Docked beside the chat. When false the pane is a drawer (opened on demand). */
  dockable: boolean
  /** Docked and showing. */
  docked: boolean
  /** The width the pane has when docked: the stored one, held inside [min, max]. */
  width: number
  min: number
  max: number
}

export interface ShellGeometry {
  viewport: Viewport
  left: PaneGeometry
  right: PaneGeometry
}

/**
 * Where the panes go in a window `width` px wide. Pure, so the rules are testable:
 * the left pane docks from 760px; the right one from 1100px, and only while the chat
 * column keeps at least CHAT_MIN. It shrinks first (down to its minimum), and when even
 * that does not fit it is not dockable (its toggle opens a drawer instead). The stored
 * `rightOpen` is left alone, so the pane comes back when there is room again.
 */
export function computeGeometry(width: number, prefs: LayoutPrefs): ShellGeometry {
  const viewport = viewportOf(width)

  const leftDockable = viewport === 'wide' || viewport === 'medium'
  const leftMax = Math.max(
    LEFT_MIN,
    Math.min(PANE_MAX, Math.floor(width * LEFT_MAX_SHARE), width - CHAT_MIN),
  )
  const leftWidth = clamp(prefs.leftWidth, LEFT_MIN, leftMax)
  const leftDocked = leftDockable && prefs.leftOpen

  const room = width - (leftDocked ? leftWidth : 0) - CHAT_MIN
  const rightMax = Math.min(PANE_MAX, Math.floor(width * RIGHT_MAX_SHARE), room)
  const rightDockable = viewport === 'wide' && rightMax >= RIGHT_MIN
  const rightWidth = clamp(prefs.rightWidth, RIGHT_MIN, Math.max(RIGHT_MIN, rightMax))

  return {
    viewport,
    left: {
      dockable: leftDockable,
      docked: leftDocked,
      width: leftWidth,
      min: LEFT_MIN,
      max: leftMax,
    },
    right: {
      dockable: rightDockable,
      docked: rightDockable && prefs.rightOpen,
      width: rightWidth,
      min: RIGHT_MIN,
      max: Math.max(RIGHT_MIN, rightMax),
    },
  }
}

export const RIGHT_TAB_LABELS: Record<RightTabId, string> = { files: 'Files', git: 'Git' }
