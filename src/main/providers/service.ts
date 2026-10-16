import { lstat, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { codexModels, codexAllowance } from './catalog'
import { SubscriptionError, subscriptionFailure, plausibleReset } from './errors'
import type { SettingsStore } from '../storage/settings-store'
import type {
  ProviderAllowance,
  ProviderModels,
  ProviderFailure,
  ProviderId,
  ProviderLoginState,
  ProviderStatus,
} from '../../shared/ipc'
import type { AgentErrorCode, AgentTool } from '../agent'
import { createClaudeSubscriptionRunner } from './claude'
import { ClaudeLogin } from './claude-login'
import {
  codexAccount,
  codexLogin,
  connectCodex,
  createCodexRunner,
  type RuntimeContext,
} from './codex'
import { object, type RpcPeer } from './rpc'
import {
  capture,
  CLAUDE_VERSION,
  CODEX_VERSION,
  discoverRuntime,
  providerDirectories,
  runtimeEnv,
} from './runtime'

export interface SubscriptionOptions {
  /** Every sign-in change: started, Claude's validated link, finished (with its outcome). */
  onLoginState?: (state: ProviderLoginState) => void
  settings?: SettingsStore
  /** Claude sign-in timeout (tests only). */
  loginTimeout?: number
}

interface ActiveLogin {
  provider: ProviderId
  controller: AbortController
  claude?: ClaudeLogin
}

export class SubscriptionProviders {
  private catalogCache: { value: ProviderModels; expiresAt: number } | undefined
  private catalogGeneration = 0
  private readonly claudeLimits = new Map<ProviderId, string>()
  private readonly resolved = new Map<ProviderId, string>()
  private readonly failures = new Map<ProviderId, ProviderFailure>()
  private readonly plans = new Map<ProviderId, string>()
  private readonly checks = new Set<AbortController>()
  /** At most one sign-in at a time; a second request is refused until this one ends. */
  private active: ActiveLogin | undefined
  constructor(
    private readonly userData: string,
    private readonly openUrl: (url: string) => Promise<void>,
    private readonly options: SubscriptionOptions = {},
  ) {}

  /** The validated link of the Claude sign-in in progress, if it has printed one. */
  get loginUrl(): string | undefined {
    return this.active?.claude?.url
  }

  /** What Settings needs to show the sign-in in progress again after it was closed. */
  loginState(): ProviderLoginState {
    const active = this.active
    return active
      ? { provider: active.provider, active: true, url: active.claude?.url ?? null, result: null }
      : { provider: null, active: false, url: null, result: null }
  }

  /** Re-opens the same validated link; the renderer never supplies a URL. */
  async openLoginUrl(): Promise<void> {
    const url = this.loginUrl
    if (!url) throw new Error('No sign-in link is waiting.')
    await this.openUrl(url)
  }

  submitLoginCode(code: unknown): { ok: true } | { ok: false; error: string } {
    const login = this.active?.claude
    if (!login) return { ok: false, error: 'Sign-in is no longer waiting for a code.' }
    return login.submitCode(code)
  }

  async context(provider: ProviderId, signal?: AbortSignal): Promise<RuntimeContext> {
    const name = provider === 'claude-subscription' ? 'claude' : 'codex'
    const { home, cwd } = await providerDirectories(this.userData, name)
    // This directory is exclusively provider-owned auth storage. Never inherit user configuration.
    for (const name of [
      'config.toml',
      'settings.json',
      'settings.local.json',
      '.mcp.json',
      'CLAUDE.md',
      'AGENTS.md',
      'hooks.json',
      'plugins',
      '.claude',
      '.codex',
    ]) {
      for (const parent of [home, cwd]) {
        try {
          await lstat(join(parent, name))
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
          throw error
        }
        throw new Error(
          'Unsupported runtime configuration in the isolated provider directory: ' + name,
        )
      }
    }
    if (name === 'codex') {
      const skills = await readdir(join(home, 'skills')).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
        throw error
      })
      if (skills.some((entry) => entry !== '.system'))
        throw new Error('Unsupported custom skills in the isolated provider directory.')
    }
    const env = {
      ...runtimeEnv(),
      ...(name === 'claude'
        ? { CLAUDE_CONFIG_DIR: home, DISABLE_AUTOUPDATER: '1' }
        : { CODEX_HOME: home }),
    }
    // Discovery has already checked the pinned version (and, when packaged, integrity).
    const file = await discoverRuntime(name, process.env, { cwd, env, signal })
    if (!file)
      throw new Error(
        `Missing runtime: ${name} ${name === 'claude' ? CLAUDE_VERSION : CODEX_VERSION}. Development builds require the pinned native runtime; installed builds include it.`,
      )
    return { file, cwd, env }
  }

  async models(provider: ProviderId): Promise<ProviderModels> {
    const savedModel = this.options.settings?.selection(provider) ?? null
    if (provider !== 'codex-subscription')
      return {
        provider,
        options: [],
        selectedModel: null,
        savedModel,
        defaultModel: null,
        resolvedModel: null,
      }
    const cached = this.cachedCatalog()
    return cached ?? this.codexMetadata((peer) => this.readCatalog(peer))
  }

  /** Invalidate on provider switch, sign-in and selection changes. */
  invalidateMetadata(): void {
    this.catalogGeneration++
    this.catalogCache = undefined
  }

  private cachedCatalog(): ProviderModels | undefined {
    if (!this.catalogCache || this.catalogCache.expiresAt <= Date.now()) return undefined
    return {
      ...this.catalogCache.value,
      resolvedModel: this.resolved.get('codex-subscription') ?? null,
    }
  }

  private async readCatalog(peer: RpcPeer): Promise<ProviderModels> {
    const cached = this.cachedCatalog()
    if (cached) return cached
    const generation = this.catalogGeneration
    const value = await codexModels(
      peer,
      this.options.settings?.selection('codex-subscription') ?? null,
    )
    if (generation === this.catalogGeneration)
      this.catalogCache = { value, expiresAt: Date.now() + 60000 }
    return { ...value, resolvedModel: this.resolved.get('codex-subscription') ?? null }
  }

  /** Metadata failures use the same safe error contract as chat failures. */
  private async codexMetadata<T>(read: (peer: RpcPeer) => Promise<T>): Promise<T> {
    let peer: RpcPeer | undefined
    try {
      peer = await connectCodex(await this.context('codex-subscription'))
      if (!(await codexAccount(peer)))
        throw new SubscriptionError('authentication', 'Sign in with ChatGPT in Settings.')
      return await read(peer)
    } catch (error) {
      throw subscriptionFailure(error, 'codex')
    } finally {
      peer?.close()
    }
  }

  async setModel(provider: ProviderId, model: string | null): Promise<ProviderModels> {
    this.invalidateMetadata()
    const catalog = await this.models(provider)
    if (
      provider !== 'codex-subscription' ||
      (model !== null && !catalog.options.some((option) => option.id === model))
    )
      throw new SubscriptionError('model_unavailable', 'Choose an available Codex model.')
    await this.options.settings?.setSelection(provider, model)
    this.invalidateMetadata()
    this.resolved.delete(provider)
    this.failures.delete(provider)
    return {
      ...catalog,
      savedModel: model,
      selectedModel: model ?? catalog.defaultModel,
      resolvedModel: null,
    }
  }

  async allowance(provider: ProviderId): Promise<ProviderAllowance> {
    const lastError = this.failures.get(provider)
    if (provider !== 'codex-subscription') {
      const reset = lastError?.resetsAt ? Date.parse(lastError.resetsAt) : null
      return {
        provider,
        plan: this.plans.get(provider) ?? null,
        windows: [],
        resetsAt:
          lastError?.code === 'usage_limit' && (!reset || reset > Date.now())
            ? (lastError.resetsAt ?? null)
            : null,
        state:
          lastError?.code === 'usage_limit' && (!reset || reset > Date.now())
            ? 'limited'
            : 'unknown',
        lastError: lastError
          ? {
              code: lastError.code,
              message: lastError.message,
              ...(lastError.resetsAt ? { resetsAt: lastError.resetsAt } : {}),
            }
          : null,
      }
    }
    return this.codexMetadata(async (peer) => {
      return {
        ...(await codexAllowance(peer)),
        lastError: lastError
          ? {
              code: lastError.code,
              message: lastError.message,
              ...(lastError.resetsAt ? { resetsAt: lastError.resetsAt } : {}),
            }
          : null,
      }
    })
  }

  async status(provider: ProviderId, signal?: AbortSignal): Promise<ProviderStatus> {
    if (provider === 'anthropic-api')
      return {
        provider,
        state: 'ready',
        message: 'Anthropic API mode uses your saved API key and separate API billing.',
      }
    const controller = new AbortController()
    this.checks.add(controller)
    const checkSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal
    let signedIn: boolean | undefined
    try {
      const context = await this.context(provider, checkSignal)
      let ready = false
      let allowance: ProviderAllowance | undefined
      let plan: string | undefined
      if (provider === 'codex-subscription') {
        const peer = await connectCodex(context, checkSignal)
        try {
          ready = await codexAccount(peer)
          signedIn = ready
          if (ready) {
            try {
              allowance = await codexAllowance(peer)
            } catch {
              /* Allowance is advisory; signed-in chat remains usable. */
            }
          }
        } finally {
          peer.close()
        }
      } else {
        try {
          const auth = object(
            JSON.parse(
              await capture(
                context.file,
                ['auth', 'status'],
                context.cwd,
                context.env,
                checkSignal,
                10000,
                // Claude auth status uses exit 1 for a valid signed-out JSON response.
                [0, 1],
              ),
            ),
          )
          ready = auth['loggedIn'] === true && auth['authMethod'] === 'claude.ai'
          if (
            typeof auth['subscriptionType'] === 'string' &&
            /^[\w -]{1,60}$/.test(auth['subscriptionType'])
          ) {
            plan = auth['subscriptionType']
            this.plans.set(provider, plan)
          }
        } catch (error) {
          throw subscriptionFailure(error, 'claude')
        }
        signedIn = ready
      }
      if (ready && provider === 'claude-subscription') {
        plan ??= this.plans.get(provider)
        allowance = await this.allowance(provider)
      }
      if (ready && plan && /^(?:claude\s*)?free$/i.test(plan))
        return {
          provider,
          signedIn: true,
          availability: 'blocked',
          state: 'not-entitled',
          message: "Your Claude plan doesn't include Claude Code. Claude Pro or Max is required.",
          failure: {
            code: 'plan_not_entitled',
            message: "Your Claude plan doesn't include Claude Code. Claude Pro or Max is required.",
          },
        }
      const trustedClaudeReset = this.claudeLimit(provider)
      if (
        ready &&
        (provider === 'codex-subscription' ? allowance?.state === 'limited' : trustedClaudeReset)
      ) {
        const resetsAt =
          provider === 'claude-subscription'
            ? trustedClaudeReset
            : (allowance?.resetsAt ?? undefined)
        const failure = subscriptionFailure(
          { code: 'usage_limit', resetsAt },
          provider === 'codex-subscription' ? 'codex' : 'claude',
        )
        return {
          provider,
          signedIn: true,
          availability: 'blocked',
          state: 'limited',
          message: failure.message,
          failure: {
            code: failure.code,
            message: failure.message,
            ...(resetsAt ? { resetsAt } : {}),
          },
        }
      }
      return {
        provider,
        signedIn: ready,
        availability: ready && allowance?.state === 'available' ? 'available' : 'unknown',
        state: ready ? 'ready' : 'signed-out',
        message: ready
          ? 'Subscription signed in. No API key is used.'
          : 'Sign in with your subscription. API accounts and copied tokens are not accepted.',
      }
    } catch (error) {
      const failure = subscriptionFailure(
        error,
        provider === 'codex-subscription' ? 'codex' : 'claude',
      )
      const message = error instanceof Error ? error.message : 'Runtime check failed.'
      return {
        provider,
        state: message.startsWith('Missing runtime')
          ? 'missing-runtime'
          : message.startsWith('Unsupported')
            ? 'unsupported'
            : 'error',
        message: failure.message,
        ...(signedIn !== undefined
          ? { signedIn: failure.code === 'auth_expired' ? false : signedIn }
          : {}),
        availability:
          failure.code === 'plan_not_entitled' || failure.code === 'usage_limit'
            ? 'blocked'
            : 'unknown',
        failure: {
          code: failure.code,
          message: failure.message,
          ...(failure.resetsAt ? { resetsAt: failure.resetsAt } : {}),
        },
      }
    } finally {
      this.checks.delete(controller)
    }
  }

  cancelLogin(): void {
    for (const check of this.checks) check.abort()
    this.active?.controller.abort()
  }

  async login(provider: ProviderId): Promise<ProviderStatus> {
    if (provider === 'anthropic-api') return this.status(provider)
    // Two runtimes signing in to the same config directory would race; refuse the second.
    if (this.active)
      return { provider, state: 'error', message: 'A sign-in is already in progress.' }
    this.invalidateMetadata()
    const active: ActiveLogin = { provider, controller: new AbortController() }
    this.active = active
    this.options.onLoginState?.(this.loginState())
    let result: ProviderStatus | undefined
    try {
      result = await this.runLogin(active)
      return result
    } finally {
      // Only the login that is still current may clear it.
      if (this.active === active) {
        this.active = undefined
        this.options.onLoginState?.({ provider, active: false, url: null, result: result ?? null })
      }
    }
  }

  private async runLogin(active: ActiveLogin): Promise<ProviderStatus> {
    const { provider, controller } = active
    try {
      const context = await this.context(provider, controller.signal)
      controller.signal.throwIfAborted()
      if (provider === 'codex-subscription') {
        const peer = await connectCodex(context, controller.signal)
        await codexLogin(peer, this.openUrl, controller.signal)
      } else {
        const login = new ClaudeLogin(context, {
          signal: controller.signal,
          openUrl: this.openUrl,
          onUrl: () => {
            if (this.active === active) this.options.onLoginState?.(this.loginState())
          },
          ...(this.options.loginTimeout ? { timeout: this.options.loginTimeout } : {}),
        })
        active.claude = login
        await login.done
      }
      this.failures.delete(provider)
      this.claudeLimits.delete(provider)
      this.plans.delete(provider)
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

  private claudeLimit(provider: ProviderId): string | undefined {
    const reset = this.claudeLimits.get(provider)
    return reset && plausibleReset(reset) && Date.parse(reset) > Date.now() ? reset : undefined
  }

  async runner(provider: ProviderId, tools: AgentTool[], signal?: AbortSignal) {
    if (provider === 'claude-subscription') {
      const status = await this.status(provider, signal)
      const reset = this.claudeLimit(provider)
      const trustedLimit = reset !== undefined
      // Remembered free-text errors are display-only. Only structured plan/limit signals gate Send.
      if (!['ready', 'limited'].includes(status.state) || trustedLimit)
        throw new SubscriptionError(
          trustedLimit
            ? 'usage_limit'
            : ((status.failure?.code as AgentErrorCode | undefined) ??
                (status.state === 'signed-out' ? 'authentication' : 'runtime_unavailable')),
          status.message,
          trustedLimit ? reset : undefined,
        )
    }
    // Codex checks auth and authoritative entitlement/usage errors inside the single run process.
    const context = await this.context(provider, signal)
    return provider === 'claude-subscription'
      ? createClaudeSubscriptionRunner(context, tools, {
          onAccount: (plan) => {
            if (/^[\w -]{1,60}$/.test(plan)) this.plans.set(provider, plan)
          },
          onLimit: (reset) => {
            if (reset && plausibleReset(reset)) this.claudeLimits.set(provider, reset)
            else this.claudeLimits.delete(provider)
          },
          onAvailable: () => {
            this.failures.delete(provider)
            this.claudeLimits.delete(provider)
          },
          onFailure: (failure) => {
            this.failures.set(provider, failure)
          },
        })
      : createCodexRunner(context, tools, {
          model: this.options.settings?.selection(provider) ?? null,
          catalog: (peer) => this.readCatalog(peer),
          onResolvedModel: (model) => {
            this.resolved.set(provider, model)
          },
          onAvailable: () => {
            this.failures.delete(provider)
          },
          onFailure: (failure) => {
            this.failures.set(provider, failure)
          },
        })
  }
}
