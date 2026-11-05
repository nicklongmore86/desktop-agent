import {
  app,
  dialog,
  Menu,
  shell,
  type BrowserWindow,
  type MenuItemConstructorOptions,
} from 'electron'
import { IpcChannels, type MenuCommand } from '../shared/ipc'
import { installDiagnostics } from './diagnostics'

export const ISSUES_URL = 'https://github.com/nicklongmore86/desktop-agent/issues'

export interface MenuActions {
  /** Passed to the page, which refuses it while an approval or a dialog is open. */
  command: (command: MenuCommand) => void
  about: () => void
  openLogsFolder: () => void
  reportIssue: () => void
}

export interface MenuOptions {
  isPackaged: boolean
  platform: NodeJS.Platform
  actions: MenuActions
}

/**
 * The application menu. Setting one replaces Electron's default menu, whose Reload and Toggle
 * Developer Tools items (Ctrl+R, Ctrl+Shift+I) are live in packaged builds too.
 *
 * New chat and Settings only show their keys: the page's own shortcuts (use-shortcuts.ts) answer
 * them, so registering them here as well would fire them twice.
 */
export function buildMenuTemplate(options: MenuOptions): MenuItemConstructorOptions[] {
  const { actions } = options
  return [
    // macOS shows the first menu under the app's name.
    ...(options.platform === 'darwin' ? [{ role: 'appMenu' } as const] : []),
    {
      label: '&File',
      submenu: [
        {
          id: 'new-chat',
          label: 'New chat',
          accelerator: 'CommandOrControl+N',
          registerAccelerator: false,
          click: () => {
            actions.command('new-chat')
          },
        },
        {
          id: 'settings',
          label: 'Settings',
          accelerator: 'CommandOrControl+,',
          registerAccelerator: false,
          click: () => {
            actions.command('open-settings')
          },
        },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: '&Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: '&View',
      submenu: [
        ...(options.isPackaged
          ? []
          : ([
              { role: 'reload' },
              { role: 'forceReload' },
              { role: 'toggleDevTools' },
              { type: 'separator' },
            ] as const)),
        { role: 'zoomIn' },
        // The role's own key is Plus, which Electron takes as Shift+=. These are the same action
        // on the unshifted key and the keypad, hidden so that View lists Zoom In once.
        { role: 'zoomIn', accelerator: 'CommandOrControl+=', visible: false },
        { role: 'zoomIn', accelerator: 'CommandOrControl+numadd', visible: false },
        { role: 'zoomOut' },
        { role: 'resetZoom' },
      ],
    },
    {
      label: '&Help',
      submenu: [
        {
          id: 'about',
          label: 'About Desktop Agent',
          click: () => {
            actions.about()
          },
        },
        {
          id: 'open-logs',
          label: 'Open logs folder',
          click: () => {
            actions.openLogsFolder()
          },
        },
        {
          id: 'report-issue',
          label: 'Report an issue',
          click: () => {
            actions.reportIssue()
          },
        },
      ],
    },
  ]
}

/**
 * The hooks index.ts needs: logging and crash handling from here on, the menu once the app is
 * ready, and attachWindow for the app window.
 */
export function startAppShell(): { attachWindow: (window: BrowserWindow) => void } {
  const diagnostics = installDiagnostics()
  let appWindow: BrowserWindow | null = null

  void app.whenReady().then(() => {
    const template = buildMenuTemplate({
      isPackaged: app.isPackaged,
      platform: process.platform,
      actions: {
        command: (command) => {
          if (!appWindow || appWindow.isDestroyed() || appWindow.webContents.isDestroyed()) return
          appWindow.webContents.send(IpcChannels.menuCommand, command)
        },
        about: () => {
          // Not a child of the window, so an approval in it can still be answered.
          void dialog.showMessageBox({
            type: 'info',
            title: 'About Desktop Agent',
            message: 'Desktop Agent',
            detail: `Version ${app.getVersion()}`,
            buttons: ['OK'],
          })
        },
        openLogsFolder: diagnostics.openLogsFolder,
        reportIssue: () => {
          shell.openExternal(ISSUES_URL).catch((error: unknown) => {
            diagnostics.logger.log('warn', 'could not open the issues page', error)
          })
        },
      },
    })
    Menu.setApplicationMenu(Menu.buildFromTemplate(template))
  })

  return {
    attachWindow(window) {
      appWindow = window
      diagnostics.watchWindow(window)
    },
  }
}
