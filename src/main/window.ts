import { BrowserWindow, shell } from 'electron'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { isAppUrl, secureWebPreferences } from './security'

/** URL the main window loads: the Vite dev server in dev, the bundled index.html otherwise. */
export function appUrl(): string {
  const devServerUrl = process.env['ELECTRON_RENDERER_URL']
  if (devServerUrl) return devServerUrl
  return pathToFileURL(join(__dirname, '../renderer/index.html')).href
}

export function createMainWindow(): BrowserWindow {
  const url = appUrl()
  const window = new BrowserWindow({
    width: 1000,
    height: 720,
    minWidth: 480,
    minHeight: 400,
    show: false,
    title: 'Desktop Agent',
    autoHideMenuBar: true,
    webPreferences: secureWebPreferences(join(__dirname, '../preload/index.js')),
  })

  window.once('ready-to-show', () => {
    window.show()
  })

  // Never open new windows; hand http(s) links to the user's browser instead.
  window.webContents.setWindowOpenHandler(({ url: target }) => {
    if (/^https?:\/\//.test(target)) void shell.openExternal(target)
    return { action: 'deny' }
  })

  // Never navigate the app window away from the app.
  const blockExternalNavigation = (event: Electron.Event, target: string): void => {
    if (!isAppUrl(target, url)) event.preventDefault()
  }
  window.webContents.on('will-navigate', blockExternalNavigation)
  window.webContents.on('will-redirect', blockExternalNavigation)

  void window.loadURL(url)
  return window
}
