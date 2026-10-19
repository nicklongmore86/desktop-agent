import { describe, expect, it } from 'vitest'
import { DEFAULT_LAYOUT, LEFT_MIN, RIGHT_MIN, type LayoutPrefs } from '../../shared/ipc-layout'
import { CHAT_MIN, LEFT_RAIL, clamp, computeGeometry, viewportOf } from './layout'

const prefs = (changes: Partial<LayoutPrefs> = {}): LayoutPrefs => ({
  ...DEFAULT_LAYOUT,
  ...changes,
})

describe('viewportOf', () => {
  it.each([
    [1920, 'wide'],
    [860, 'wide'],
    [859, 'medium'],
    [620, 'medium'],
    [619, 'compact'],
    [541, 'compact'],
    [540, 'narrow'],
    [400, 'narrow'],
  ] as const)('%ipx is %s', (width, viewport) => {
    expect(viewportOf(width)).toBe(viewport)
  })
})

/** The chat column's width: what the docked panes (and the collapsed left pane's rail) leave. */
const chatWidth = (width: number, g: ReturnType<typeof computeGeometry>): number =>
  width -
  (g.left.docked ? g.left.width : g.left.dockable ? LEFT_RAIL : 0) -
  (g.right.docked ? g.right.width : 0)

describe('computeGeometry', () => {
  it('docks both panes at 1280px with the saved widths', () => {
    const { left, right } = computeGeometry(1280, prefs())
    expect(left).toMatchObject({ dockable: true, docked: true, width: 272 })
    expect(right).toMatchObject({ dockable: true, docked: true, width: 320 })
  })

  it('docks both panes from 860px (chat 400px beside both at their minimums)', () => {
    expect(computeGeometry(860, prefs())).toMatchObject({
      left: { docked: true, width: LEFT_MIN },
      right: { dockable: true, docked: true, width: RIGHT_MIN },
    })
    expect(computeGeometry(1024, prefs())).toMatchObject({
      left: { docked: true, width: 272 },
      right: { docked: true, width: 320 },
    })
  })

  it('docks only the left pane from 620px, and only drawers below that', () => {
    expect(computeGeometry(859, prefs())).toMatchObject({
      left: { dockable: true, docked: true },
      right: { dockable: false, docked: false },
    })
    for (const width of [619, 540, 400])
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
    expect(large.left.max).toBe(512)
    expect(large.right.max).toBe(Math.floor(1280 * 0.45))
    // Together they still leave the chat its minimum.
    expect(chatWidth(1280, large)).toBe(CHAT_MIN)
    expect(large.left.width).toBeGreaterThan(LEFT_MIN)
    expect(large.right.width).toBeGreaterThan(RIGHT_MIN)
  })

  it('never lets the chat column drop under CHAT_MIN while docked', () => {
    for (let width = 560; width <= 2200; width += 7)
      for (const leftOpen of [true, false])
        for (const leftWidth of [220, 272, 500, 1200])
          for (const rightWidth of [240, 320, 600, 1200]) {
            const g = computeGeometry(width, prefs({ leftWidth, rightWidth, leftOpen }))
            expect(
              chatWidth(width, g),
              `${String(width)} ${String(leftWidth)} ${String(rightWidth)} ${String(leftOpen)}`,
            ).toBeGreaterThanOrEqual(CHAT_MIN)
            for (const pane of [g.left, g.right]) {
              expect(pane.width).toBeGreaterThanOrEqual(pane.min)
              expect(pane.width).toBeLessThanOrEqual(pane.max)
            }
          }
  })

  it('shrinks both panes together (not just one) as the window narrows, then gives way', () => {
    // 1000px: 272 + 320 + 400 = 992 fits; the saved widths are kept.
    expect(computeGeometry(1000, prefs())).toMatchObject({
      left: { width: 272 },
      right: { docked: true, width: 320 },
    })
    // 900px: 40px over, taken from both in proportion to their slack.
    const tight = computeGeometry(900, prefs())
    expect(tight.left.width).toBeLessThan(272)
    expect(tight.right.width).toBeLessThan(320)
    expect(chatWidth(900, tight)).toBe(CHAT_MIN)
    // 859px: not even both minimums fit, the right pane is a drawer (rightOpen stays set).
    expect(computeGeometry(859, prefs()).right).toMatchObject({ dockable: false, docked: false })
    // Collapsing the left pane brings the right one back, beside the rail.
    expect(computeGeometry(700, prefs({ leftOpen: false })).right).toMatchObject({
      dockable: true,
      docked: true,
    })
    expect(
      computeGeometry(LEFT_RAIL + CHAT_MIN + RIGHT_MIN - 1, prefs({ leftOpen: false })).right,
    ).toMatchObject({ dockable: false })
  })

  it('gives the separators their limits', () => {
    const { left, right } = computeGeometry(1280, prefs())
    expect([left.min, left.max]).toEqual([LEFT_MIN, 512])
    expect([right.min, right.max]).toEqual([RIGHT_MIN, Math.floor(1280 * 0.45)])
  })
})

describe('clamp', () => {
  it('holds a value inside a range', () => {
    expect(clamp(5, 1, 10)).toBe(5)
    expect(clamp(0, 1, 10)).toBe(1)
    expect(clamp(11, 1, 10)).toBe(10)
  })
})
