import type { ConnectionId } from './ipc-connections'
import type { FeatureApis } from './ipc-features'
import { filesPushChannels, type FilesChanged } from './ipc-files'
import { gitPushChannels, type GitChanged } from './ipc-git'

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
  providerLoginState: 'provider:login-state',
  providerOpenLoginUrl: 'provider:open-login-url',
  providerCopyLoginUrl: 'provider:copy-login-url',
  providerSubmitLoginCode: 'provider:submit-login-code',
  providerModels: 'provider:models',
  providerSetModel: 'provider:set-model',
  providerAllowance: 'provider:allowance',
  modelGet: 'model:get',
  modelSet: 'model:set',
  themeGet: 'theme:get',
  themeSet: 'theme:set',

  chatLoad: 'chat:load',
  chatSend: 'chat:send',
  chatStop: 'chat:stop',
  chatNew: 'chat:new',
  chatHistory: 'chat:history',
  chatOpen: 'chat:open',
  chatRename: 'chat:rename',
  chatDelete: 'chat:delete',

  approvalRespond: 'approval:respond',
  auditStatus: 'audit:status',
  auditReveal: 'audit:reveal',

  // Main -> renderer pushes (webContents.send).
  chatEvent: 'chat:event',
  approvalRequest: 'approval:request',
  auditStatusChanged: 'audit:status-changed',
  providerLoginStateChanged: 'provider:login-state-changed',
} as const

/**
 * The provider payloads below carry a connection id (src/shared/ipc-connections.ts)
 * in their `provider` field; main checks every id it is sent against its registry.
 */
export interface ProviderStatus {
  provider: ConnectionId
  state:
    | 'ready'
    | 'missing-runtime'
    | 'signed-out'
    | 'unsupported'
    | 'error'
    | 'limited'
    | 'not-entitled'
  /** Independent of entitlement/allowance; present when auth state can be determined. */
  signedIn?: boolean
  availability?: 'available' | 'blocked' | 'unknown'
  failure?: ProviderFailure
  message: string
}

/** The sign-in main is running, so Settings can show it again after being reopened. */
export interface ProviderLoginState {
  /** The connection signing in, or null when no sign-in is running. */
  provider: ConnectionId | null
  active: boolean
  /** Claude's validated sign-in link, once the runtime has printed it. */
  url: string | null
  /** Set on the push that ends a sign-in: its outcome. */
  result: ProviderStatus | null
}

export type LoginCodeResult = { ok: true } | { ok: false; error: string }

/** The colour theme: follow the operating system, or force light or dark. */
export const THEMES = ['system', 'light', 'dark'] as const
export type ThemePreference = (typeof THEMES)[number]

