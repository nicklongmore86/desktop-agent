import { homedir } from 'node:os'
import { subscriptionFailure } from './providers/errors'
import { SubscriptionProviders } from './providers/service'
import { PROVIDERS, type ProviderId, type ProviderResult } from '../shared/ipc'
import { join } from 'node:path'
import type { ApprovalPrompt, AuditStatus, ChatEvent, ProviderLoginState } from '../shared/ipc'
import type { FilesChanged } from '../shared/ipc-files'
import { createAgent, createClaudeClient } from './agent'
import { createOrganizer } from './chat/organizer'
import { ChatSession } from './chat/session'
import { createFilesService } from './files/service'
import { AuditLog, GrantStore, PathGuard } from './permissions'
import { createApiKeyStore, type SafeStorage } from './secrets'
import { openHistory, type ConversationHistory } from './storage/history-store'
import { openProjectsStore } from './storage/projects-store'
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
  /** Shows a path in Explorer: Electron's shell.showItemInFolder. */
  revealPath?: (path: string) => void
  onFilesChanged?: (change: FilesChanged) => void
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

  const files = createFilesService({
    guard,
    reveal:
      deps.revealPath ??
      (() => {
        throw new Error('Showing files is unavailable.')
      }),
    copyText: deps.copyText ?? (() => Promise.reject(new Error('Copying is unavailable.'))),
    emit: (change) => deps.onFilesChanged?.(change),
  })

  const settings = await openSettingsStore(join(userData, 'settings.json'))

  const subscriptions = new SubscriptionProviders(
    userData,
    deps.openUrl ?? (() => Promise.reject(new Error('Browser sign-in is unavailable.'))),
    { settings, onLoginState: (state) => deps.onProviderLoginState?.(state) },
  )
  // Each provider's conversations: userData/history/<provider>/index.json plus one file
  // per conversation. Opened (and migrated from the old single file) on first use.
  const histories = new Map<ProviderId, Promise<ConversationHistory>>()
  const historyFor = (provider: ProviderId): Promise<ConversationHistory> => {
    let history = histories.get(provider)
    if (!history) {
      history = openHistory(join(userData, 'history', provider), {
        legacyFile: join(
          userData,
          provider === 'anthropic-api' ? 'conversation.json' : `conversation-${provider}.json`,
        ),
        onError: (error) => {
          console.error('could not save the chat history list', error)
        },
      })
      histories.set(provider, history)
      history.catch(() => histories.delete(provider))
    }
    return history
  }
  const userShell = tools.find((tool) => tool.name === 'run_shell')
  const chat = new ChatSession({
    history: await historyFor(settings.provider),
    async createRunner(signal) {
      if (settings.provider !== 'anthropic-api') {
        try {
          return { ok: true, runner: await subscriptions.runner(settings.provider, tools, signal) }
        } catch (error) {
          const failure = subscriptionFailure(
            error,
            settings.provider === 'codex-subscription' ? 'codex' : 'claude',
          )
          return {
            ok: false,
            code: failure.code,
            message: failure.message,
            ...(failure.resetsAt ? { resetsAt: failure.resetsAt } : {}),
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
    // Commands typed in the command bar go through this same tool (no other spawn path).
    ...(userShell ? { userShell } : {}),
    onSaveError: (error) => {
      console.error('could not save the conversation', error)
    },
  })
  await chat.init()

  const metadataResult = async <T>(operation: () => Promise<T>): Promise<ProviderResult<T>> => {
    const selectedProvider = settings.provider
    try {
      return { ok: true, value: await operation() }
    } catch (error) {
      const failure = subscriptionFailure(
        error,
        selectedProvider === 'codex-subscription' ? 'codex' : 'claude',
      )
      return {
        ok: false,
        failure: {
          code: failure.code,
          message: failure.message,
          ...(failure.resetsAt ? { resetsAt: failure.resetsAt } : {}),
        },
      }
    }
  }
  const provider = {
    models: () => metadataResult(() => subscriptions.models(settings.provider)),
    setModel: (model: string | null) =>
      metadataResult(() => subscriptions.setModel(settings.provider, model)),
    allowance: () => metadataResult(() => subscriptions.allowance(settings.provider)),
    get: () => subscriptions.status(settings.provider),
    /** `openId`: a saved chat of `next` to open instead of its last one. */
    async set(next: ProviderId, openId?: string) {
      if (!PROVIDERS.includes(next)) throw new Error('Unknown provider.')
      subscriptions.cancelLogin()
      subscriptions.invalidateMetadata()
      await chat.switchHistory(await historyFor(next), () => settings.setProvider(next), openId)
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
  // Global across providers: a chat names its project by id in its own provider's index.
  const projects = createOrganizer({
    projects: await openProjectsStore(join(userData, 'projects.json')),
    historyFor,
    provider: () => settings.provider,
    chat,
    switchProvider: (next, id) => provider.set(next, id),
    status: () => subscriptions.status(settings.provider),
  })
  return { apiKey, grants, settings, chat, auditStatus, provider, projects, files }
}
