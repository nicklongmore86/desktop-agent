/** IPC channel names shared by the main process and the preload script. */
export const IpcChannels = {
  getAppInfo: 'app:get-info',

  apiKeyStatus: 'api-key:status',
  apiKeySet: 'api-key:set',
  apiKeyClear: 'api-key:clear',

  grantsList: 'grants:list',
  grantsAdd: 'grants:add',
  grantsRemove: 'grants:remove',

  providerGet: 'provider:get',
  providerSet: 'provider:set',
  providerLogin: 'provider:login',
  providerCancelLogin: 'provider:cancel-login',
  modelGet: 'model:get',
  modelSet: 'model:set',

  chatLoad: 'chat:load',
  chatSend: 'chat:send',
  chatStop: 'chat:stop',
  chatNew: 'chat:new',

  approvalRespond: 'approval:respond',
  auditStatus: 'audit:status',

  // Main -> renderer pushes (webContents.send).
  chatEvent: 'chat:event',
  approvalRequest: 'approval:request',
  auditStatusChanged: 'audit:status-changed',
} as const

export const PROVIDERS = ['anthropic-api', 'claude-subscription', 'codex-subscription'] as const
export type ProviderId = (typeof PROVIDERS)[number]
export interface ProviderStatus {
  provider: ProviderId
  state: 'ready' | 'missing-runtime' | 'signed-out' | 'unsupported' | 'error'
  message: string
}

export interface AppInfo {
  name: string
  version: string
  platform: string
}

/** The renderer only ever learns whether a key is saved, never the key. */
export interface ApiKeyStatus {
  saved: boolean
  /** Set when the stored key cannot be read (corrupt, or OS encryption unavailable). */
  error: string | null
}

export interface GrantsState {
  roots: string[]
  /** Set when grants.json existed but could not be read; the app then has no grants. */
  loadError: string | null
}

export type GrantAddResult =
  | { status: 'added'; root: string; grants: GrantsState }
  | { status: 'cancelled'; grants: GrantsState }
  | { status: 'refused'; reason: string; grants: GrantsState }

export interface ModelOption {
  id: string
  label: string
}

export interface ModelSettings {
  model: string
  defaultModel: string
  options: ModelOption[]
}

export interface AuditStatus {
  healthy: boolean
  /** Where the audit log lives, to show in Settings. */
  path: string
}

/** Agent error codes, plus the session's own (no key, already running, ...). */
export type ChatErrorCode =
  | 'authentication'
  | 'invalid_request'
  | 'permission'
  | 'rate_limit'
  | 'overloaded'
  | 'network'
  | 'api'
  | 'aborted'
  | 'max_turns'
  | 'max_tokens'
  | 'refusal'
  | 'context_limit'
  | 'protocol'
  | 'no_api_key'
  | 'key_unreadable'
  | 'busy'
  | 'internal'

/** What the chat view shows for a saved conversation. Built in main from Messages-API history. */
export type ChatItem =
  | { kind: 'user'; id: string; text: string }
  | { kind: 'assistant'; id: string; text: string }
  | {
      kind: 'tool'
      id: string
      name: string
      input: unknown
      result: { content: string; isError: boolean } | null
    }

export interface ChatState {
  items: ChatItem[]
  running: boolean
  /** Set when the saved conversation could not be read; the app then starts a fresh one. */
  loadError: string | null
}

export type SendResult = { ok: true } | { ok: false; code: ChatErrorCode; message: string }

/** Streamed main -> renderer while a run is in flight. */
export type ChatEvent =
  | { type: 'run_started'; runId: string; text: string }
  | { type: 'text_delta'; runId: string; turn: number; text: string }
  /** The turn's response was dropped (truncated tool calls): remove its streamed text. */
  | { type: 'response_discarded'; runId: string; turn: number }
  | { type: 'tool_use'; runId: string; turn: number; id: string; name: string; input: unknown }
  | { type: 'tool_result'; runId: string; id: string; content: string; isError: boolean }
  | { type: 'approval_closed'; approvalId: string; approved: boolean }
  | { type: 'error'; runId: string; code: ChatErrorCode; message: string }
  | { type: 'run_finished'; runId: string; stopReason: string }
  /** New chat: the conversation is now empty. */
  | { type: 'conversation_reset'; state?: ChatState }
  /** Saving or deleting the conversation on disk failed. */
  | { type: 'storage_warning'; message: string }

export type ApprovalKind = 'write' | 'move' | 'delete' | 'shell'

export interface ApprovalPrompt {
  /** Random per request; the response must quote it. */
  id: string
  runId: string
  /** The tool call this approval belongs to, when known. */
  toolUseId: string | null
  tool: string
  kind: ApprovalKind
  summary: string
  /** Unified diff for writes; the exact shell, cwd and command for run_shell. */
  detail: string | null
}

/** The main -> renderer channels and their payloads; the preload only subscribes to these. */
export interface PushPayloads {
  [IpcChannels.chatEvent]: ChatEvent
  [IpcChannels.approvalRequest]: ApprovalPrompt
  [IpcChannels.auditStatusChanged]: AuditStatus
}
export type PushChannel = keyof PushPayloads

type Unsubscribe = () => void

/** The API the preload script exposes to the renderer as `window.desktopApi`. */
export interface DesktopApi {
  provider: {
    get: () => Promise<ProviderStatus>
    set: (provider: ProviderId) => Promise<ProviderStatus>
    login: () => Promise<ProviderStatus>
    cancelLogin: () => Promise<void>
  }
  getAppInfo: () => Promise<AppInfo>
  apiKey: {
    status: () => Promise<ApiKeyStatus>
    set: (key: string) => Promise<ApiKeyStatus>
    clear: () => Promise<ApiKeyStatus>
  }
  grants: {
    list: () => Promise<GrantsState>
    /** Opens a native folder picker in main; the renderer cannot name the folder. */
    add: () => Promise<GrantAddResult>
    remove: (root: string) => Promise<GrantsState>
  }
  model: {
    get: () => Promise<ModelSettings>
    set: (model: string) => Promise<ModelSettings>
  }
  chat: {
    load: () => Promise<ChatState>
    send: (text: string) => Promise<SendResult>
    stop: () => Promise<void>
    newChat: () => Promise<ChatState>
  }
  approvals: {
    respond: (id: string, approved: boolean) => Promise<void>
  }
  audit: {
    status: () => Promise<AuditStatus>
  }
  onChatEvent: (listener: (event: ChatEvent) => void) => Unsubscribe
  onApprovalRequest: (listener: (prompt: ApprovalPrompt) => void) => Unsubscribe
  onAuditStatus: (listener: (status: AuditStatus) => void) => Unsubscribe
}
