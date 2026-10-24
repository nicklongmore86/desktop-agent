import { discoverRuntime, CLAUDE_VERSION, CODEX_VERSION } from './providers/runtime'
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  safeStorage,
  session,
  shell,
} from 'electron'
import { IpcChannels, type PushChannel, type PushPayloads } from '../shared/ipc'
import { filesPushChannels } from '../shared/ipc-files'
import { gitPushChannels } from '../shared/ipc-git'
import { nativeImageScaler } from './attachments/native-image'
import { cancelOnPageEnd } from './chat/lifecycle'
import { DocumentWorkerHost, documentWorkerPaths } from './documents/worker-host'
import { registerIpcHandlers } from './ipc-handlers'
import { isTrustedIpcSender } from './security'
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
  const window = mainWindow
  if (!window || window.isDestroyed() || window.webContents.isDestroyed()) return
  window.webContents.send(channel, payload)
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
  // One sandboxed document reader for the app: read_document and PDF attachments share it.
  const documents = new DocumentWorkerHost(documentWorkerPaths(__dirname))
  app.on('will-quit', () => {
    void documents.dispose()
  })
  const services = await createAppServices({
    documents,
    userData: app.getPath('userData'),
    openUrl: (url) => shell.openExternal(url),
    // Electron 44's main-process clipboard.writeText resolves once the text is written.
    copyText: async (text) => {
      await clipboard.writeText(text)
    },
    safeStorage,
    trash: (path) => shell.trashItem(path),
    revealPath: (path) => {
      shell.showItemInFolder(path)
    },
    onFilesChanged: (change) => {
      push(filesPushChannels.filesChanged, change)
    },
    onGitChanged: (change) => {
      push(gitPushChannels.gitChanged, change)
    },
    emit: (event) => {
      push(IpcChannels.chatEvent, event)
    },
    promptApproval: (prompt) => {
      push(IpcChannels.approvalRequest, prompt)
    },
    onAuditStatus: (status) => {
      push(IpcChannels.auditStatusChanged, status)
    },
    onProviderLoginState: (state) => {
      push(IpcChannels.providerLoginStateChanged, state)
    },
    imageScaler: nativeImageScaler,
    async pickFiles() {
      const options: Electron.OpenDialogOptions = {
        title: 'Attach files',
        buttonLabel: 'Attach',
        properties: ['openFile', 'multiSelections'],
      }
      const result =
        mainWindow && !mainWindow.isDestroyed()
          ? await dialog.showOpenDialog(mainWindow, options)
          : await dialog.showOpenDialog(options)
      return result.canceled ? [] : result.filePaths
    },
  })
  const { chat } = services

  // Only the app window's current main frame may call in, and only on an app URL.
  const isTrustedSender = (event: { senderFrame: { url: string; parent: unknown } | null }) => {
    const window = mainWindow
    if (!window || window.isDestroyed() || window.webContents.isDestroyed()) return false
    return isTrustedIpcSender(event.senderFrame, window.webContents.mainFrame, appUrl())
  }
  registerIpcHandlers(ipcMain, isTrustedSender, {
    appInfo: async () => ({
      name: app.getName(),
      version: app.getVersion(),
      platform: process.platform,
      runtimes: await Promise.all(
        (
          [
            ['claude', CLAUDE_VERSION],
            ['codex', CODEX_VERSION],
          ] as const
        ).map(async ([name, version]) => ({
          name,
          version,
          location: await discoverRuntime(name).catch(() => null),
        })),
      ),
    }),
    apiKey: services.apiKey,
    attachments: services.attachments,
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
    files: services.files,
    git: services.git,
    layout: {
      get: () => services.settings.layout,
      set: (layout) => services.settings.setLayout(layout),
    },
    projects: services.projects,
    provider: services.provider,
    chat,
    command: { run: (command, cwd) => chat.runCommand(command, cwd) },
    connections: services.connections,
    audit: services.auditStatus,
    revealAudit: () => {
      shell.showItemInFolder(services.auditStatus().path)
    },
  })

  const openWindow = (): void => {
    const window = createMainWindow()
    mainWindow = window
    // Reload, crash or close: deny pending approvals and stop the run.
    cancelOnPageEnd(window.webContents, () => {
      // The page that expanded those folders is gone; a reloaded one watches its own.
      services.files.close()
      services.git.close()
      void services.provider.cancelLogin()
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
    services.files.close()
    services.git.close()
    void services.provider.cancelLogin()
    void chat.stop()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
