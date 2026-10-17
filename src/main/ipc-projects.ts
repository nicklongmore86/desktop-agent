import { z } from 'zod'
import type { ProviderStatus } from '../shared/ipc'
import {
  PROJECT_ICONS,
  projectsChannels,
  type ChatRef,
  type Project,
  type ProjectIcon,
  type ProjectMove,
  type ProjectsState,
} from '../shared/ipc-projects'
import { connectionIdSchema, type ConnectionsService } from './ipc-connections'
import type { IpcHandle } from './ipc-features'
import { CONVERSATION_ID } from './storage/history-store'
import { PROJECT_ID } from './storage/projects-schema'

export interface ProjectsService {
  state: () => Promise<ProjectsState>
  create: (
    name: string,
    icon: ProjectIcon | null,
  ) => Promise<{ project: Project; state: ProjectsState }>
  rename: (id: string, name: string, icon: ProjectIcon | null) => Promise<ProjectsState>
  remove: (id: string) => Promise<ProjectsState>
  move: (id: string, to: ProjectMove) => Promise<ProjectsState>
  pin: (chat: ChatRef, pinned: boolean) => Promise<ProjectsState>
  archive: (chat: ChatRef, archived: boolean) => Promise<ProjectsState>
  moveChat: (chat: ChatRef, projectId: string | null) => Promise<ProjectsState>
  fork: (chat: ChatRef, prompts: number | null) => Promise<{ chat: ChatRef; state: ProjectsState }>
  renameChat: (chat: ChatRef, title: string) => Promise<ProjectsState>
  removeChat: (chat: ChatRef) => Promise<ProjectsState>
  open: (chat: ChatRef) => Promise<ProviderStatus>
}

// Ids are main's own random UUIDs; anything else, a path fragment included, is
// refused here, before it reaches a store. Objects are strict: no extra keys. The
// connection must also be one the registry offers (checked in the handlers).
const chatSchema = z.strictObject({
  provider: connectionIdSchema,
  id: z.string().regex(CONVERSATION_ID),
})
const projectIdSchema = z.string().regex(PROJECT_ID)
const nameSchema = z.string().max(1000)
const iconSchema = z.enum(PROJECT_ICONS).nullable()
const moveSchema = z.enum(['up', 'down', 'top', 'bottom'])
const promptsSchema = z.number().int().min(1).max(100_000).nullable()

function parse<T>(schema: z.ZodType<T>, value: unknown, message: string): T {
  const parsed = schema.safeParse(value)
  if (!parsed.success) throw new Error(message)
  return parsed.data
}
const projectId = (value: unknown): string => parse(projectIdSchema, value, 'Unknown project.')
const flag = (value: unknown): boolean => parse(z.boolean(), value, 'Invalid choice.')
const name = (value: unknown): string => parse(nameSchema, value, 'Enter a shorter name.')
const icon = (value: unknown): ProjectIcon | null => parse(iconSchema, value, 'Unknown icon.')

export function registerProjectsHandlers(
  handle: IpcHandle,
  projects: ProjectsService,
  connections: Pick<ConnectionsService, 'available'>,
): void {
  const chat = (value: unknown): ChatRef => {
    const ref = parse(chatSchema, value, 'Unknown chat.')
    if (!connections.available(ref.provider)) throw new Error('Unknown chat.')
    return ref
  }
  const c = projectsChannels
  handle(c.projectsState, () => projects.state())
  handle(c.projectsCreate, (n, i) => projects.create(name(n), icon(i)))
  handle(c.projectsRename, (id, n, i) => projects.rename(projectId(id), name(n), icon(i)))
  handle(c.projectsDelete, (id) => projects.remove(projectId(id)))
  handle(c.projectsMove, (id, to) =>
    projects.move(projectId(id), parse(moveSchema, to, 'Invalid move.')),
  )
  handle(c.chatPin, (ref, pinned) => projects.pin(chat(ref), flag(pinned)))
  handle(c.chatArchive, (ref, archived) => projects.archive(chat(ref), flag(archived)))
  handle(c.chatMove, (ref, id) => projects.moveChat(chat(ref), id === null ? null : projectId(id)))
  handle(c.chatFork, (ref, prompts) =>
    projects.fork(chat(ref), parse(promptsSchema, prompts, 'Invalid fork point.')),
  )
  handle(c.chatRename, (ref, title) => projects.renameChat(chat(ref), name(title)))
  handle(c.chatDelete, (ref) => projects.removeChat(chat(ref)))
  handle(c.chatOpen, (ref) => projects.open(chat(ref)))
}
