/**
 * Connections: the ways the app can reach a model, each a vendor plus an access
 * type ("Claude by subscription", "Anthropic by API key"). Channel names, ids and
 * the descriptions main sends to the renderer. One of the per-feature IPC modules;
 * see docs/ipc-modules.md and docs/connections.md.
 *
 * No zod here, so the renderer bundle stays small. Main validates every id
 * against its adapter registry (src/main/providers/registry.ts).
 */
export const connectionsChannels = {
  connectionsList: 'connections:list',
  connectionsBaseUrl: 'connections:base-url',
  connectionsSetBaseUrl: 'connections:set-base-url',
} as const

/** Who serves the model. Add a vendor here before registering its first adapter. */
export const VENDORS = ['anthropic', 'openai', 'google', 'local', 'openrouter'] as const
export type Vendor = (typeof VENDORS)[number]

/** How the user pays for it: nothing, a consumer plan, or their own API key. */
export const ACCESS_TYPES = ['free', 'subscription', 'api-key'] as const
export type AccessType = (typeof ACCESS_TYPES)[number]

/**
 * A connection's stable id. It names the connection's history directory
 * (userData/history/<id>/) and key file (userData/secrets/<id>.enc), so it is
 * never renamed and is always a safe single path segment.
 */
export type ConnectionId = string
export const CONNECTION_ID = /^[a-z0-9][a-z0-9-]{0,63}$/

/** The built-in connections. Their ids are the old provider ids, so history stays where it is. */
export const ANTHROPIC_API = 'anthropic-api'
export const CLAUDE_SUBSCRIPTION = 'claude-subscription'
export const CODEX_SUBSCRIPTION = 'codex-subscription'
/** The direct API connections added after the first three. */
export const OPENAI_API = 'openai-api'
export const GEMINI_API = 'gemini-api'
export const OPENROUTER_API = 'openrouter-api'
export const OLLAMA = 'ollama'
export const LMSTUDIO = 'lmstudio'
/** In the order Settings lists them. */
export const BUILTIN_CONNECTIONS: readonly ConnectionId[] = [
  CLAUDE_SUBSCRIPTION,
  CODEX_SUBSCRIPTION,
  ANTHROPIC_API,
  OPENAI_API,
  GEMINI_API,
  OPENROUTER_API,
  OLLAMA,
  LMSTUDIO,
]
/** Used when nothing valid is saved: the same default as before connections existed. */
export const DEFAULT_CONNECTION: ConnectionId = ANTHROPIC_API

/**
 * How a connection signs in: through its bundled runtime's own login, with an
 * API key the user saves, a local server that needs neither, or not at all.
 */
export type AuthKind = 'runtime-login' | 'api-key' | 'local' | 'none'

export interface ConnectionCapabilities {
  authKind: AuthKind
  /** Offers a model list through provider.models() (otherwise there is no picker, or its own). */
  listsModels: boolean
  /** Reports plan limits as percentages (otherwise only the last known limit state). */
  reportsUsage: boolean
  /** Runs through a bundled, digest-checked runtime (Claude Code, Codex). */
  needsRuntime: boolean
}

/** What the renderer learns about a connection: labels and capabilities, never credentials. */
export interface ConnectionInfo {
  id: ConnectionId
  vendor: Vendor
  access: AccessType
  /** The composer picker and header: "Claude · Subscription". */
  label: string
  /** The chat list badge for another connection's chats: "Claude". */
  shortLabel: string
  /** The Settings card title and description. */
  title: string
  description: string
  /** The runtime it starts, for "Can't start …": "Claude Code". Absent without one. */
  runtimeLabel?: string
  capabilities: ConnectionCapabilities
  /** Allowed for the user's own use only; hidden when showPersonalUseConnections is off. */
  personalUseOnly: boolean
  /**
   * Position in the composer's picker, which predates connections and orders
   * them differently from Settings. Lower first.
   */
  pickerOrder: number
  /** Something the user should read before using it (Gemini's free-tier data use). */
  notice?: string
  /** A local server's default API root; present only when the base URL can be changed. */
  defaultBaseUrl?: string
}

/** A local connection's API root: the default, or the loopback URL the user chose. */
export interface ConnectionBaseUrl {
  baseUrl: string
  custom: boolean
  /** Why the last change was refused (not loopback, not a URL); null when it was saved. */
  error: string | null
}

export interface ConnectionsApi {
  connections: {
    /** The connections the user can choose, in Settings order. */
    list: () => Promise<ConnectionInfo[]>
    /** A local connection's API root. Rejects for a connection without one. */
    baseUrl: (connection: ConnectionId) => Promise<ConnectionBaseUrl>
    /** Main accepts loopback http URLs only; null goes back to the default. */
    setBaseUrl: (connection: ConnectionId, baseUrl: string | null) => Promise<ConnectionBaseUrl>
  }
}
