import { contextBridge, ipcRenderer } from 'electron'
import { IpcChannels, type DesktopApi, type PushChannel, type PushPayloads } from '../shared/ipc'

/** Subscribes to a main -> renderer push; the listener never sees the IPC event object. */
function subscribe<C extends PushChannel>(
  channel: C,
  listener: (payload: PushPayloads[C]) => void,
): () => void {
  const wrapped = (_event: Electron.IpcRendererEvent, payload: PushPayloads[C]): void => {
    listener(payload)
  }
  ipcRenderer.on(channel, wrapped)
  return () => {
    ipcRenderer.removeListener(channel, wrapped)
  }
}

const invoke = <T>(channel: string, ...args: unknown[]): Promise<T> =>
  ipcRenderer.invoke(channel, ...args) as Promise<T>

// Expose narrow, typed functions only — never ipcRenderer itself.
const api: DesktopApi = {
  provider: {
    get: () => invoke(IpcChannels.providerGet),
    set: (provider) => invoke(IpcChannels.providerSet, provider),
    login: () => invoke(IpcChannels.providerLogin),
    cancelLogin: () => invoke(IpcChannels.providerCancelLogin),
    loginState: () => invoke(IpcChannels.providerLoginState),
    openLoginUrl: () => invoke(IpcChannels.providerOpenLoginUrl),
    copyLoginUrl: () => invoke(IpcChannels.providerCopyLoginUrl),
    submitLoginCode: (code) => invoke(IpcChannels.providerSubmitLoginCode, code),
  },
  getAppInfo: () => invoke(IpcChannels.getAppInfo),
  apiKey: {
    status: () => invoke(IpcChannels.apiKeyStatus),
    set: (key) => invoke(IpcChannels.apiKeySet, key),
    clear: () => invoke(IpcChannels.apiKeyClear),
  },
  grants: {
    list: () => invoke(IpcChannels.grantsList),
    add: () => invoke(IpcChannels.grantsAdd),
    remove: (root) => invoke(IpcChannels.grantsRemove, root),
  },
  model: {
    get: () => invoke(IpcChannels.modelGet),
    set: (model) => invoke(IpcChannels.modelSet, model),
  },
  chat: {
    load: () => invoke(IpcChannels.chatLoad),
    send: (text) => invoke(IpcChannels.chatSend, text),
    stop: () => invoke(IpcChannels.chatStop),
    newChat: () => invoke(IpcChannels.chatNew),
  },
  approvals: {
    respond: (id, approved) => invoke(IpcChannels.approvalRespond, id, approved),
  },
  audit: {
    status: () => invoke(IpcChannels.auditStatus),
  },
  onChatEvent: (listener) => subscribe(IpcChannels.chatEvent, listener),
  onApprovalRequest: (listener) => subscribe(IpcChannels.approvalRequest, listener),
  onAuditStatus: (listener) => subscribe(IpcChannels.auditStatusChanged, listener),
  onProviderLoginState: (listener) => subscribe(IpcChannels.providerLoginStateChanged, listener),
}

contextBridge.exposeInMainWorld('desktopApi', api)
