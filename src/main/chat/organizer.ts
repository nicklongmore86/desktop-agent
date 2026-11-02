import type { ChatRef, HistoryState, ProviderStatus } from '../../shared/ipc'
import type { ProjectsState } from '../../shared/ipc-projects'
import type { ProjectsService } from '../ipc-projects'
import type { ConversationHistory, Organize } from '../storage/history-store'
import type { ProjectsStore } from '../storage/projects-store'
import type { ChatLibrary } from './library'

export interface OrganizerDeps {
  projects: ProjectsStore
  /** Every connection's chats (the same library the chat session uses). */
  library: ChatLibrary
  /** Opening, renaming and deleting go through the session, which owns the open chat. */
  chat: {
    openChat: (chat: ChatRef) => Promise<unknown>
    renameChat: (chat: ChatRef, title: string) => Promise<HistoryState>
    removeChat: (chat: ChatRef) => Promise<HistoryState>
    /** Tells the renderer the chat list changed. */
    historyChanged: () => void
  }
  /** The current connection's status. */
  status: () => Promise<ProviderStatus>
}

/**
 * Projects and the per-chat actions of the shared chat list. Chats keep living
 * in their home connection's history and are named by home and id; projects are
 * one global list. Opening a chat never switches connection: it continues on the
 * current one.
 */
export function createOrganizer(deps: OrganizerDeps): ProjectsService {
  const { library } = deps
  const state = (): Promise<ProjectsState> => {
    const provider = library.connection()
    const projects = deps.projects.list()
    const filed = new Set(projects.map((project) => project.id))
    // Older renderers list other homes' chats only when pinned or filed (HistoryState.chats has all).
    const others = library
      .list()
      .filter(
        (chat) =>
          chat.provider !== provider &&
          (chat.pinnedAt !== undefined ||
            (chat.projectId !== undefined && filed.has(chat.projectId))),
      )
    return Promise.resolve({ provider, projects, others })
  }

  const historyOf = async (chat: ChatRef): Promise<ConversationHistory> => {
    const history = await library.historyFor(chat.provider)
    if (!history.has(chat.id)) throw new Error('That chat no longer exists.')
    return history
  }
  const organize = async (chat: ChatRef, change: Organize): Promise<ProjectsState> => {
    const history = await historyOf(chat)
    await history.organize(chat.id, change)
    deps.chat.historyChanged()
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
      const homes = new Set(library.list().map((chat) => chat.provider))
      for (const home of homes) {
        const history = library.loaded(home)
        if (history) await history.unfile(id)
      }
      deps.chat.historyChanged()
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
      deps.chat.historyChanged()
      return { chat: { provider: chat.provider, id }, state: await state() }
    },
    async renameChat(chat, title) {
      await historyOf(chat)
      await deps.chat.renameChat(chat, title)
      return state()
    },
    async removeChat(chat) {
      // It may be the open chat: the session starts a new chat first.
      await deps.chat.removeChat(chat)
      return state()
    },
    async open(chat) {
      await historyOf(chat)
      await deps.chat.openChat(chat)
      return deps.status()
    },
  }
}