export interface AppInfo {
  runtimes?: { name: string; version: string; location: string | null }[]
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

export interface ProviderFailure {
  code: ChatErrorCode
  message: string
  /** ISO 8601 UTC, when the runtime supplies a reset time. */
  resetsAt?: string
}

/** Serializable metadata outcome: Electron invoke rejections drop custom Error fields. */
export type ProviderResult<T> = { ok: true; value: T } | { ok: false; failure: ProviderFailure }

export interface ProviderModel extends ModelOption {
  defaultReasoningEffort: string | null
  supportedReasoningEfforts: string[]
  isDefault: boolean
  /** Whether the server says the model can call tools; absent when the list does not say. */
  toolSupport?: 'supported' | 'unknown'
}
export interface ProviderModels {
  provider: ConnectionId
  options: ProviderModel[]
  /** Effective choice after validating the saved preference against the catalog. */
  selectedModel: string | null
  savedModel: string | null
  defaultModel: string | null
  resolvedModel: string | null
  /** Shown with the list: local servers do not say which models can use tools. */
  warning?: string
}
export interface AllowanceWindow {
  limitId: string
  remainingPercent: number
  resetsAt: string | null
  /** User-facing window name from the runtime's window length ("weekly limit"); absent when unknown. */
  label?: string
}
export interface ProviderAllowance {
  /** Availability flags only; balances and account details stay in main. */
  credits?: { hasCredits: boolean; unlimited: boolean }
  provider: ConnectionId
  plan: string | null
  state: 'available' | 'limited' | 'unknown'
  /** Advisory reset time when limited; never proof of recovered usage permission. */
  resetsAt: string | null
  windows: AllowanceWindow[]
  lastError: ProviderFailure | null
}

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
  | 'usage_limit'
  | 'plan_not_entitled'
  | 'model_unavailable'
  | 'auth_expired'
  | 'runtime_unavailable'
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

/** A tool call's result as the chat view shows it. */
export interface ToolResultView {
  content: string
  isError: boolean
  /**
   * Set only by main: true when the call failed because the user declined its approval.
   * Live results always carry it. Undefined only for a result from a chat saved before
   * main recorded it (and for agent tool results reloaded from history, which the
   * Messages API cannot carry it in); the view then falls back to the tools' wording.
   */
  declined?: boolean
}

/** What the chat view shows for a saved conversation. Built in main from Messages-API history. */
export type ChatItem =
  | { kind: 'user'; id: string; text: string }
  | { kind: 'assistant'; id: string; text: string }
  | {
      kind: 'tool'
      id: string
      name: string
      input: unknown
      result: ToolResultView | null
      /** Set for a command the user typed in the command bar (not the agent's call). */
      origin?: 'user-terminal'
    }

/** One saved conversation in the history list. Times are milliseconds since the epoch. */
export interface ConversationSummary {
  id: string
  /** Plain text: control and bidi formatting characters are removed in main. */
  title: string
  createdAt: number
  updatedAt: number
  /** Pinned chats list first, oldest pin at the top. Unset: not pinned. */
  pinnedAt?: number
  /** Archived chats are hidden from the list until restored. Unset: not archived. */
  archivedAt?: number
  /** The project (src/shared/ipc-projects.ts) the chat is filed in. Unset: none. */
  projectId?: string
  /** Set on a fork: the chat it was copied from, and how many messages it kept (null: all). */
  forkedFrom?: { id: string; atMessageIndex: number | null }
}

/** The current provider's saved conversations, newest first, and the one that is open. */
export interface HistoryState {
  conversations: ConversationSummary[]
  /** Null for a new chat that has not been saved yet. */
  activeId: string | null
}

export interface ChatState {
  items: ChatItem[]
  running: boolean
  /** Set when the saved conversation could not be read; the app then starts a fresh one. */
  loadError: string | null
  /** Always sent by main; optional so older snapshots (and tests) can leave it out. */
  history?: HistoryState
}

export type SendResult =
  { ok: true } | { ok: false; code: ChatErrorCode; message: string; resetsAt?: string }

/** Streamed main -> renderer while a run is in flight. */
export type ChatEvent =
  | { type: 'run_started'; runId: string; text: string }
  /** A command typed in the command bar started; its result comes as a tool_result. */
  | { type: 'command_started'; runId: string; id: string; command: string; cwd: string }
  | { type: 'text_delta'; runId: string; turn: number; text: string }
  /** The turn's response was dropped (truncated tool calls): remove its streamed text. */
  | { type: 'response_discarded'; runId: string; turn: number }
  | { type: 'tool_use'; runId: string; turn: number; id: string; name: string; input: unknown }
  | {
      type: 'tool_result'
      runId: string
      id: string
      content: string
      isError: boolean
      /** The user declined the call's approval (see ToolResultView.declined). */
      declined: boolean
    }
  | { type: 'approval_closed'; approvalId: string; approved: boolean }
  | { type: 'error'; runId: string; code: ChatErrorCode; message: string; resetsAt?: string }
  | { type: 'run_finished'; runId: string; stopReason: string }
  /** Another conversation (or provider) is now open; `state` is its history. */
  | { type: 'conversation_reset'; state?: ChatState }
  /** The history list changed: a chat was saved, renamed or deleted. */
  | { type: 'history_changed'; history: HistoryState }
  /** Saving or deleting the conversation on disk failed. */
  | { type: 'storage_warning'; message: string }

export type ApprovalKind = 'write' | 'move' | 'delete' | 'shell'

/** Who asked: the agent, the user typing in the command bar, or the user acting in the app. */
export type ApprovalOrigin = 'agent' | 'user-terminal' | 'user'

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
  /** Main always sets it; absent (older prompts, tests) means the agent. */
  origin?: ApprovalOrigin
}

