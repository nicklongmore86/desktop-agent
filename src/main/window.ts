import { app, BrowserWindow, type WebPreferences } from 'electron'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { appIconPath } from './app-icon'
import { attachContextMenu, type ContextMenuOptions } from './context-menu'
import { openWebLink } from './web-links'
import { isAppUrl, isLoopbackHttpUrl, secureWebPreferences } from './security'
import { DEFAULT_WINDOW_SIZE, MIN_WINDOW_SIZE, type Rect } from './window-state'

/**
 * URL the main window loads: the Vite dev server in dev, the bundled index.html otherwise.
 * ELECTRON_RENDERER_URL is ignored in packaged builds and must be a loopback http URL,
 * so the environment can't point the window (and its preload API) at a remote page.
 */
export function appUrl(): string {
  const devServerUrl = process.env['ELECTRON_RENDERER_URL']
  if (!app.isPackaged && devServerUrl && isLoopbackHttpUrl(devServerUrl)) return devServerUrl
  return pathToFileURL(join(__dirname, '../renderer/index.html')).href
}

/**
 * The app window's webPreferences: the shared secure set, and in a packaged build also no
 * developer tools. The menu's Toggle Developer Tools and F12 / Ctrl+Shift+I are then dead too,
 * a second lock beside the menu leaving them out. Development and test builds keep them.
 */
export function windowWebPreferences(preload: string, packaged: boolean): WebPreferences {
  return { ...secureWebPreferences(preload), ...(packaged ? { devTools: false } : {}) }
}

export function createMainWindow(
  options: ContextMenuOptions & { bounds?: Rect | undefined },
): BrowserWindow {
  const url = appUrl()
  const icon = appIconPath()
  const window = new BrowserWindow({
    ...(options.bounds ?? DEFAULT_WINDOW_SIZE),
    minWidth: MIN_WINDOW_SIZE.width,
    minHeight: MIN_WINDOW_SIZE.height,
    show: false,
    title: 'Desktop Agent',
    ...(icon ? { icon } : {}),
    autoHideMenuBar: true,
    webPreferences: windowWebPreferences(join(__dirname, '../preload/index.js'), app.isPackaged),
  })

  window.once('ready-to-show', () => {
    window.show()
  })

  // Never open new windows; hand http(s) links to the user's browser instead.
  window.webContents.setWindowOpenHandler(({ url: target }) => {
    openWebLink(target)
    return { action: 'deny' }
  })

  // Never navigate the app window away from the app.
  const blockExternalNavigation = (event: Electron.Event, target: string): void => {
    if (!isAppUrl(target, url)) event.preventDefault()
  }
  window.webContents.on('will-navigate', blockExternalNavigation)
  window.webContents.on('will-redirect', blockExternalNavigation)

  attachContextMenu(window.webContents, options)

  void window.loadURL(url)
  return window
}
