import { describe, expect, it } from 'vitest'
import base from './base.css?raw'
import css from './components.css?raw'
import tokens from './tokens.css?raw'

/** The declarations of the first rule whose selector is exactly `selector`. */
function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = new RegExp(`(?:^|\\})\\s*${escaped}\\s*\\{([^}]*)\\}`, 'm').exec(css)
  expect(match, `${selector} rule`).not.toBeNull()
  return match?.[1] ?? ''
}

describe('shell styles', () => {
  it('defines the shell tokens in tokens.css', () => {
    for (const name of [
      '--duration-panel',
      '--separator-size',
      '--drawer-width',
      '--drawer-gutter',
      '--sidebar-width-left',
      '--sidebar-width-right',
    ])
      expect(tokens).toContain(`${name}:`)
  })

  it('animates the panes with the panel duration, but only after the saved layout has loaded', () => {
    expect(rule('.app[data-animated] .shell-pane')).toMatch(/width var\(--duration-panel\)/)
    expect(rule('.shell-pane')).not.toMatch(/transition/)
    // Dragging follows the pointer without easing.
    expect(rule('.app[data-resizing] .shell-pane')).toMatch(/transition:\s*none/)
  })

  it('collapses a pane to no width, no border and hidden', () => {
    const collapsed = rule(".shell-pane[data-open='false']")
    expect(collapsed).toMatch(/width:\s*0/)
    expect(collapsed).toMatch(/border-width:\s*0/)
    expect(collapsed).toMatch(/visibility:\s*hidden/)
  })

  it('turns every transition and animation off for prefers-reduced-motion', () => {
    const start = base.indexOf('@media (prefers-reduced-motion: reduce)')
    expect(start).toBeGreaterThanOrEqual(0)
    const block = base.slice(start, base.indexOf('\n}\n', start))
    expect(block).toMatch(/\*,\s*\*::before,\s*\*::after/)
    expect(block).toMatch(/animation-duration:\s*0\.01ms !important/)
    expect(block).toMatch(/transition-duration:\s*0\.01ms !important/)
    // The panes and drawers use transition/animation (not a JS timer), so that rule covers them.
    expect(css).not.toMatch(/setTimeout|requestAnimationFrame/)
  })

  it('makes the drawers fill the window but for a strip of the chat at 540px and under', () => {
    const start = css.indexOf('@media (max-width: 540px)')
    expect(css.slice(start, start + 400)).toMatch(
      /\.shell-drawer\s*\{\s*width:\s*calc\(100% - var\(--drawer-gutter\)\)/,
    )
  })

  it('keeps the separator a 4px handle that does not take layout space', () => {
    const separator = rule('.shell-separator')
    expect(separator).toMatch(/flex:\s*0 0 var\(--separator-size\)/)
    expect(separator).toMatch(/margin:\s*0 calc\(-1 \* var\(--separator-size\) \/ 2\)/)
    expect(separator).toMatch(/touch-action:\s*none/)
  })
})
