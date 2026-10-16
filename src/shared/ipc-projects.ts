/**
 * Projects, pins, archive, move and fork for the chat list: channel names, types
 * and limits shared by main, preload and renderer. One of the per-feature IPC
 * modules; see docs/ipc-modules.md.
 *
 * No zod here, so the renderer bundle stays small. Main validates every argument
 * in src/main/ipc-projects.ts.
 *
 * Projects are global: one list (userData/projects.json) for every provider. A
 * chat stays in its provider's history and names its project by id, so a project
 * can hold chats of several providers. Opening another provider's chat switches
 * to that provider first, as Settings does.
 */
import type { ConversationSummary, ProviderId, ProviderStatus } from './ipc'

export const projectsChannels = {
  projectsState: 'projects:state',
  projectsCreate: 'projects:create',
  projectsRename: 'projects:rename',
  projectsDelete: 'projects:delete',
  projectsMove: 'projects:move',
  chatPin: 'projects:chat-pin',
  chatArchive: 'projects:chat-archive',
  chatMove: 'projects:chat-move',
  chatFork: 'projects:chat-fork',
  chatRename: 'projects:chat-rename',
  chatDelete: 'projects:chat-delete',
  chatOpen: 'projects:chat-open',
} as const

/** The icons a project can have; main accepts only these. */
export const PROJECT_ICONS = ['📁', '🚀', '🧪', '📝', '💡', '🛠️', '📊', '🎯'] as const
export type ProjectIcon = (typeof PROJECT_ICONS)[number]

/** The longest project name kept; longer names are cut. */
export const MAX_PROJECT_NAME = 60
export const MAX_PROJECTS = 200

export interface Project {
  /** A random v4 UUID made in main. */
  id: string
  /** Plain text: control and bidi formatting characters are removed in main. */
  name: string
  icon: ProjectIcon | null
}

/** A saved chat of any provider. */
export interface ChatRef {
  provider: ProviderId
  id: string
}

export interface ProviderChat extends ConversationSummary {
  provider: ProviderId
}

export interface ProjectsState {
  /** The provider that is open; its own chats come with the chat history (HistoryState). */
  provider: ProviderId
  /** In the order the user gave them. */
  projects: Project[]
  /** Other providers' chats that are pinned or filed in a project (archived ones included). */
  others: ProviderChat[]
}

/** Where a project goes in the list. */
export type ProjectMove = 'up' | 'down' | 'top' | 'bottom'

export interface ProjectsApi {
  projects: {
    state: () => Promise<ProjectsState>
    create: (
      name: string,
      icon: ProjectIcon | null,
    ) => Promise<{ project: Project; state: ProjectsState }>
    rename: (id: string, name: string, icon: ProjectIcon | null) => Promise<ProjectsState>
    /** Deletes the project; its chats are kept and become unfiled. */
    remove: (id: string) => Promise<ProjectsState>
    move: (id: string, to: ProjectMove) => Promise<ProjectsState>
  }
  chats: {
    pin: (chat: ChatRef, pinned: boolean) => Promise<ProjectsState>
    archive: (chat: ChatRef, archived: boolean) => Promise<ProjectsState>
    /** Files the chat in a project, or takes it out of its project (null). */
    move: (chat: ChatRef, projectId: string | null) => Promise<ProjectsState>
    /**
     * Copies the chat's messages and tool results into a new chat of the same
     * provider ("Fork of …"); approvals are never copied. `prompts`: keep the first
     * that many prompts and their replies (null: the whole chat).
     */
    fork: (
      chat: ChatRef,
      prompts: number | null,
    ) => Promise<{ chat: ChatRef; state: ProjectsState }>
    rename: (chat: ChatRef, title: string) => Promise<ProjectsState>
    /** Deletes the chat for good. */
    remove: (chat: ChatRef) => Promise<ProjectsState>
    /**
     * Opens a chat of any provider: another provider's chat switches provider
     * (stopping a running reply, as a switch in Settings does).
     */
    open: (chat: ChatRef) => Promise<ProviderStatus>
  }
}
