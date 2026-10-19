import { describe, expect, it } from 'vitest'
import components from './components.css?raw'
import files from './files.css?raw'

/** The declaration blocks whose selector list names exactly `.<name>` (not `.x-<name>`). */
function blocks(css: string, name: string): string[] {
  const selector = new RegExp(`(?<![\\w-])\\.${name}(?![\\w-])`)
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter((m) => selector.test(m[1] as string))
    .map((m) => m[2] as string)
}

describe('drop hints', () => {
  it('keeps the sidebar chat-drag hint inline text, not an overlay', () => {
    const rules = [...blocks(components, 'drop-hint'), ...blocks(files, 'drop-hint')]
    expect(rules.length).toBeGreaterThan(0)
    for (const rule of rules) expect(rule).not.toMatch(/position|inset|z-index|pointer-events/)
  })

  it('styles the external-file overlay under its own class', () => {
    expect(blocks(files, 'external-drop-hint').join('')).toMatch(/position:\s*absolute/)
    expect(blocks(components, 'external-drop-hint')).toEqual([])
  })
})
