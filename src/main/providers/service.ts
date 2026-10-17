import type {
  LoginCodeResult,
  ProviderAllowance,
  ProviderFailure,
  ProviderModels,
  ProviderLoginState,
  ProviderStatus,
} from '../../shared/ipc'
import type { ConnectionId } from '../../shared/ipc-connections'
import type { AgentTool } from '../agent'
import type { AgentRunner } from '../chat/session'
import type { KeyStore } from '../secrets'
import type { SettingsStore } from '../storage/settings-store'
import { createAnthropicApiAdapter } from './adapters/anthropic-api'
import { createClaudeSubscriptionAdapter } from './adapters/claude-subscription'
import { createCodexSubscriptionAdapter } from './adapters/codex-subscription'
import type {
  AdapterFactory,
  AdapterHost,
  ConnectionAdapter,
  LoginPrompt,
  TrackedCheck,
} from './connection'
import type { RuntimeContext } from './codex'
import { SubscriptionError } from './errors'
import { isolatedContext } from './isolation'
import { ConnectionRegistry } from './registry'
import type { RuntimeName } from './runtime'

export interface ConnectionOptions {
  /** Every sign-in change: started, Claude's validated link, finished (with its outcome). */
  onLoginState?: (state: ProviderLoginState) => void
  settings?: SettingsStore
  /** The per-connection encrypted API keys. */
  keys?: KeyStore
  /** Claude sign-in timeout (tests only). */
  loginTimeout?: number
  /** Replaces the built-in adapters (tests). */
  adapters?: readonly AdapterFactory[]
}

/** The built-in connections, in the order Settings lists them. */
export const BUILTIN_ADAPTERS: readonly AdapterFactory[] = [
  createClaudeSubscriptionAdapter,
  createCodexSubscriptionAdapter,
  createAnthropicApiAdapter,
]

interface ActiveLogin {
  provider: ConnectionId
  controller: AbortController
  prompt?: LoginPrompt
}

/**
 * Every connection behind one interface. Main calls this with a connection id;
 * the registry's adapter does the connection's own work. The service keeps what
 * spans connections: one sign-in at a time, Cancel (which also aborts status
 * checks), and dropping cached metadata on a switch.
 */
export class ConnectionService implements AdapterHost {
  readonly registry = new ConnectionRegistry()
  private readonly checks = new Set<AbortController>()
  /** At most one sign-in at a time; a second request is refused until this one ends. */
  private active: ActiveLogin | undefined
  constructor(
    readonly userData: string,
    readonly openUrl: (url: string) => Promise<void>,
    private readonly options: ConnectionOptions = {},
  ) {
    for (const create of options.adapters ?? BUILTIN_ADAPTERS) this.registerAdapter(create)
  }

  get settings(): SettingsStore | undefined {
    return this.options.settings
  }
  get keys(): KeyStore | undefined {
    return this.options.keys
  }
  get loginTimeout(): number | undefined {
    return this.options.loginTimeout
  }

  /** Adds a connection. Throws for a duplicate or malformed id (see docs/connections.md). */
  registerAdapter(create: AdapterFactory): ConnectionAdapter {
    const adapter = create(this)
    this.registry.register(adapter)
    return adapter
  }

  context(runtime: RuntimeName, signal?: AbortSignal): Promise<RuntimeContext> {
    return isolatedContext(this.userData, runtime, signal)
  }

  track(signal?: AbortSignal): TrackedCheck {
    const controller = new AbortController()
    this.checks.add(controller)
    return {
      signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
      done: () => {
        this.checks.delete(controller)
      },
    }
  }

  /** The validated link of the sign-in in progress, if it has printed one. */
  get loginUrl(): string | undefined {
    return this.active?.prompt?.url
  }

  /** What Settings needs to show the sign-in in progress again after it was closed. */
  loginState(): ProviderLoginState {
    const active = this.active
    return active
      ? { provider: active.provider, active: true, url: active.prompt?.url ?? null, result: null }
      : { provider: null, active: false, url: null, result: null }
  }

