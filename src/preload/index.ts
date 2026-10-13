import { contextBridge, ipcRenderer } from 'electron'
import { IpcChannels, type AppInfo, type DesktopApi } from '../shared/ipc'

// Expose narrow, typed functions only — never ipcRenderer itself.
const api: DesktopApi = {
  getAppInfo: () => ipcRenderer.invoke(IpcChannels.getAppInfo) as Promise<AppInfo>,
}

contextBridge.exposeInMainWorld('desktopApi', api)
