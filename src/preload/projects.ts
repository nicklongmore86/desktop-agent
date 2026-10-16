import { projectsChannels as c, type ProjectsApi } from '../shared/ipc-projects'
import type { Invoke } from './features'

export const projectsApi = (invoke: Invoke): ProjectsApi => ({
  projects: {
    state: () => invoke(c.projectsState),
    create: (name, icon) => invoke(c.projectsCreate, name, icon),
    rename: (id, name, icon) => invoke(c.projectsRename, id, name, icon),
    remove: (id) => invoke(c.projectsDelete, id),
    move: (id, to) => invoke(c.projectsMove, id, to),
  },
  chats: {
    pin: (chat, pinned) => invoke(c.chatPin, chat, pinned),
    archive: (chat, archived) => invoke(c.chatArchive, chat, archived),
    move: (chat, projectId) => invoke(c.chatMove, chat, projectId),
    fork: (chat, prompts) => invoke(c.chatFork, chat, prompts),
    rename: (chat, title) => invoke(c.chatRename, chat, title),
    remove: (chat) => invoke(c.chatDelete, chat),
    open: (chat) => invoke(c.chatOpen, chat),
  },
})
