import type {
  LoginCodeResult,
  ProviderAllowance,
  ProviderFailure,
  ProviderModels,
  ProviderStatus,
} from '../../shared/ipc'
import type {
  AccessType,
  ConnectionCapabilities,
  ConnectionId,
  ConnectionInfo,
  Vendor,
} from '../../shared/ipc-connections'
import type { AgentTool } from '../agent'
import type { AgentRunner } from '../chat/session'
import type { ApiKeyStore } from '../secrets'
import type { SettingsStore } from '../storage/settings-store'
import type { RuntimeContext } from './codex'
import type { RuntimeName } from './runtime'

/** Who a connection is and what it can do. The renderer gets all of it: nothing here is secret. */
export interface ConnectionDescriptor {
  readonly id: ConnectionId
  readonly vendor: Vendor
  readonly access: AccessType
  readonly label: string
  readonly shortLabel: string
  readonly title: string
  readonly description: string
  readonly runtimeLabel?: string
  readonly capabilities: ConnectionCapabilities
  /** See docs/connections.md: hidden when settings.showPersonalUseConnections is off. */
  readonly personalUseOnly: boolean
  readonly pickerOrder: number
  /** Shown to the user before they use it (Gemini's free-tier data use). */
  readonly notice?: string
  /** A local server's default API root, when its base URL can be changed. */
  readonly defaultBaseUrl?: string
}

/**
 * One running sign-in. The service owns it: only one exists at a time, Cancel
 * aborts its signal, and the service reports its outcome.
 */
export interface LoginSession {
  readonly signal: AbortSignal
  /** A sign-in that prints a link and takes a pasted code hands that step over here. */
  attach: (prompt: LoginPrompt) => void
  /** The attached prompt has its validated link: tell Settings. */
  urlReady: () => void
}

/** The part of a sign-in Settings drives: the link main validated, and the pasted code. */
export interface LoginPrompt {
  readonly url: string | undefined
  submitCode: (code: unknown) => LoginCodeResult
}

/** A status check Cancel sign-in can abort; call done() when it ends. */
export interface TrackedCheck {
  signal: AbortSignal
  done: () => void
}

/** What the service gives every adapter. */
export interface AdapterHost {
  readonly userData: string
  readonly openUrl: (url: string) => Promise<void>
  readonly settings: SettingsStore | undefined
  /** Each API-key connection's own encrypted key. */
  readonly keys: { forConnection: (id: ConnectionId) => ApiKeyStore } | undefined
  /** Claude sign-in timeout (tests only). */
  readonly loginTimeout: number | undefined
  /**
   * The isolated, configuration-free directory and clean environment for a bundled
   * runtime, after discovery has checked its pinned version (and digest when packaged).
   */
  context: (runtime: RuntimeName, signal?: AbortSignal) => Promise<RuntimeContext>
  track: (signal?: AbortSignal) => TrackedCheck
}

/**
 * A connection: a descriptor plus the operations it supports. Register one with
 * ConnectionService.registerAdapter (see docs/connections.md). Optional operations
 * fall back to the service's defaults: no model list, no usage report, and for
 * login the status check (nothing to sign in to).
 */
export interface ConnectionAdapter extends ConnectionDescriptor {
  /** Never throws: a failure becomes a status with a safe message. */
  status: (signal?: AbortSignal) => Promise<ProviderStatus>
  /** Builds the runner for one Send; anything it throws goes through failure(). */
  runner: (tools: AgentTool[], signal?: AbortSignal) => Promise<AgentRunner>
  /** Maps any error to a code and a message written here; never forwards provider text. */
  failure: (error: unknown) => ProviderFailure
  models?: () => Promise<ProviderModels>
  setModel?: (model: string | null) => Promise<ProviderModels>
  allowance?: () => Promise<ProviderAllowance>
  /** Signs in; resolves once signed in. The service then re-reads status. */
  login?: (session: LoginSession) => Promise<void>
  /** Drops cached metadata (switch, sign-in, selection change). */
  invalidate?: () => void
  /**
   * Checks a key before it is saved, with a read-only request (never a completion).
   * Resolves with a safe failure for a key that must not be saved; never throws.
   */
  validateKey?: (key: string, signal?: AbortSignal) => Promise<ProviderFailure | null>
  /** The API root in use, for a connection with defaultBaseUrl. */
  baseUrl?: () => { baseUrl: string; custom: boolean }
  /** Saves a custom API root (null: the default). Throws a safe message for one it refuses. */
  setBaseUrl?: (baseUrl: string | null) => Promise<{ baseUrl: string; custom: boolean }>
}

/** Builds an adapter once the service (its host) exists. */
export type AdapterFactory = (host: AdapterHost) => ConnectionAdapter

export function connectionInfo(adapter: ConnectionDescriptor): ConnectionInfo {
  return {
    id: adapter.id,
    vendor: adapter.vendor,
    access: adapter.access,
    label: adapter.label,
    shortLabel: adapter.shortLabel,
    title: adapter.title,
    description: adapter.description,
    ...(adapter.runtimeLabel ? { runtimeLabel: adapter.runtimeLabel } : {}),
    capabilities: { ...adapter.capabilities },
    personalUseOnly: adapter.personalUseOnly,
    pickerOrder: adapter.pickerOrder,
    ...(adapter.notice ? { notice: adapter.notice } : {}),
    ...(adapter.defaultBaseUrl ? { defaultBaseUrl: adapter.defaultBaseUrl } : {}),
  }
}
