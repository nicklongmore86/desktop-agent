import type { HistoryState, ProviderStatus } from '../../shared/ipc'
import type { ConnectionId } from '../../shared/ipc-connections'
import type { ChatRef, ProjectsState, ProviderChat } from '../../shared/ipc-projects'
import type { ProjectsService } from '../ipc-projects'
import type { ConversationHistory, Organize } from '../storage/history-store'
import type { ProjectsStore } from '../storage/projects-store'

export interface OrganizerDeps {
  projects: ProjectsStore
  /** A connection's saved chats (the same object the chat session uses for it). Rejects an unknown id. */
  historyFor: (provider: ConnectionId) => Promise<ConversationHistory>
  /** The connections the user can choose now, whose chats the list shows. */
  connections: () => readonly ConnectionId[]
  /** The provider that is open now. */
  provider: () => ConnectionId
  /** The open provider's chats go through the session, which owns the open one. */
  chat: {
    rename: (id: string, title: string) => Promise<HistoryState>
    remove: (id: string) => Promise<HistoryState>
    open: (id: string) => Promise<unknown>
    /** Tells the renderer the open provider's list changed. */
    historyChanged: () => void
  }
  /** Switches provider and opens one of its chats (the Settings switch, plus a chat). */
  switchProvider: (provider: ConnectionId, id: string) => Promise<ProviderStatus>
  status: () => Promise<ProviderStatus>
}

/**
 * Projects and the per-chat actions of the chat list, across providers. Chats
 * keep living in their own provider's history; projects are one global list.
 */
export function createOrganizer(deps: OrganizerDeps): ProjectsService {
  const state = async (): Promise<ProjectsState> => {
    const provider = deps.provider()
    const projects = deps.projects.list()
    const filed = new Set(projects.map((project) => project.id))
    const others: ProviderChat[] = []
    for (const other of deps.connections()) {
      if (other === provider) continue
      let history: ConversationHistory
      try {
        history = await deps.historyFor(other)
      } catch {
        continue
      }
      for (const chat of history.state().conversations) {
        const inProject = chat.projectId !== undefined && filed.has(chat.projectId)
        if (chat.pinnedAt !== undefined || inProject) others.push({ ...chat, provider: other })
      }
    }
    return { provider, projects, others }
  }

  const historyOf = async (chat: ChatRef): Promise<ConversationHistory> => {
    const history = await deps.historyFor(chat.provider)
    if (!history.has(chat.id)) throw new Error('That chat no longer exists.')
    return history
  }
  const changed = (chat: ChatRef): void => {
    if (chat.provider === deps.provider()) deps.chat.historyChanged()
  }
  const organize = async (chat: ChatRef, change: Organize): Promise<ProjectsState> => {
    const history = await historyOf(chat)
    await history.organize(chat.id, change)
    changed(chat)
    return state()
  }

  return {
    state,
    async create(name, icon) {
      const project = await deps.projects.create(name, icon)
      return { project, state: await state() }
    },
    async rename(id, name, icon) {
      await deps.projects.rename(id, name, icon)
      return state()
    },
    async remove(id) {
      // The project goes first: a chat naming a project that is gone lists as unfiled.
      await deps.projects.remove(id)
      for (const provider of deps.connections()) {
        const history = await deps.historyFor(provider).catch(() => null)
        if (!history) continue
        await history.unfile(id)
        if (provider === deps.provider()) deps.chat.historyChanged()
      }
      return state()
    },
    async move(id, to) {
      await deps.projects.move(id, to)
      return state()
    },
    pin: (chat, pinned) => organize(chat, { pinned }),
    archive: (chat, archived) => organize(chat, { archived }),
    moveChat(chat, projectId) {
      if (projectId !== null && !deps.projects.has(projectId))
        return Promise.reject(new Error('That project no longer exists.'))
      return organize(chat, { projectId })
    },
    async fork(chat, prompts) {
      const history = await historyOf(chat)
      const id = await history.fork(chat.id, prompts)
      changed(chat)
      return { chat: { provider: chat.provider, id }, state: await state() }
    },
    async renameChat(chat, title) {
      if (chat.provider === deps.provider()) await deps.chat.rename(chat.id, title)
      else await (await historyOf(chat)).rename(chat.id, title)
      return state()
    },
    async removeChat(chat) {
      // The open provider's chat may be the open one: the session starts a new chat first.
      if (chat.provider === deps.provider()) await deps.chat.remove(chat.id)
      else await (await historyOf(chat)).remove(chat.id)
      return state()
    },
    async open(chat) {
      if (chat.provider === deps.provider()) {
        await deps.chat.open(chat.id)
        return deps.status()
      }
      await historyOf(chat)
      return deps.switchProvider(chat.provider, chat.id)
    },
  }
}
