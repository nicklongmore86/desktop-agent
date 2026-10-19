import {
  LEFT_MIN,
  PANE_MAX,
  RIGHT_MIN,
  type LayoutPrefs,
  type RightTabId,
} from '../../shared/ipc-layout'

/** The chat column is never narrower than this: the panes shrink, then give way. */
export const CHAT_MIN = 400
/** Pane maximums as a share of the window. */
export const LEFT_MAX_SHARE = 0.4
export const RIGHT_MAX_SHARE = 0.45
/** The slim rail (holding the Settings gear) that stays where a collapsed left pane was. */
export const LEFT_RAIL = 48
/** One arrow-key press on a separator. */
export const RESIZE_STEP = 16

/**
 * Window width buckets. The CSS media queries for the drawers use the same numbers:
 * keep `NARROW_MAX` in step with `@media (max-width: 540px)`.
 *   wide     >= 860   both panes can dock, each at its minimum, beside a 400px chat
 *   medium   620-859  the left pane docks; the right one docks only while the left is collapsed
 *                   (and then from 688px: LEFT_RAIL + CHAT_MIN + RIGHT_MIN)
 *   compact  541-619  both are drawers
 *   narrow   <= 540   both are (nearly) full-width drawers
 */
export type Viewport = 'wide' | 'medium' | 'compact' | 'narrow'
export const MEDIUM_MIN = LEFT_MIN + CHAT_MIN
export const WIDE_MIN = LEFT_MIN + RIGHT_MIN + CHAT_MIN
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
 * Where the panes go in a window `width` px wide. Pure, so the rules are testable.
 * The chat column keeps at least CHAT_MIN. Both panes push the chat (never overlay
 * it): when their stored widths leave the chat too little, they give up width
 * together, in proportion to how far each is above its minimum. A pane docks as long
 * as the chat still gets CHAT_MIN with that pane at its minimum (and the other docked
 * pane, or the collapsed left pane's rail, too); otherwise it is not dockable and its toggle opens a drawer. The stored
 * open flags and widths are left alone, so a pane comes back when there is room again.
 */
export function computeGeometry(width: number, prefs: LayoutPrefs): ShellGeometry {
  const viewport = viewportOf(width)

  const leftDockable = width >= MEDIUM_MIN
  const leftDocked = leftDockable && prefs.leftOpen
  // Collapsed, the left pane leaves only its rail.
  const leftReserve = leftDockable ? (leftDocked ? LEFT_MIN : LEFT_RAIL) : 0
  const rightRoom = width - CHAT_MIN - leftReserve
  const rightDockable = rightRoom >= RIGHT_MIN
  const rightDocked = rightDockable && prefs.rightOpen

  // What each pane could take at most (leaving the other docked pane its minimum).
  const leftMax = Math.max(
    LEFT_MIN,
    Math.min(
      PANE_MAX,
      Math.floor(width * LEFT_MAX_SHARE),
      width - CHAT_MIN - (rightDocked ? RIGHT_MIN : 0),
    ),
  )
  const rightMax = Math.max(
    RIGHT_MIN,
    Math.min(PANE_MAX, Math.floor(width * RIGHT_MAX_SHARE), width - CHAT_MIN - leftReserve),
  )

  let leftWidth = clamp(prefs.leftWidth, LEFT_MIN, leftMax)
  let rightWidth = clamp(prefs.rightWidth, RIGHT_MIN, rightMax)

  // Both docked and too wide for the chat: shrink them together toward their minimums.
  if (leftDocked && rightDocked) {
    const excess = leftWidth + rightWidth + CHAT_MIN - width
    if (excess > 0) {
      const slackLeft = leftWidth - LEFT_MIN
      const slackRight = rightWidth - RIGHT_MIN
      const slack = slackLeft + slackRight
      const takeLeft = slack > 0 ? Math.min(slackLeft, Math.ceil((excess * slackLeft) / slack)) : 0
      leftWidth -= takeLeft
      rightWidth -= Math.min(slackRight, excess - takeLeft)
    }
  }

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
      docked: rightDocked,
      width: rightWidth,
      min: RIGHT_MIN,
      max: rightMax,
    },
  }
}

export const RIGHT_TAB_LABELS: Record<RightTabId, string> = { files: 'Files', git: 'Git' }
