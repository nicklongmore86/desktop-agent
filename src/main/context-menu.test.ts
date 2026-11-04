import { beforeEach, describe, expect, it, vi } from 'vitest'

const electron = vi.hoisted(() => {
  const popup = vi.fn()
  return {
    popup,
    Menu: { buildFromTemplate: vi.fn((_template: unknown) => ({ popup })) },
    clipboard: { writeText: vi.fn(() => Promise.resolve()) },
    shell: { openExternal: vi.fn(() => Promise.resolve()) },
  }
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

  it('opens and copies an http(s) link, and nothing for other schemes', () => {
    const fire = listener()
    const items = (linkURL: string): { label?: string; click?: () => void }[] => {
      electron.Menu.buildFromTemplate.mockClear()
      fire({}, { isEditable: false, selectionText: '', linkURL, editFlags: flags })
      const call = electron.Menu.buildFromTemplate.mock.calls[0]
      return (call?.[0] ?? []) as { label?: string; click?: () => void }[]
    }
    const web = items('https://example.com/x')
    web.find((i) => i.label === 'Open Link')?.click?.()
    web.find((i) => i.label === 'Copy Link Address')?.click?.()
    expect(electron.shell.openExternal).toHaveBeenCalledWith('https://example.com/x')
    expect(electron.clipboard.writeText).toHaveBeenCalledWith('https://example.com/x')
    electron.popup.mockClear()
    expect(items('javascript:alert(1)')).toEqual([])
    expect(electron.popup).not.toHaveBeenCalled()
  })
})
