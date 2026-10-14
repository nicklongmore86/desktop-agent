import { app, BrowserWindow, dialog, ipcMain, safeStorage, session, shell } from 'electron'
import { IpcChannels, type PushChannel, type PushPayloads } from '../shared/ipc'
import { cancelOnPageEnd } from './chat/lifecycle'
import { registerIpcHandlers } from './ipc-handlers'
import { isTrustedSenderFrame } from './security'
import { createAppServices } from './services'
import { appUrl, createMainWindow } from './window'

// Sandbox every renderer, even if a future window forgets to ask for it.
app.enableSandbox()

if (!app.requestSingleInstanceLock()) {
  app.quit()
}

let mainWindow: BrowserWindow | null = null

/** Sends a main -> renderer push to the app window, if it is still there. */
function push<C extends PushChannel>(channel: C, payload: PushPayloads[C]): void {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload)
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

void app.whenReady().then(async () => {
  hardenSessions()
  const services = await createAppServices({
    userData: app.getPath('userData'),
    safeStorage,
    trash: (path) => shell.trashItem(path),
    emit: (event) => {
      push(IpcChannels.chatEvent, event)
    },
    promptApproval: (prompt) => {
      push(IpcChannels.approvalRequest, prompt)
    },
    onAuditStatus: (status) => {
      push(IpcChannels.auditStatusChanged, status)
    },
  })
  const { chat } = services

  registerIpcHandlers(ipcMain, (event) => isTrustedSenderFrame(event.senderFrame, appUrl()), {
    appInfo: () => ({ name: app.getName(), version: app.getVersion(), platform: process.platform }),
    apiKey: services.apiKey,
    grants: services.grants,
    async pickFolder() {
      const options: Electron.OpenDialogOptions = {
        title: 'Grant folder access',
        buttonLabel: 'Grant access',
        properties: ['openDirectory'],
      }
      const result =
        mainWindow && !mainWindow.isDestroyed()
          ? await dialog.showOpenDialog(mainWindow, options)
          : await dialog.showOpenDialog(options)
      return result.canceled ? null : (result.filePaths[0] ?? null)
    },
    settings: services.settings,
    chat,
    audit: services.auditStatus,
  })

  const openWindow = (): void => {
    const window = createMainWindow()
    mainWindow = window
    // Reload, crash or close: deny pending approvals and stop the run.
    cancelOnPageEnd(window.webContents, () => {
      void chat.stop()
    })
    window.on('closed', () => {
      if (mainWindow === window) mainWindow = null
    })
  }
  openWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) openWindow()
  })
  app.on('before-quit', () => {
    void chat.stop()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
