import { beforeEach, describe, expect, it, vi } from 'vitest'

const electron = vi.hoisted(() => {
  const popup = vi.fn()
  return {
    popup,
    Menu: { buildFromTemplate: vi.fn((_template: unknown) => ({ popup })) },
    clipboard: { writeText: vi.fn(() => Promise.resolve()) },
    shell: { openExternal: vi.fn(() => Promise.resolve()) },
    dialog: { showMessageBox: vi.fn((..._args: unknown[]) => Promise.resolve({ response: 0 })) },
    BrowserWindow: { fromWebContents: vi.fn(() => ({ id: 'main-window' })) },
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
  let approval = false
  beforeEach(() => {
    approval = false
    electron.popup.mockClear()
    electron.Menu.buildFromTemplate.mockClear()
    electron.shell.openExternal.mockClear()
    electron.clipboard.writeText.mockClear()
    electron.dialog.showMessageBox.mockReset()
    electron.dialog.showMessageBox.mockResolvedValue({ response: 0 })
  })

  function listener(): (event: unknown, params: unknown) => void {
    const on = vi.fn()
    attachContextMenu({ on } as never, { approvalOpen: () => approval })
    expect(on).toHaveBeenCalledWith('context-menu', expect.any(Function))
    const call = on.mock.calls[0] as [string, (event: unknown, params: unknown) => void]
    return call[1]
  }

  type Item = { label?: string; click?: () => void }
  function items(
    fire: (event: unknown, params: unknown) => void,
    linkURL: string,
    linkText = '',
  ): Item[] {
    electron.Menu.buildFromTemplate.mockClear()
    fire({}, { isEditable: false, selectionText: '', linkURL, linkText, editFlags: flags })
    const call = electron.Menu.buildFromTemplate.mock.calls[0]
    return (call?.[0] ?? []) as Item[]
  }
  const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

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

  it('opens and copies an http(s) link, and nothing for other schemes', async () => {
    const fire = listener()
    const web = items(fire, 'https://example.com/x', 'the docs')
    web.find((i) => i.label === 'Open Link')?.click?.()
    web.find((i) => i.label === 'Copy Link Address')?.click?.()
    await settle()
    expect(electron.dialog.showMessageBox).not.toHaveBeenCalled()
    expect(electron.shell.openExternal).toHaveBeenCalledWith('https://example.com/x')
    expect(electron.clipboard.writeText).toHaveBeenCalledWith('https://example.com/x')
    electron.popup.mockClear()
    expect(items(fire, 'javascript:alert(1)')).toEqual([])
    expect(electron.popup).not.toHaveBeenCalled()
  })

  it('does not ask when the text names the same site, or is not an address', async () => {
    const fire = listener()
    for (const text of ['https://example.com', 'www.example.com/y', 'README.md', '']) {
      items(fire, 'https://example.com/x', text)
        .find((i) => i.label === 'Open Link')
        ?.click?.()
    }
    await settle()
    expect(electron.dialog.showMessageBox).not.toHaveBeenCalled()
    expect(electron.shell.openExternal).toHaveBeenCalledTimes(4)
  })

  describe('a link whose text names another site', () => {
    const url = 'https://exаmple.com/a\u202Eb' // Cyrillic a, and a direction override

    it('asks first, naming the real destination in visible text, with Cancel as the default', async () => {
      const fire = listener()
      items(fire, url, 'https://paypal.com')
        .find((i) => i.label === 'Open Link')
        ?.click?.()
      await settle()
      expect(electron.dialog.showMessageBox).toHaveBeenCalledOnce()
      const [window, box] = electron.dialog.showMessageBox.mock.calls[0] as [
        unknown,
        { detail: string; buttons: string[]; defaultId: number; cancelId: number },
      ]
      expect(window).toEqual({ id: 'main-window' })
      expect(box.buttons).toEqual(['Cancel', 'Open in browser'])
      expect(box.defaultId).toBe(0)
      expect(box.cancelId).toBe(0)
      expect(box.detail).toContain('paypal.com')
      expect(box.detail).toContain('xn--exmple-4nf.com')
      expect(box.detail).toContain('%E2%80%AEb')
      // eslint-disable-next-line no-control-regex
      expect(box.detail).not.toMatch(/[^\u0009\u000A\u0020-\u007E]/)
      expect(electron.shell.openExternal).not.toHaveBeenCalled()
    })

    it('opens only when the user picks Open in browser', async () => {
      const fire = listener()
      electron.dialog.showMessageBox.mockResolvedValue({ response: 1 })
      items(fire, 'https://evil.test/', 'https://paypal.com')
        .find((i) => i.label === 'Open Link')
        ?.click?.()
      await settle()
      expect(electron.shell.openExternal).toHaveBeenCalledWith('https://evil.test/')
    })

    it('does not ask for Copy Link Address', async () => {
      const fire = listener()
      items(fire, 'https://evil.test/', 'https://paypal.com')
        .find((i) => i.label === 'Copy Link Address')
        ?.click?.()
      await settle()
      expect(electron.dialog.showMessageBox).not.toHaveBeenCalled()
      expect(electron.clipboard.writeText).toHaveBeenCalledWith('https://evil.test/')
    })

    it('takes a link that was already open from the menu back if an approval arrives while asking', async () => {
      const fire = listener()
      electron.dialog.showMessageBox.mockImplementation(() => {
        approval = true
        return Promise.resolve({ response: 1 })
      })
      items(fire, 'https://evil.test/', 'https://paypal.com')
        .find((i) => i.label === 'Open Link')
        ?.click?.()
      await settle()
      expect(electron.shell.openExternal).not.toHaveBeenCalled()
    })
  })

  describe('while an approval is showing', () => {
    it('offers no Open Link, but still Copy Link Address', () => {
      approval = true
      const labels = items(listener(), 'https://example.com/x', 'x').map((i) => i.label)
      expect(labels).toEqual(['Copy Link Address'])
    })

    it('ignores an Open Link that was already on screen when the approval arrived', async () => {
      const fire = listener()
      const menu = items(fire, 'https://example.com/x', 'x')
      approval = true
      menu.find((i) => i.label === 'Open Link')?.click?.()
      await settle()
      expect(electron.shell.openExternal).not.toHaveBeenCalled()
      expect(electron.dialog.showMessageBox).not.toHaveBeenCalled()
    })
  })
})
