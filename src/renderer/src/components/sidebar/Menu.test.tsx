import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { Menu } from './Menu'

function setup() {
  const onClose = vi.fn()
  render(
    <div>
      <div data-testid="transcript" />
      <div data-testid="list">
        <Menu
          label="Options"
          position={{ top: 0, left: 0 }}
          items={[{ label: 'Delete…', onSelect: () => undefined }]}
          onClose={onClose}
        />
      </div>
    </div>,
  )
  return onClose
}

describe('Menu scroll handling', () => {
  it('stays open while an unrelated box scrolls (the transcript following a tool step)', () => {
    const onClose = setup()
    const item = screen.getByRole('menuitem', { name: 'Delete…' })
    expect(document.activeElement).toBe(item)
    fireEvent.scroll(screen.getByTestId('transcript'))
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.queryByRole('menu')).not.toBeNull()
    expect(document.activeElement).toBe(item)
  })

  it('closes when the box it sits in scrolls, or the page does', () => {
    const onClose = setup()
    fireEvent.scroll(screen.getByTestId('list'))
    expect(onClose).toHaveBeenCalledWith(false)
    onClose.mockClear()
    fireEvent.scroll(document)
    expect(onClose).toHaveBeenCalledWith(false)
  })

  it('closes on resize', () => {
    const onClose = setup()
    fireEvent(window, new Event('resize'))
    expect(onClose).toHaveBeenCalledWith(false)
  })
})
