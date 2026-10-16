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

describe('forced colors: the app shell', () => {
  const block = forcedColorsBlock()

  it('shows the drag handle with a system colour on hover, focus and drag', () => {
    const rule =
      /\.shell-separator:hover,\s*\.shell-separator:focus-visible,\s*\.shell-separator\[data-dragging\]\s*\{([^}]*)\}/.exec(
        block,
      )?.[1] ?? ''
    expect(rule).toMatch(/background:\s*Highlight/)
  })

  it('outlines the panes and drawers, and marks the open toggle and selected tab without colour alone', () => {
    expect(block).toMatch(
      /\.shell-pane-left[^{]*\.shell-drawer\s*\{[^}]*border-color:\s*CanvasText/,
    )
    expect(block).toMatch(
      /\.icon-button\[aria-expanded='true'\]\s*\{[^}]*border:\s*2px solid CanvasText/,
    )
    expect(block).toMatch(/\[aria-selected='true'\]\s*\{[^}]*border-bottom-color:\s*Highlight/)
  })
})

describe('forced colors: Chat | Command', () => {
  const block = forcedColorsBlock()

  it('outlines the switch, the command bar and command cards, and marks the chosen view', () => {
    expect(block).toMatch(
      /\.view-mode-toggle,\s*\.command-bar,\s*\.command-card\s*\{[^}]*border-color:\s*CanvasText/,
    )
    expect(block).toMatch(
      /\.view-mode-option\[aria-pressed='true'\]\s*\{[^}]*outline:\s*2px solid Highlight/,
    )
    expect(block).toMatch(/\.command-bar:focus-within\s*\{[^}]*outline:\s*2px solid CanvasText/)
  })
})
