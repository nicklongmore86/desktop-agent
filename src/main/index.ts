import { app, BrowserWindow, ipcMain, session } from 'electron'
import { IpcChannels, type AppInfo } from '../shared/ipc'
import { isAppUrl } from './security'
import { appUrl, createMainWindow } from './window'

// Sandbox every renderer, even if a future window forgets to ask for it.
app.enableSandbox()

if (!app.requestSingleInstanceLock()) {
  app.quit()
}

function registerIpcHandlers(): void {
  ipcMain.handle(IpcChannels.getAppInfo, (event): AppInfo => {
    const senderUrl = event.senderFrame?.url ?? ''
    if (!isAppUrl(senderUrl, appUrl())) {
      throw new Error(`Rejected IPC from untrusted frame: ${senderUrl}`)
    }
    return { name: app.getName(), version: app.getVersion(), platform: process.platform }
  })
}

function hardenSessions(): void {
  // The app needs no camera, mic, notifications, etc. yet: deny them all.
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false)
  })
  session.defaultSession.setPermissionCheckHandler(() => false)
}

// Applies to every webContents, including any created later.
app.on('web-contents-created', (_event, contents) => {
  contents.on('will-attach-webview', (event) => {
    event.preventDefault()
  })
  contents.setWindowOpenHandler(() => ({ action: 'deny' }))
})

app.on('second-instance', () => {
  const [window] = BrowserWindow.getAllWindows()
  if (window) {
    if (window.isMinimized()) window.restore()
    window.focus()
  }
})

void app.whenReady().then(() => {
  hardenSessions()
  registerIpcHandlers()
  createMainWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
