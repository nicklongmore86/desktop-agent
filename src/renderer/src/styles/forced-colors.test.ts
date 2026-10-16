import { describe, expect, it } from 'vitest'
import css from './components.css?raw'

/** The text of the first `@media (forced-colors: active) { ... }` block. */
function forcedColorsBlock(): string {
  const start = css.indexOf('@media (forced-colors: active)')
  expect(start).toBeGreaterThanOrEqual(0)
  let depth = 0
  for (let i = css.indexOf('{', start); i < css.length; i += 1) {
    if (css[i] === '{') depth += 1
    if (css[i] === '}') depth -= 1
    if (depth === 0) return css.slice(start, i + 1)
  }
  throw new Error('unterminated forced-colors block')
}

describe('forced colors (Windows High Contrast)', () => {
  const block = forcedColorsBlock()

  it('keeps flagged characters solid, outlined and out of automatic colour adjustment', () => {
    const rule = /\.unsafe-char\s*\{([^}]*)\}/.exec(block)?.[1] ?? ''
    expect(rule).toContain('forced-color-adjust: none')
    expect(rule).toMatch(/background:\s*Highlight/)
    expect(rule).toMatch(/color:\s*HighlightText/)
    expect(rule).toMatch(/border:\s*1px solid CanvasText/)
  })

  it('keeps a visible focus ring', () => {
    expect(block).toMatch(/:focus-visible[^{]*\{[^}]*outline:\s*2px solid CanvasText/)
  })
})