  /** Re-opens the same validated link; the renderer never supplies a URL. */
  async openLoginUrl(): Promise<void> {
    const url = this.loginUrl
    if (!url) throw new Error('No sign-in link is waiting.')
    await this.openUrl(url)
  }

  submitLoginCode(code: unknown): LoginCodeResult {
    const prompt = this.active?.prompt
    if (!prompt) return { ok: false, error: 'Sign-in is no longer waiting for a code.' }
    return prompt.submitCode(code)
  }

  async models(provider: ConnectionId): Promise<ProviderModels> {
    const adapter = this.registry.require(provider)
    if (adapter.models) return adapter.models()
    return {
      provider,
      options: [],
      selectedModel: null,
      savedModel: this.settings?.selection(provider) ?? null,
      defaultModel: null,
      resolvedModel: null,
    }
  }

  /** Invalidate on provider switch, sign-in and selection changes. */
  invalidateMetadata(): void {
    for (const id of this.registry.ids()) this.registry.get(id)?.invalidate?.()
  }

  async setModel(provider: ConnectionId, model: string | null): Promise<ProviderModels> {
    const adapter = this.registry.require(provider)
    this.invalidateMetadata()
    if (adapter.setModel) return adapter.setModel(model)
    await this.models(provider)
    throw new SubscriptionError('model_unavailable', 'Choose an available model.')
  }

  async allowance(provider: ConnectionId): Promise<ProviderAllowance> {
    const adapter = this.registry.require(provider)
    if (adapter.allowance) return adapter.allowance()
    return {
      provider,
      plan: null,
      windows: [],
      resetsAt: null,
      state: 'unknown',
      lastError: null,
    }
  }

  async status(provider: ConnectionId, signal?: AbortSignal): Promise<ProviderStatus> {
    return this.registry.require(provider).status(signal)
  }

  cancelLogin(): void {
    for (const check of this.checks) check.abort()
    this.active?.controller.abort()
  }

  async login(provider: ConnectionId): Promise<ProviderStatus> {
    const adapter = this.registry.require(provider)
    if (!adapter.login) return this.status(provider)
    // Two runtimes signing in to the same config directory would race; refuse the second.
    if (this.active)
      return { provider, state: 'error', message: 'A sign-in is already in progress.' }
    this.invalidateMetadata()
    const active: ActiveLogin = { provider, controller: new AbortController() }
    this.active = active
    this.options.onLoginState?.(this.loginState())
    let result: ProviderStatus | undefined
    try {
      result = await this.runLogin(adapter, active)
      return result
    } finally {
      // Only the login that is still current may clear it.
      if (this.active === active) {
        this.active = undefined
        this.options.onLoginState?.({ provider, active: false, url: null, result: result ?? null })
      }
    }
  }

  private async runLogin(adapter: ConnectionAdapter, active: ActiveLogin): Promise<ProviderStatus> {
    const { provider, controller } = active
    try {
      await adapter.login?.({
        signal: controller.signal,
        attach: (prompt) => {
          active.prompt = prompt
        },
        urlReady: () => {
          if (this.active === active) this.options.onLoginState?.(this.loginState())
        },
      })
      this.invalidateMetadata()
      return await this.status(provider)
    } catch (error) {
      return {
        provider,
        state: 'error',
        message: controller.signal.aborted
          ? 'Sign-in cancelled.'
          : error instanceof Error
            ? error.message
            : 'Sign-in failed.',
      }
    }
  }

  async runner(
    provider: ConnectionId,
    tools: AgentTool[],
    signal?: AbortSignal,
  ): Promise<AgentRunner> {
    return this.registry.require(provider).runner(tools, signal)
  }

  /** The connection's own mapping: a code and a message written here, never provider text. */
  failure(provider: ConnectionId, error: unknown): ProviderFailure {
    return (
      this.registry.get(provider)?.failure(error) ?? {
        code: 'internal',
        message: 'Unknown provider.',
      }
    )
  }
}
