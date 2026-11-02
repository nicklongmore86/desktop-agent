import type { ChatRef, HistoryState } from '../../../../shared/ipc'
import { DEFAULT_CONNECTION, type ConnectionId } from '../../../../shared/ipc-connections'
import type { Project, ProjectsState, ProviderChat } from '../../../../shared/ipc-projects'

export interface ProjectGroup {
  project: Project
  chats: ProviderChat[]
}

export interface Arranged {
  /** Oldest pin first, as pinned. */
  pinned: ProviderChat[]
  projects: ProjectGroup[]
  /** Chats of every connection that are neither pinned nor in a project, newest first. */
  loose: ProviderChat[]
  /** Every archived chat listed, newest first. */
  archived: ProviderChat[]
  /** Chats listed in the normal view (pinned + in projects + loose). */
  count: number
}

const byRecent = (a: ProviderChat, b: ProviderChat): number =>
  b.updatedAt - a.updatedAt || b.createdAt - a.createdAt || a.id.localeCompare(b.id)

/**
 * The chat list's sections, over the one shared list: `history.chats` holds every
 * connection's chats (kept live by main's pushes). A main that sends no `chats` (an older
 * one) gets the open connection's own chats plus the organised ones of the others from the
 * projects state. A chat naming a project that no longer exists counts as unfiled.
 */
export function arrangeChats(
  history: HistoryState,
  projects: ProjectsState | null,
  provider: ConnectionId | null,
): Arranged {
  const own = provider ?? projects?.provider ?? DEFAULT_CONNECTION
  let list: ProviderChat[]
  if (history.chats) {
    list = history.chats
  } else {
    const rows = new Map<string, ProviderChat>()
    for (const chat of projects?.others ?? []) if (chat.provider !== own) rows.set(chat.id, chat)
    for (const chat of history.conversations) rows.set(chat.id, { ...chat, provider: own })
    list = [...rows.values()]
  }
  const known = new Set((projects?.projects ?? []).map((project) => project.id))
  const projectOf = (chat: ProviderChat): string | null =>
    chat.projectId !== undefined && known.has(chat.projectId) ? chat.projectId : null
  const live = list.filter((chat) => chat.archivedAt === undefined)
  const pinned = live
    .filter((chat) => chat.pinnedAt !== undefined)
    .sort((a, b) => (a.pinnedAt ?? 0) - (b.pinnedAt ?? 0) || a.id.localeCompare(b.id))
  const unpinned = live.filter((chat) => chat.pinnedAt === undefined)
  const groups = (projects?.projects ?? []).map((project) => ({
    project,
    chats: unpinned.filter((chat) => projectOf(chat) === project.id).sort(byRecent),
  }))
  const loose = unpinned.filter((chat) => projectOf(chat) === null).sort(byRecent)
  const archived = list.filter((chat) => chat.archivedAt !== undefined).sort(byRecent)
  const count = pinned.length + loose.length + groups.reduce((n, g) => n + g.chats.length, 0)
  return { pinned, projects: groups, loose, archived, count }
}

/** The open chat by home and id. A main that sends no `active` names it by `activeId`. */
export function activeRef(history: HistoryState, provider: ConnectionId | null): ChatRef | null {
  if (history.active !== undefined) return history.active
  return history.activeId !== null && provider ? { provider, id: history.activeId } : null
}

/** Where a chat is filed, for the menu and drops (a missing project counts as none). */
export function projectIdOf(chat: ProviderChat, projects: ProjectsState | null): string | null {
  return chat.projectId !== undefined && projects?.projects.some((p) => p.id === chat.projectId)
    ? chat.projectId
    : null
}
