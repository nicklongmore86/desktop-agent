import {
  IpcChannels,
  PROVIDERS,
  type ProviderId,
  type DesktopApi,
  type ApiKeyStatus,
  type AppInfo,
  type AuditStatus,
  type ChatState,
  type GrantAddResult,
  type GrantsState,
  type ModelSettings,
  type SendResult,
} from '../shared/ipc'
import type { AddGrantResult } from './permissions'

/** The parts of an IPC invoke event the handlers look at. */
export interface IpcSenderEvent {
  senderFrame: { url: string; parent: unknown } | null
}

/** The part of Electron's ipcMain the handlers use. */
export interface IpcMainLike {
  handle: (
    channel: string,
    listener: (event: IpcSenderEvent, ...args: unknown[]) => unknown,
  ) => void
}

export interface ApiKeyService {
  hasKey: () => Promise<boolean>
  set: (key: string) => Promise<void>
  clear: () => Promise<void>
}

export interface GrantService {
  list: () => readonly string[]
  readonly loadError: string | null
  add: (folder: string) => Promise<AddGrantResult>
  remove: (folder: string) => Promise<boolean>
}

export interface ChatService {
  state: () => ChatState
  send: (text: unknown) => Promise<SendResult>
  stop: () => Promise<void>
  newChat: () => Promise<ChatState>
  respondApproval: (id: unknown, approved: unknown) => boolean
}

export interface IpcServices {
  provider: DesktopApi['provider']
  appInfo: () => AppInfo
  apiKey: ApiKeyService
  grants: GrantService
  /** Shows the native folder picker; resolves to the chosen folder or null if cancelled. */
  pickFolder: () => Promise<string | null>
  settings: {
    view: () => ModelSettings
    setModel: (model: string) => Promise<ModelSettings>
  }
  chat: ChatService
  audit: () => AuditStatus
}

/** Messages the stores throw are written for users and never contain the key. */
function messageOf(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback
}

/**
 * Registers every renderer -> main handler. Each one first checks that the
 * call comes from the app's own top-level frame (`isTrustedSender`) and
 * rejects anything else before looking at its arguments.
 */
export function registerIpcHandlers(
  ipc: IpcMainLike,
  isTrustedSender: (event: IpcSenderEvent) => boolean,
  services: IpcServices,
): void {
  const handle = (channel: string, handler: (...args: unknown[]) => unknown): void => {
    ipc.handle(channel, (event, ...args) => {
      if (!isTrustedSender(event)) {
        throw new Error(`Rejected IPC from untrusted frame: ${event.senderFrame?.url ?? ''}`)
      }
      return handler(...args)
    })
  }

  const keyStatus = async (): Promise<ApiKeyStatus> => {
    try {
      return { saved: await services.apiKey.hasKey(), error: null }
    } catch (error) {
      return { saved: false, error: messageOf(error, 'The saved API key cannot be read.') }
    }
  }
  const grantsState = (): GrantsState => ({
    roots: [...services.grants.list()],
    loadError: services.grants.loadError,
  })

  handle(IpcChannels.getAppInfo, () => services.appInfo())

  handle(IpcChannels.apiKeyStatus, keyStatus)
  handle(IpcChannels.apiKeySet, async (key) => {
    if (typeof key !== 'string' || !key.trim() || key.length > 1000)
      return { saved: (await keyStatus()).saved, error: 'Enter a valid API key.' }
    try {
      await services.apiKey.set(key.trim())
    } catch (error) {
      return { saved: false, error: messageOf(error, 'Could not save the API key.') }
    }
    return keyStatus()
  })
  handle(IpcChannels.apiKeyClear, async () => {
    try {
      await services.apiKey.clear()
    } catch (error) {
      return { saved: true, error: messageOf(error, 'Could not clear the API key.') }
    }
    return keyStatus()
  })

  handle(IpcChannels.grantsList, grantsState)
  // Takes no arguments on purpose: the folder always comes from the native picker.
  handle(IpcChannels.grantsAdd, async (): Promise<GrantAddResult> => {
    const folder = await services.pickFolder()
    if (folder === null) return { status: 'cancelled', grants: grantsState() }
    const result = await services.grants.add(folder)
    return result.ok
      ? { status: 'added', root: result.root, grants: grantsState() }
      : { status: 'refused', reason: result.reason, grants: grantsState() }
  })
  handle(IpcChannels.grantsRemove, async (root) => {
    // Revoking can only narrow access, and only an existing grant matches.
    if (typeof root === 'string' && services.grants.list().includes(root)) {
      await services.grants.remove(root)
    }
    return grantsState()
  })

  handle(IpcChannels.providerModels, () => services.provider.models())
  handle(IpcChannels.providerAllowance, () => services.provider.allowance())
  handle(IpcChannels.providerSetModel, (model) => {
    if (
      model !== null &&
      (typeof model !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(model))
    )
      return {
        ok: false,
        failure: { code: 'model_unavailable', message: 'Choose an available model.' },
      }
    return services.provider.setModel(model)
  })
  handle(IpcChannels.providerGet, () => services.provider.get())
  handle(IpcChannels.providerSet, (provider) => {
    if (!PROVIDERS.includes(provider as ProviderId)) throw new Error('Unknown provider.')
    return services.provider.set(provider as ProviderId)
  })
  handle(IpcChannels.providerLogin, () => services.provider.login())
  handle(IpcChannels.providerCancelLogin, () => services.provider.cancelLogin())
  handle(IpcChannels.providerLoginState, () => services.provider.loginState())
  // No URL argument: main only ever opens or copies the link it validated itself.
  handle(IpcChannels.providerOpenLoginUrl, () => services.provider.openLoginUrl())
  handle(IpcChannels.providerCopyLoginUrl, () => services.provider.copyLoginUrl())
  handle(IpcChannels.providerSubmitLoginCode, (code) =>
    typeof code === 'string'
      ? services.provider.submitLoginCode(code)
      : { ok: false, error: 'Enter the sign-in code.' },
  )

  handle(IpcChannels.modelGet, () => services.settings.view())
  handle(IpcChannels.modelSet, async (model) => {
    if (typeof model !== 'string') throw new Error('Unknown model.')
    return services.settings.setModel(model)
  })

  handle(IpcChannels.chatLoad, () => services.chat.state())
  handle(IpcChannels.chatSend, (text) => services.chat.send(text))
  handle(IpcChannels.chatStop, () => services.chat.stop())
  handle(IpcChannels.chatNew, () => services.chat.newChat())
  handle(IpcChannels.approvalRespond, (id, approved) => {
    services.chat.respondApproval(id, approved)
  })

  handle(IpcChannels.auditStatus, () => services.audit())
}
