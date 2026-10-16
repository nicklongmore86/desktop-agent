import type { HistoryState, ProviderId } from '../../../../shared/ipc'
import type { Project, ProjectsState, ProviderChat } from '../../../../shared/ipc-projects'

export interface ProjectGroup {
  project: Project
  chats: ProviderChat[]
}

export interface Arranged {
  /** Oldest pin first, as pinned. */
  pinned: ProviderChat[]
  projects: ProjectGroup[]
  /** The open provider's chats that are neither pinned nor in a project, newest first. */
  loose: ProviderChat[]
  /** Every archived chat listed, newest first. */
  archived: ProviderChat[]
  /** Chats listed in the normal view (pinned + in projects + loose). */
  count: number
}

const byRecent = (a: ProviderChat, b: ProviderChat): number =>
  b.updatedAt - a.updatedAt || b.createdAt - a.createdAt || a.id.localeCompare(b.id)

/**
 * The chat list's sections. The open provider's chats come from its history
 * (kept live by main's pushes); other providers' come from the projects state,
 * which only carries the ones that are pinned or filed. A chat naming a project
 * that no longer exists counts as unfiled.
 */
export function arrangeChats(
  history: HistoryState,
  projects: ProjectsState | null,
  provider: ProviderId | null,
): Arranged {
  const own = provider ?? projects?.provider ?? null
  const rows = new Map<string, ProviderChat>()
  for (const chat of projects?.others ?? []) {
    if (chat.provider !== own) rows.set(chat.id, chat)
  }
  // The history is the fresher copy: it wins for any id in both (mid provider switch).
  for (const chat of history.conversations)
    rows.set(chat.id, { ...chat, provider: own ?? 'anthropic-api' })
  const list = [...rows.values()]
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
  const mine = new Set(history.conversations.map((chat) => chat.id))
  const loose = unpinned
    .filter((chat) => projectOf(chat) === null && mine.has(chat.id))
    .sort(byRecent)
  const archived = list.filter((chat) => chat.archivedAt !== undefined).sort(byRecent)
  const count = pinned.length + loose.length + groups.reduce((n, g) => n + g.chats.length, 0)
  return { pinned, projects: groups, loose, archived, count }
}

/** Where a chat is filed, for the menu and drops (a missing project counts as none). */
export function projectIdOf(chat: ProviderChat, projects: ProjectsState | null): string | null {
  return chat.projectId !== undefined && projects?.projects.some((p) => p.id === chat.projectId)
    ? chat.projectId
    : null
}
