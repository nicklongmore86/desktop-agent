import { lstat, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { ProviderId, ProviderStatus } from '../../shared/ipc'
import type { AgentTool } from '../agent'
import { createClaudeSubscriptionRunner } from './claude'
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

export class SubscriptionProviders {
  private readonly checks = new Set<AbortController>()
  private loginController: AbortController | undefined
  constructor(
    private readonly userData: string,
    private readonly openUrl: (url: string) => Promise<void>,
  ) {}

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
    this.loginController?.abort()
  }
  async login(provider: ProviderId): Promise<ProviderStatus> {
    if (provider === 'anthropic-api') return this.status(provider)
    if (this.loginController)
      return { provider, state: 'error', message: 'A sign-in is already in progress.' }
    const controller = new AbortController()
    this.loginController = controller
    try {
      const context = await this.context(provider, controller.signal)
      controller.signal.throwIfAborted()
      if (provider === 'codex-subscription') {
        const peer = await connectCodex(context, controller.signal)
        await codexLogin(peer, this.openUrl, controller.signal)
      } else {
        await capture(
          context.file,
          ['auth', 'login'],
          context.cwd,
          context.env,
          controller.signal,
          120000,
        )
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
    } finally {
      this.loginController = undefined
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
