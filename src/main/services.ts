import { homedir } from 'node:os'
import { SubscriptionProviders } from './providers/service'
import { PROVIDERS, type ProviderId } from '../shared/ipc'
import { join } from 'node:path'
import type { ApprovalPrompt, AuditStatus, ChatEvent, ProviderLoginState } from '../shared/ipc'
import { createAgent, createClaudeClient } from './agent'
import { ChatSession } from './chat/session'
import { AuditLog, GrantStore, PathGuard } from './permissions'
import { createApiKeyStore, type SafeStorage } from './secrets'
import { createConversationStore } from './storage/conversation-store'
import { openSettingsStore } from './storage/settings-store'
import { createTools } from './tools'

export interface AppServiceDeps {
  openUrl?: (url: string) => Promise<void>
  userData: string
  safeStorage: SafeStorage
  /** Moves a path to the Recycle Bin: Electron's shell.trashItem. */
  trash: (path: string) => Promise<void>
  emit: (event: ChatEvent) => void
  promptApproval: (prompt: ApprovalPrompt) => void
  onAuditStatus: (status: AuditStatus) => void
  onProviderLoginState?: (state: ProviderLoginState) => void
  copyText?: (text: string) => Promise<void>
}

/** Builds the key store, grants, guard, audit log, tools, settings and chat session. */
export async function createAppServices(deps: AppServiceDeps) {
  const { userData } = deps
  const apiKey = createApiKeyStore({ userDataPath: userData, safeStorage: deps.safeStorage })
  const protectedPaths = [
    userData,
    join(homedir(), '.claude'),
    join(homedir(), '.claude.json'),
    join(homedir(), '.codex'),
    process.env['CLAUDE_CONFIG_DIR'],
    process.env['CODEX_HOME'],
  ].filter((path): path is string => Boolean(path))
  const grants = await GrantStore.open(join(userData, 'grants.json'), {
    protectedPaths,
  })
  const guard = new PathGuard({ roots: () => grants.list(), protectedPaths })

  let audit: AuditLog | null = null
  const auditStatus = (): AuditStatus => ({
    healthy: audit?.healthy ?? true,
    path: join(userData, 'audit.jsonl'),
  })
  const reportAudit = (): void => {
    deps.onAuditStatus(auditStatus())
  }
  audit = new AuditLog(auditStatus().path, {
    onError: (error) => {
      console.error('audit log write failed', error)
      reportAudit()
    },
  })
  const tools = createTools({
    guard,
    audit,
    trash: deps.trash,
    onAuditFailure: reportAudit,
  })

  const settings = await openSettingsStore(join(userData, 'settings.json'))

  const subscriptions = new SubscriptionProviders(
    userData,
    deps.openUrl ?? (() => Promise.reject(new Error('Browser sign-in is unavailable.'))),
    { onLoginState: (state) => deps.onProviderLoginState?.(state) },
  )
  const storeFor = (provider: ProviderId) =>
    createConversationStore(
      join(
        userData,
        provider === 'anthropic-api' ? 'conversation.json' : `conversation-${provider}.json`,
      ),
    )
  const chat = new ChatSession({
    store: storeFor(settings.provider),
    async createRunner(signal) {
      if (settings.provider !== 'anthropic-api') {
        try {
          return { ok: true, runner: await subscriptions.runner(settings.provider, tools, signal) }
        } catch (error) {
          return {
            ok: false,
            code: 'authentication',
            message: error instanceof Error ? error.message : 'Subscription unavailable.',
          }
        }
      }
      let key: string | null
      try {
        key = await apiKey.get()
      } catch (error) {
        return {
          ok: false,
          code: 'key_unreadable',
          message: error instanceof Error ? error.message : 'The saved API key cannot be read.',
        }
      }
      if (!key)
        return { ok: false, code: 'no_api_key', message: 'Add your Anthropic API key in Settings.' }
      return {
        ok: true,
        runner: createAgent({ client: createClaudeClient(key), tools, model: settings.model }),
      }
    },
    emit: (event) => {
      deps.emit(event)
      // A run is when audit entries get written; refresh the warning afterwards.
      if (event.type === 'run_finished') reportAudit()
    },
    promptApproval: deps.promptApproval,
    onSaveError: (error) => {
      console.error('could not save the conversation', error)
    },
  })
  await chat.init()

  const provider = {
    get: () => subscriptions.status(settings.provider),
    async set(next: ProviderId) {
      if (!PROVIDERS.includes(next)) throw new Error('Unknown provider.')
      subscriptions.cancelLogin()
      await chat.switchStore(storeFor(next), () => settings.setProvider(next))
      return subscriptions.status(settings.provider)
    },
    login: () => subscriptions.login(settings.provider),
    cancelLogin: () => {
      subscriptions.cancelLogin()
      return Promise.resolve()
    },
    loginState: () => Promise.resolve(subscriptions.loginState()),
    openLoginUrl: () => subscriptions.openLoginUrl(),
    copyLoginUrl: () => {
      const url = subscriptions.loginUrl
      if (!url) return Promise.reject(new Error('No sign-in link is waiting.'))
      if (!deps.copyText) return Promise.reject(new Error('Copying is unavailable.'))
      return deps.copyText(url)
    },
    submitLoginCode: (code: string) => Promise.resolve(subscriptions.submitLoginCode(code)),
  }
  return { apiKey, grants, settings, chat, auditStatus, provider }
}
