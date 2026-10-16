import { describe, expect, it } from 'vitest'
import { DEFAULT_LAYOUT, LEFT_MIN, RIGHT_MIN, type LayoutPrefs } from '../../shared/ipc-layout'
import { CHAT_MIN, clamp, computeGeometry, viewportOf } from './layout'

const prefs = (changes: Partial<LayoutPrefs> = {}): LayoutPrefs => ({
  ...DEFAULT_LAYOUT,
  ...changes,
})

describe('viewportOf', () => {
  it.each([
    [1920, 'wide'],
    [1100, 'wide'],
    [1099, 'medium'],
    [760, 'medium'],
    [759, 'compact'],
    [541, 'compact'],
    [540, 'narrow'],
    [400, 'narrow'],
  ] as const)('%ipx is %s', (width, viewport) => {
    expect(viewportOf(width)).toBe(viewport)
  })
})

describe('computeGeometry', () => {
  it('docks both panes at 1280px with the saved widths', () => {
    const { left, right } = computeGeometry(1280, prefs())
    expect(left).toMatchObject({ dockable: true, docked: true, width: 272 })
    expect(right).toMatchObject({ dockable: true, docked: true, width: 320 })
  })

  it('docks only the left pane from 760px, and only drawers below that', () => {
    expect(computeGeometry(900, prefs())).toMatchObject({
      left: { dockable: true, docked: true },
      right: { dockable: false, docked: false },
    })
    for (const width of [759, 600, 400])
      expect(computeGeometry(width, prefs())).toMatchObject({
        left: { dockable: false, docked: false },
        right: { dockable: false, docked: false },
      })
  })

  it('docks nothing that is collapsed, but keeps it dockable', () => {
    expect(computeGeometry(1280, prefs({ leftOpen: false, rightOpen: false }))).toMatchObject({
      left: { dockable: true, docked: false },
      right: { dockable: true, docked: false },
    })
  })

  it('holds widths inside the limits: min, 40% / 45% of the window, and the chat column', () => {
    const small = computeGeometry(1280, prefs({ leftWidth: 100, rightWidth: 100 }))
    expect([small.left.width, small.right.width]).toEqual([LEFT_MIN, RIGHT_MIN])
    const large = computeGeometry(1280, prefs({ leftWidth: 1200, rightWidth: 1200 }))
    expect(large.left.width).toBe(Math.floor(1280 * 0.4))
    expect(large.left.max).toBe(512)
    // The right pane gets what the left leaves, never taking the chat under 480px.
    expect(large.right.width).toBe(1280 - 512 - CHAT_MIN)
    expect(large.right.width).toBe(large.right.max)
  })

  it('never lets the chat column drop under 480px while docked', () => {
    for (let width = 760; width <= 2200; width += 7)
      for (const leftWidth of [220, 272, 500, 1200])
        for (const rightWidth of [240, 320, 600, 1200]) {
          const { left, right } = computeGeometry(width, prefs({ leftWidth, rightWidth }))
          const chat = width - (left.docked ? left.width : 0) - (right.docked ? right.width : 0)
          expect(
            chat,
            `${String(width)} ${String(leftWidth)} ${String(rightWidth)}`,
          ).toBeGreaterThanOrEqual(CHAT_MIN)
        }
  })

  it('shrinks the right pane first, then makes it a drawer, keeping the saved state', () => {
    // 1100px: left 272 + chat 480 leaves 348 for the right pane.
    const wide = computeGeometry(1100, prefs({ rightWidth: 500 }))
    expect(wide.right).toMatchObject({ dockable: true, docked: true, width: 348 })
    // A wider left pane leaves less than the 240px minimum: the right one gives way.
    const crowded = computeGeometry(1100, prefs({ leftWidth: 440, rightWidth: 320 }))
    expect(crowded.right).toMatchObject({ dockable: false, docked: false })
    // Collapsing the left pane brings it back (rightOpen was never touched).
    expect(computeGeometry(1100, prefs({ leftWidth: 440, leftOpen: false })).right).toMatchObject({
      dockable: true,
      docked: true,
    })
  })

  it('gives the separators their limits', () => {
    const { left, right } = computeGeometry(1280, prefs())
    expect([left.min, left.max]).toEqual([LEFT_MIN, 512])
    expect([right.min, right.max]).toEqual([RIGHT_MIN, 1280 - 272 - CHAT_MIN])
  })
})

describe('clamp', () => {
  it('holds a value inside a range', () => {
    expect(clamp(5, 1, 10)).toBe(5)
    expect(clamp(0, 1, 10)).toBe(1)
    expect(clamp(11, 1, 10)).toBe(10)
  })
})
