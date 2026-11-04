import type { MenuItemConstructorOptions } from 'electron'
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({}))

const { buildMenuTemplate } = await import('./menu')

function template(isPackaged: boolean, platform: NodeJS.Platform = 'win32') {
  const actions = {
    command: vi.fn(),
    about: vi.fn(),
    openLogsFolder: vi.fn(),
    reportIssue: vi.fn(),
  }
  return { actions, menu: buildMenuTemplate({ isPackaged, platform, actions }) }
}

const items = (menu: MenuItemConstructorOptions[]): MenuItemConstructorOptions[] =>
  menu.flatMap((item) => [item, ...(Array.isArray(item.submenu) ? items(item.submenu) : [])])
const roles = (menu: MenuItemConstructorOptions[]): string[] =>
  items(menu).flatMap((item) => (item.role ? [item.role] : []))
const byId = (menu: MenuItemConstructorOptions[], id: string): MenuItemConstructorOptions => {
  const found = items(menu).find((item) => item.id === id)
  if (!found) throw new Error(`no menu item ${id}`)
  return found
}
const click = (item: MenuItemConstructorOptions): void => {
  ;(item.click as () => void)()
}

describe('buildMenuTemplate', () => {
  it('has File, Edit, View and Help, in that order', () => {
    expect(template(true).menu.map((item) => item.label)).toEqual([
      '&File',
      '&Edit',
      '&View',
      '&Help',
    ])
  })

  it('offers no reload or developer tools in a packaged build, by any role or key', () => {
    const { menu } = template(true)
    for (const role of ['reload', 'forceReload', 'toggleDevTools']) {
      expect(roles(menu)).not.toContain(role)
    }
    const keys = items(menu).flatMap((item) => (item.accelerator ? [item.accelerator] : []))
    expect(keys.filter((key) => /\+R$|\+I$|F5|F12/i.test(key))).toEqual([])
  })

  it('offers reload and developer tools in dev', () => {
    expect(roles(template(false).menu)).toEqual(
      expect.arrayContaining(['reload', 'forceReload', 'toggleDevTools']),
    )
  })

  it('keeps the standard edit and zoom roles in both builds', () => {
    for (const packaged of [true, false]) {
      expect(roles(template(packaged).menu)).toEqual(
        expect.arrayContaining([
          'undo',
          'redo',
          'cut',
          'copy',
          'paste',
          'selectAll',
          'zoomIn',
          'zoomOut',
          'resetZoom',
          'quit',
        ]),
      )
    }
  })

  it('zooms in on Ctrl+= and the keypad by hidden items, and lists Zoom In once', () => {
    const zoomIn = items(template(true).menu).filter((item) => item.role === 'zoomIn')
    expect(zoomIn.filter((item) => item.visible !== false)).toEqual([{ role: 'zoomIn' }])
    expect(zoomIn.filter((item) => item.visible === false).map((item) => item.accelerator)).toEqual(
      ['CommandOrControl+=', 'CommandOrControl+numadd'],
    )
  })

  it('shows Ctrl+N and Ctrl+, without registering them, so the page answers them once', () => {
    const { menu } = template(true)
    for (const [id, key] of [
      ['new-chat', 'CommandOrControl+N'],
      ['settings', 'CommandOrControl+,'],
    ] as const) {
      expect(byId(menu, id)).toMatchObject({ accelerator: key, registerAccelerator: false })
    }
  })

  it('passes New chat and Settings to the page, and nothing else', () => {
    const { menu, actions } = template(true)
    click(byId(menu, 'new-chat'))
    click(byId(menu, 'settings'))
    expect(actions.command.mock.calls).toEqual([['new-chat'], ['open-settings']])
    click(byId(menu, 'about'))
    click(byId(menu, 'open-logs'))
    click(byId(menu, 'report-issue'))
    expect(actions.command).toHaveBeenCalledTimes(2)
    expect(actions.about).toHaveBeenCalledOnce()
    expect(actions.openLogsFolder).toHaveBeenCalledOnce()
    expect(actions.reportIssue).toHaveBeenCalledOnce()
  })

  it('adds the app menu on macOS only', () => {
    expect(roles(template(true, 'darwin').menu)).toContain('appMenu')
    expect(roles(template(true).menu)).not.toContain('appMenu')
  })
})
