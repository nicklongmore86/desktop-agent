import { describe, expect, it } from 'vitest'
import tokens from './tokens.css?raw'

type Palette = Record<string, string>

/** `--color-name: #rrggbb;` declarations inside the first block that follows `selector`. */
function palette(selector: string): Palette {
  const start = tokens.indexOf(selector)
  expect(start, `${selector} block`).toBeGreaterThanOrEqual(0)
  const body = tokens.slice(tokens.indexOf('{', start) + 1, tokens.indexOf('}', start))
  const result: Palette = {}
  for (const match of body.matchAll(/(--color-[a-z0-9-]+):\s*(#[0-9a-f]{6})\s*;/gi))
    result[match[1] as string] = (match[2] as string).toLowerCase()
  return result
}

const light = palette(':root {')
const darkSystem = palette(":root:not([data-theme='light']) {")
const darkForced = palette(":root[data-theme='dark'] {")

const channel = (value: number): number => {
  const c = value / 255
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}
function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16)
  return 0.2126 * channel(n >> 16) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255)
}
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number]
  return (hi + 0.05) / (lo + 0.05)
}

/** [foreground, background, minimum ratio]: 4.5 for text (WCAG AA), 3 for UI outlines and the focus ring. */
const SURFACES = ['--color-surface-0', '--color-surface-1', '--color-surface-2']
const PAIRS: [string, string, number][] = [
  ...SURFACES.flatMap((s): [string, string, number][] => [
    ['--color-text', s, 4.5],
    ['--color-text-muted', s, 4.5],
  ]),
  ...[...SURFACES, '--color-accent-bg'].map((s): [string, string, number] => [
    '--color-accent-text',
    s,
    4.5,
  ]),
  ['--color-on-accent', '--color-accent', 4.5],
  ['--color-on-accent', '--color-accent-hover', 4.5],
  ['--color-text', '--color-accent-bg', 4.5],
  ['--color-text-muted', '--color-accent-bg', 4.5],
  ['--color-on-danger', '--color-danger', 4.5],
  ['--color-danger-text', '--color-surface-0', 4.5],
  ['--color-danger-text', '--color-surface-1', 4.5],
  ['--color-danger-text', '--color-danger-bg', 4.5],
  ['--color-text', '--color-danger-bg', 4.5],
  ['--color-warning-text', '--color-surface-0', 4.5],
  ['--color-warning-text', '--color-warning-bg', 4.5],
  ['--color-text', '--color-warning-bg', 4.5],
  ['--color-success-text', '--color-surface-0', 4.5],
  ['--color-success-text', '--color-success-bg', 4.5],
  ['--color-diff-add-text', '--color-diff-add-bg', 4.5],
  ['--color-diff-del-text', '--color-diff-del-bg', 4.5],
  ['--color-border-control', '--color-surface-0', 3],
  ['--color-border-control', '--color-surface-1', 3],
  ['--color-accent', '--color-surface-0', 3],
  ['--color-accent', '--color-surface-1', 3],
]

describe.each([
  ['light', light],
  ['dark (system)', darkSystem],
  ['dark (forced)', darkForced],
])('%s theme contrast', (_name, colors) => {
  it.each(PAIRS)('%s on %s is at least %s:1', (fg, bg, minimum) => {
    const fgColor = colors[fg]
    const bgColor = colors[bg]
    expect(fgColor, fg).toBeDefined()
    expect(bgColor, bg).toBeDefined()
    expect(contrast(fgColor as string, bgColor as string)).toBeGreaterThanOrEqual(minimum)
  })
})

describe('theme blocks', () => {
  it('keep the two dark blocks identical and only override roles the light theme defines', () => {
    expect(darkForced).toEqual(darkSystem)
    for (const name of Object.keys(darkSystem)) expect(light, name).toHaveProperty(name)
  })

  it('forces the colour scheme with the theme', () => {
    expect(tokens).toMatch(/:root\s*\{\s*color-scheme:\s*light;/)
    expect(tokens).toMatch(/:root\[data-theme='dark'\]\s*\{\s*color-scheme:\s*dark;/)
  })
})
