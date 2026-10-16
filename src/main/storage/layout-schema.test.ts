import { describe, expect, it } from 'vitest'
import { DEFAULT_LAYOUT, PANE_MAX } from '../../shared/ipc-layout'
import { parseLayout } from './layout-schema'

describe('parseLayout', () => {
  it('keeps a valid layout', () => {
    const layout = {
      version: 1,
      leftOpen: false,
      leftWidth: 300,
      rightOpen: false,
      rightWidth: 400,
      rightTab: 'git',
    }
    expect(parseLayout(layout)).toEqual(layout)
  })

  it.each([undefined, null, 'x', 7, [], {}, { version: 2 }, { version: 0 }, { version: '1' }])(
    'gives the defaults for a missing, old or unknown-version value (%j)',
    (input) => {
      expect(parseLayout(input)).toEqual(DEFAULT_LAYOUT)
    },
  )

  it('resets only the bad fields', () => {
    expect(
      parseLayout({
        version: 1,
        leftOpen: 'yes',
        leftWidth: 'wide',
        rightOpen: false,
        rightWidth: Number.NaN,
        rightTab: 'terminal',
      }),
    ).toEqual({ ...DEFAULT_LAYOUT, rightOpen: false })
  })

  it('rounds and clamps widths', () => {
    expect(parseLayout({ version: 1, leftWidth: 12, rightWidth: 99999 })).toMatchObject({
      leftWidth: 220,
      rightWidth: PANE_MAX,
    })
    expect(parseLayout({ version: 1, leftWidth: 300.6 }).leftWidth).toBe(301)
    expect(parseLayout({ version: 1, leftWidth: Infinity }).leftWidth).toBe(
      DEFAULT_LAYOUT.leftWidth,
    )
  })

  it('drops unknown keys, so a path can never be stored', () => {
    const parsed = parseLayout({
      ...DEFAULT_LAYOUT,
      folder: 'C:\\Users\\me',
      expandedDirs: { a: ['b'] },
    })
    expect(parsed).toEqual(DEFAULT_LAYOUT)
    expect(Object.keys(parsed).sort()).toEqual(Object.keys(DEFAULT_LAYOUT).sort())
  })
})
