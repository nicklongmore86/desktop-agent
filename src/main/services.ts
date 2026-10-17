import { homedir } from 'node:os'
import type { ConnectionsService } from './ipc-connections'
import { ConnectionService } from './providers/service'
import type { ProviderResult } from '../shared/ipc'
import {
  ANTHROPIC_API,
  DEFAULT_CONNECTION,
  type ConnectionId,
  type ConnectionsState,
} from '../shared/ipc-connections'
import { join } from 'node:path'
import type { ApprovalPrompt, AuditStatus, ChatEvent, ProviderLoginState } from '../shared/ipc'
import type { FilesChanged } from '../shared/ipc-files'
import type { GitChanged } from '../shared/ipc-git'
import { createOrganizer } from './chat/organizer'
import { ChatSession } from './chat/session'
import { createFilesService } from './files/service'
import { createGitService } from './git/service'
import { AuditLog, GrantStore, PathGuard } from './permissions'
import { createKeyStore, type SafeStorage } from './secrets'
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
  onGitChanged?: (change: GitChanged) => void
}

/** Builds the key store, grants, guard, audit log, tools, settings, connections and chat session. */
export async function createAppServices(deps: AppServiceDeps) {
  const { userData } = deps
  const keys = createKeyStore({ userDataPath: userData, safeStorage: deps.safeStorage })
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

  const git = createGitService({
    guard,
    emptyDir: join(userData, 'git-empty'),
    emit: (change) => deps.onGitChanged?.(change),
    openUrl: deps.openUrl ?? (() => Promise.reject(new Error('Opening links is unavailable.'))),
  })

  const settings = await openSettingsStore(join(userData, 'settings.json'))

  const connections = new ConnectionService(
    userData,
    deps.openUrl ?? (() => Promise.reject(new Error('Browser sign-in is unavailable.'))),
    { settings, keys, onLoginState: (state) => deps.onProviderLoginState?.(state) },
  )
  /** Registered, and not hidden by showPersonalUseConnections. */
  const available = (id: ConnectionId): boolean => {
    const adapter = connections.registry.get(id)
    return Boolean(adapter && (settings.showPersonalUseConnections || !adapter.personalUseOnly))
  }
  // A saved connection this build does not offer (unknown, or hidden) falls back to the default.
  if (!available(settings.connection)) await settings.setConnection(DEFAULT_CONNECTION)
  /** An API-key connection's key store; the key IPC names no connection for Anthropic API. */
  const keyFor = (id: ConnectionId = DEFAULT_CONNECTION) => {
    if (!available(id) || connections.registry.require(id).capabilities.authKind !== 'api-key')
      throw new Error('Unknown provider.')
    return keys.forConnection(id)
  }
  // Each connection's conversations: userData/history/<id>/index.json plus one file
  // per conversation. Opened (and migrated from the old single file) on first use.
  // Only a registered id ever becomes part of a path.
  const histories = new Map<ConnectionId, Promise<ConversationHistory>>()
  const historyFor = (provider: ConnectionId): Promise<ConversationHistory> => {
    if (!connections.registry.has(provider)) return Promise.reject(new Error('Unknown chat.'))
    let history = histories.get(provider)
    if (!history) {
      history = openHistory(join(userData, 'history', provider), {
        legacyFile: join(
          userData,
          provider === ANTHROPIC_API ? 'conversation.json' : `conversation-${provider}.json`,
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
    history: await historyFor(settings.connection),
    async createRunner(signal) {
      const connection = settings.connection
      try {
        return { ok: true, runner: await connections.runner(connection, tools, signal) }
      } catch (error) {
        const failure = connections.failure(connection, error)
        return {
          ok: false,
          code: failure.code,
          message: failure.message,
          ...(failure.resetsAt ? { resetsAt: failure.resetsAt } : {}),
        }
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
    const selected = settings.connection
    try {
      return { ok: true, value: await operation() }
    } catch (error) {
      const failure = connections.failure(selected, error)
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
    models: () => metadataResult(() => connections.models(settings.connection)),
    setModel: (model: string | null) =>
      metadataResult(() => connections.setModel(settings.connection, model)),
    allowance: () => metadataResult(() => connections.allowance(settings.connection)),
    get: () => connections.status(settings.connection),
    /** `openId`: a saved chat of `next` to open instead of its last one. */
    async set(next: ConnectionId, openId?: string) {
      if (!available(next)) throw new Error('Unknown provider.')
      connections.cancelLogin()
      connections.invalidateMetadata()
      await chat.switchHistory(await historyFor(next), () => settings.setConnection(next), openId)
      return connections.status(settings.connection)
    },
    login: () => connections.login(settings.connection),
    cancelLogin: () => {
      connections.cancelLogin()
      return Promise.resolve()
    },
    loginState: () => Promise.resolve(connections.loginState()),
    openLoginUrl: () => connections.openLoginUrl(),
    copyLoginUrl: () => {
      const url = connections.loginUrl
      if (!url) return Promise.reject(new Error('No sign-in link is waiting.'))
      if (!deps.copyText) return Promise.reject(new Error('Copying is unavailable.'))
      return deps.copyText(url)
    },
    submitLoginCode: (code: string) => Promise.resolve(connections.submitLoginCode(code)),
  }
  const connectionList: ConnectionsService = {
    list: () => connections.registry.list({ personalUse: settings.showPersonalUseConnections }),
    available,
    state: (): ConnectionsState => ({
      configured: settings.connections.map(({ id }) => id).filter(available),
      current: settings.connection,
      showPersonalUse: settings.showPersonalUseConnections,
    }),
    status: (id: ConnectionId) => connections.status(id),
    async add(id: ConnectionId) {
      if (!available(id)) throw new Error('Unknown provider.')
      await settings.addConnection(id)
      return connectionList.state()
    },
    async remove(id: ConnectionId) {
      if (!available(id)) throw new Error('Unknown provider.')
      await settings.removeConnection(id)
      return connectionList.state()
    },
    async setShowPersonalUse(show: boolean) {
      if (!show && connections.registry.get(settings.connection)?.personalUseOnly)
        throw new Error('Switch to another connection before hiding this one.')
      await settings.setShowPersonalUseConnections(show)
      return connectionList.state()
    },
  }
  /** Each API-key connection's key; the renderer only ever learns whether one is saved. */
  const apiKey = {
    get: async (id?: ConnectionId) => keyFor(id).get(),
    hasKey: async (id?: ConnectionId) => keyFor(id).hasKey(),
    set: async (key: string, id?: ConnectionId) => keyFor(id).set(key),
    clear: async (id?: ConnectionId) => keyFor(id).clear(),
  }
  // Global across connections: a chat names its project by id in its own connection's index.
  const projects = createOrganizer({
    projects: await openProjectsStore(join(userData, 'projects.json')),
    historyFor,
    connections: () => connections.registry.ids().filter(available),
    provider: () => settings.connection,
    chat,
    switchProvider: (next, id) => provider.set(next, id),
    status: () => connections.status(settings.connection),
  })
  return {
    apiKey,
    grants,
    settings,
    chat,
    auditStatus,
    provider,
    connections: connectionList,
    projects,
    files,
    git,
  }
}
