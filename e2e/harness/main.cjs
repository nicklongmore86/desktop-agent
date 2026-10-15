// A minimal Electron main for rendering tests: the real renderer bundle
// (out/renderer) in a window with the app's secure web preferences and
// navigation hardening (as in src/main/window.ts), but with a fake preload API
// instead of the real main process. Run `pnpm build` first.
//
// The window has no minimum size: the tests deliberately go down to 360px,
// below the app's own minWidth (480), to check the narrowest layout.
const { app, BrowserWindow } = require('electron')
const { join } = require('node:path')
const { pathToFileURL } = require('node:url')
const { harnessWebPreferences } = require('./web-preferences.cjs')

const width = Number(process.env.E2E_WIDTH ?? 1280)
const height = Number(process.env.E2E_HEIGHT ?? 800)
const pageFile = join(__dirname, '../../out/renderer/index.html')
const pageUrl = pathToFileURL(pageFile).href

app.whenReady().then(() => {
  const window = new BrowserWindow({
    width,
    height,
    useContentSize: true,
    show: true,
    autoHideMenuBar: true,
    webPreferences: harnessWebPreferences(join(__dirname, 'preload.cjs')),
  })

  // Never open new windows, and never navigate away from the app page.
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  const blockExternalNavigation = (event, target) => {
    if (target.split('#')[0] !== pageUrl) event.preventDefault()
  }
  window.webContents.on('will-navigate', blockExternalNavigation)
  window.webContents.on('will-redirect', blockExternalNavigation)

  void window.loadFile(pageFile)
})

app.on('window-all-closed', () => {
  app.quit()
})
