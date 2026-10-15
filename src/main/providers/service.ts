import { lstat, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { ProviderId, ProviderLoginState, ProviderStatus } from '../../shared/ipc'
import type { AgentTool } from '../agent'
import { createClaudeSubscriptionRunner } from './claude'
import { ClaudeLogin } from './claude-login'
import {
  codexAccount,
  codexLogin,
  connectCodex,
  createCodexRunner,
  type RuntimeContext,
} from './codex'
import { object } from './rpc'
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
  /** Claude sign-in timeout (tests only). */
  loginTimeout?: number
}

interface ActiveLogin {
  provider: ProviderId
  controller: AbortController
  claude?: ClaudeLogin
}

export class SubscriptionProviders {
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
    try {
      const context = await this.context(provider, checkSignal)
      let ready = false
      if (provider === 'codex-subscription') {
        const peer = await connectCodex(context, checkSignal)
        try {
          ready = await codexAccount(peer)
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
              ),
            ),
          )
          ready = auth['loggedIn'] === true && auth['authMethod'] === 'claude.ai'
        } catch {
          ready = false
        }
      }
      return {
        provider,
        state: ready ? 'ready' : 'signed-out',
        message: ready
          ? 'Subscription signed in. No API key is used.'
          : 'Sign in with your subscription. API accounts and copied tokens are not accepted.',
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Runtime check failed.'
      return {
        provider,
        state: message.startsWith('Missing runtime')
          ? 'missing-runtime'
          : message.startsWith('Unsupported')
            ? 'unsupported'
            : 'error',
        message,
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

  async runner(provider: ProviderId, tools: AgentTool[], signal?: AbortSignal) {
    const status = await this.status(provider, signal)
    if (status.state !== 'ready') throw new Error(status.message)
    const context = await this.context(provider, signal)
    return provider === 'claude-subscription'
      ? createClaudeSubscriptionRunner(context, tools)
      : createCodexRunner(context, tools)
  }
}
