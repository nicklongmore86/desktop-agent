import { fireEvent, render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { matchLayoutHotkey, useLayoutHotkeys, type LayoutHotkey } from './use-shortcuts'

type Keys = Parameters<typeof matchLayoutHotkey>[0]
const press = (changes: Partial<Keys>): Keys => ({
  code: 'BracketLeft',
  ctrlKey: true,
  metaKey: false,
  altKey: true,
  shiftKey: false,
  repeat: false,
  defaultPrevented: false,
  ...changes,
})

describe('matchLayoutHotkey', () => {
  it('maps Ctrl+Alt+[ and ] to the left and right sidebars, by physical key', () => {
    expect(matchLayoutHotkey(press({}))).toBe('left')
    expect(matchLayoutHotkey(press({ code: 'BracketRight' }))).toBe('right')
    // Cmd+Alt on a Mac.
    expect(matchLayoutHotkey(press({ ctrlKey: false, metaKey: true }))).toBe('left')
  })

  it('ignores key repeat, AltGraph, other keys and other modifiers', () => {
    expect(matchLayoutHotkey(press({ repeat: true }))).toBeNull()
    expect(matchLayoutHotkey(press({ getModifierState: (key) => key === 'AltGraph' }))).toBeNull()
    expect(matchLayoutHotkey(press({ getModifierState: () => false }))).toBe('left')
    expect(matchLayoutHotkey(press({ code: 'KeyA' }))).toBeNull()
    expect(matchLayoutHotkey(press({ altKey: false }))).toBeNull()
    expect(matchLayoutHotkey(press({ ctrlKey: false }))).toBeNull()
    expect(matchLayoutHotkey(press({ shiftKey: true }))).toBeNull()
    expect(matchLayoutHotkey(press({ defaultPrevented: true }))).toBeNull()
  })
})

function Host({
  onToggle,
  disabled,
}: {
  onToggle: (side: LayoutHotkey) => void
  disabled: boolean
}) {
  useLayoutHotkeys(onToggle, disabled)
  return null
}

describe('useLayoutHotkeys', () => {
  const key = (init: KeyboardEventInit) =>
    fireEvent.keyDown(document.body, { ctrlKey: true, altKey: true, ...init })

  it('toggles on the shortcut, and prevents the default action', () => {
    const onToggle = vi.fn()
    render(<Host onToggle={onToggle} disabled={false} />)
    expect(key({ code: 'BracketLeft' })).toBe(false)
    key({ code: 'BracketRight' })
    expect(onToggle.mock.calls).toEqual([['left'], ['right']])
  })

  it('does nothing for AltGraph, repeats, or while disabled (an approval is open)', () => {
    const onToggle = vi.fn()
    const view = render(<Host onToggle={onToggle} disabled={false} />)
    key({ code: 'BracketLeft', modifierAltGraph: true })
    key({ code: 'BracketLeft', repeat: true })
    expect(onToggle).not.toHaveBeenCalled()
    view.rerender(<Host onToggle={onToggle} disabled />)
    key({ code: 'BracketLeft' })
    expect(onToggle).not.toHaveBeenCalled()
  })
})