/** The main -> renderer channels and their payloads; the preload only subscribes to these. */
export interface PushPayloads {
  [IpcChannels.chatEvent]: ChatEvent
  [IpcChannels.approvalRequest]: ApprovalPrompt
  [IpcChannels.auditStatusChanged]: AuditStatus
  [IpcChannels.providerLoginStateChanged]: ProviderLoginState
  [filesPushChannels.filesChanged]: FilesChanged
  [gitPushChannels.gitChanged]: GitChanged
}
export type PushChannel = keyof PushPayloads

type Unsubscribe = () => void

/** The API the preload script exposes to the renderer as `window.desktopApi`. */
export interface DesktopApi extends FeatureApis {
  provider: {
    models: () => Promise<ProviderResult<ProviderModels>>
    setModel: (model: string | null) => Promise<ProviderResult<ProviderModels>>
    allowance: () => Promise<ProviderResult<ProviderAllowance>>
    get: () => Promise<ProviderStatus>
    set: (provider: ConnectionId) => Promise<ProviderStatus>
    login: () => Promise<ProviderStatus>
    cancelLogin: () => Promise<void>
    loginState: () => Promise<ProviderLoginState>
    /** Re-opens the sign-in link main validated; takes no URL. */
    openLoginUrl: () => Promise<void>
    /** Copies the sign-in link main validated to the clipboard; takes no URL. */
    copyLoginUrl: () => Promise<void>
    /** Main validates the code before passing it to the waiting runtime. */
    submitLoginCode: (code: string) => Promise<LoginCodeResult>
  }
  getAppInfo: () => Promise<AppInfo>
  /** Each API-key connection has its own key; leaving out the connection means Anthropic API. */
  apiKey: {
    status: (connection?: ConnectionId) => Promise<ApiKeyStatus>
    set: (key: string, connection?: ConnectionId) => Promise<ApiKeyStatus>
    clear: (connection?: ConnectionId) => Promise<ApiKeyStatus>
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
  theme: {
    get: () => Promise<ThemePreference>
    /** Saves the choice and answers with what is now stored. */
    set: (theme: ThemePreference) => Promise<ThemePreference>
  }
  chat: {
    load: () => Promise<ChatState>
    send: (text: string) => Promise<SendResult>
    stop: () => Promise<void>
    newChat: () => Promise<ChatState>
    /** The current provider's saved conversations. */
    history: () => Promise<HistoryState>
    /** Opens a saved conversation; stops a running reply first, like a provider switch. */
    open: (id: string) => Promise<ChatState>
    rename: (id: string, title: string) => Promise<HistoryState>
    /** Deletes a saved conversation; deleting the open one starts a new chat. */
    remove: (id: string) => Promise<HistoryState>
  }
  approvals: {
    respond: (id: string, approved: boolean) => Promise<void>
  }
  audit: {
    reveal: () => Promise<void>
    status: () => Promise<AuditStatus>
  }
  onChatEvent: (listener: (event: ChatEvent) => void) => Unsubscribe
  onApprovalRequest: (listener: (prompt: ApprovalPrompt) => void) => Unsubscribe
  onAuditStatus: (listener: (status: AuditStatus) => void) => Unsubscribe
  onProviderLoginState: (listener: (state: ProviderLoginState) => void) => Unsubscribe
}
