// A minimal Electron main for rendering tests: the real renderer bundle
// (out/renderer) in a window with the app's secure web preferences, but with
// a fake preload API instead of the real main process. Run `pnpm build` first.
const { app, BrowserWindow } = require('electron')
const { join } = require('node:path')

const width = Number(process.env.E2E_WIDTH ?? 1280)
const height = Number(process.env.E2E_HEIGHT ?? 800)

app.whenReady().then(() => {
  const window = new BrowserWindow({
    width,
    height,
    useContentSize: true,
    show: true,
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false,
    },
  })
  void window.loadFile(join(__dirname, '../../out/renderer/index.html'))
})

app.on('window-all-closed', () => {
  app.quit()
})
