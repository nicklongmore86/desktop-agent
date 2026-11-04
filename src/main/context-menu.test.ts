import { beforeEach, describe, expect, it, vi } from 'vitest'

const electron = vi.hoisted(() => {
  const popup = vi.fn()
  return { popup, Menu: { buildFromTemplate: vi.fn(() => ({ popup })) } }
})
vi.mock('electron', () => electron)

const { attachContextMenu } = await import('./context-menu')

const flags = {
  canUndo: false,
  canRedo: false,
  canCut: false,
  canCopy: true,
  canPaste: true,
  canSelectAll: true,
}

describe('attachContextMenu', () => {
  beforeEach(() => {
    electron.popup.mockClear()
    electron.Menu.buildFromTemplate.mockClear()
  })

  function listener(): (event: unknown, params: unknown) => void {
    const on = vi.fn()
    attachContextMenu({ on } as never)
    expect(on).toHaveBeenCalledWith('context-menu', expect.any(Function))
    const call = on.mock.calls[0] as [string, (event: unknown, params: unknown) => void]
    return call[1]
  }

  it('pops up a native menu for an editable field', () => {
    listener()(
      {},
      { isEditable: true, selectionText: '', formControlType: 'text-area', editFlags: flags },
    )
    expect(electron.Menu.buildFromTemplate).toHaveBeenCalledOnce()
    expect(electron.popup).toHaveBeenCalledOnce()
  })

  it('pops up nothing when there is nothing to offer', () => {
    listener()(
      {},
      { isEditable: false, selectionText: '', formControlType: 'none', editFlags: flags },
    )
    expect(electron.popup).not.toHaveBeenCalled()
  })
})
