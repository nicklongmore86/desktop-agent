import { useEffect, useRef, useState } from 'react'
import { Archive, SquarePen } from 'lucide-react'
import { createPortal } from 'react-dom'
import type { HistoryState } from '../../../../shared/ipc'
import type { ConnectionId } from '../../../../shared/ipc-connections'
import type { ChatRef, Project, ProviderChat } from '../../../../shared/ipc-projects'
import { useApi } from '../../api'
import { ConfirmDeleteDialog } from '../ConfirmDeleteDialog'
import { HistoryList, type ChatListActions, type SectionId } from '../HistoryList'
import { arrangeChats } from '../sidebar/arrange'
import { ConfirmDialog, ForkDialog, ProjectDialog } from '../sidebar/dialogs'
import { useProjects } from '../sidebar/use-projects'
import type { PaneVariant } from './shell-context'
import { useShell } from './shell-context'

const UNDO_MS = 6000
const SECTIONS_KEY = 'desktop-agent:sidebar-sections'
const PROJECTS_KEY = 'desktop-agent:collapsed-projects'

/** A per-window convenience: storage may be unavailable, and then nothing is remembered. */
function useStoredSet<T extends string>(key: string): [ReadonlySet<T>, (value: T) => void] {
  const [set, setSet] = useState<ReadonlySet<T>>(() => {
    try {
      const raw: unknown = JSON.parse(localStorage.getItem(key) ?? '[]')
      return new Set(Array.isArray(raw) ? raw.filter((v): v is T => typeof v === 'string') : [])
    } catch {
      return new Set()
    }
  })
  const toggle = (value: T): void => {
    setSet((current) => {
      const next = new Set(current)
      if (!next.delete(value)) next.add(value)
      try {
        localStorage.setItem(key, JSON.stringify([...next]))
      } catch {
        // Not remembered; it still works for this session.
      }
      return next
    })
  }
  return [set, toggle]
}

type Dialog =
  | { kind: 'new-project'; thenMove?: ProviderChat }
  | { kind: 'rename-project'; project: Project }
  | { kind: 'delete-project'; project: Project; chats: number }
  | { kind: 'delete-chat'; chat: ProviderChat }
  | { kind: 'fork'; chat: ProviderChat }

interface Undo {
  id: number
  message: string
  undo: () => void
}

const ref = (chat: ProviderChat): ChatRef => ({ provider: chat.provider, id: chat.id })

/**
 * The chats in the left sidebar (and its drawer): the New chat row, then Pinned,
 * Projects and Chats, and a quiet Archived toggle at the bottom. Owns the chat actions' dialogs
 * (rendered over everything, and hidden while an approval is open) and the
 * Undo toast for archive, unpin and move. The sidebar frame around it (brand,
 * footer, resizing, drawers) is the shell's.
 */
export function ChatsPane({
  variant,
  history,
  switching,
  running,
  provider,
  prompts,
  suspended,
  onNewChat,
  onOpen,
  onOpenOther,
  onRename,
  onDelete,
  onBlocking,
}: {
  variant: PaneVariant
  history: HistoryState
  switching: boolean
  /** A reply is running in the open chat. */
  running: boolean
  /** The open provider, once known. */
  provider: ConnectionId | null
  /** The open chat's prompts, oldest first (to fork from one of them). */
  prompts: string[]
  /** An approval is open: dialogs here hide until it is answered. */
  suspended: boolean
  onNewChat: () => void
  /** Opens one of the open provider's chats. */
  onOpen: (id: string) => void
  /** Opens another provider's chat, switching provider. */
  onOpenOther: (chat: ChatRef) => void
  onRename: (id: string, title: string) => Promise<boolean>
  /** Deletes one of the open provider's chats (deleting the open one starts a new chat). */
  onDelete: (id: string) => void
  /** A dialog of this pane is open: the app's shortcuts wait. */
  onBlocking: (blocking: boolean) => void
}): React.JSX.Element {
  const api = useApi()
  const { closeDrawer } = useShell()
  const projects = useProjects()
  const [view, setView] = useState<'chats' | 'archived'>('chats')
  const [dialog, setDialog] = useState<Dialog | null>(null)
  const [undo, setUndo] = useState<Undo | null>(null)
  const [sections, toggleSection] = useStoredSet<SectionId>(SECTIONS_KEY)
  const [collapsedProjects, toggleProject] = useStoredSet<string>(PROJECTS_KEY)
  const counter = useRef(0)
  const paused = useRef(false)
  const arranged = arrangeChats(history, projects.state, provider)
  const own = provider ?? projects.state?.provider ?? null
  const isOwn = (chat: ProviderChat): boolean => chat.provider === own

  const hasDialog = dialog !== null
  useEffect(() => {
    if (!hasDialog) return
    onBlocking(true)
    return () => {
      onBlocking(false)
    }
  }, [hasDialog, onBlocking])
  useEffect(() => {
    if (!undo) return
    const timer = setInterval(() => {
      if (!paused.current) setUndo((current) => (current?.id === undo.id ? null : current))
    }, UNDO_MS)
    return () => {
      clearInterval(timer)
    }
  }, [undo])

  const offerUndo = (message: string, run: () => void): void => {
    counter.current += 1
    setUndo({ id: counter.current, message, undo: run })
  }
  const title = (chat: ProviderChat): string =>
    chat.title.length > 40 ? `${Array.from(chat.title).slice(0, 39).join('')}…` : chat.title

  const pin = async (chat: ProviderChat, pinned: boolean): Promise<void> => {
    if (!(await projects.run(() => api.chats.pin(ref(chat), pinned)))) return
    if (!pinned)
      offerUndo(`Unpinned “${title(chat)}”`, () => {
        void projects.run(() => api.chats.pin(ref(chat), true))
      })
  }
  const archive = async (chat: ProviderChat, archived: boolean): Promise<void> => {
    if (!(await projects.run(() => api.chats.archive(ref(chat), archived)))) return
    if (archived)
      offerUndo(`Archived “${title(chat)}”`, () => {
        void projects.run(() => api.chats.archive(ref(chat), false))
      })
  }
  const move = async (chat: ProviderChat, projectId: string | null): Promise<void> => {
    const from = chat.projectId ?? null
    if (!(await projects.run(() => api.chats.move(ref(chat), projectId)))) return
    const to = projects.state?.projects.find((p) => p.id === projectId)
    offerUndo(
      to ? `Moved “${title(chat)}” to ${to.name}` : `Removed “${title(chat)}” from its project`,
      () => {
        void projects.run(() => api.chats.move(ref(chat), from))
      },
    )
  }
  const open = (chat: ProviderChat): void => {
    closeDrawer()
    if (isOwn(chat)) onOpen(chat.id)
    else onOpenOther(ref(chat))
  }

  const actions: ChatListActions = {
    open,
    rename: async (chat, name) => {
      if (isOwn(chat)) return onRename(chat.id, name)
      return (await projects.run(() => api.chats.rename(ref(chat), name))) !== null
    },
    remove: (chat) => {
      setDialog({ kind: 'delete-chat', chat })
    },
    pin: (chat, pinned) => void pin(chat, pinned),
    archive: (chat, archived) => void archive(chat, archived),
    move: (chat, projectId) => void move(chat, projectId),
    moveToNewProject: (chat) => {
      setDialog({ kind: 'new-project', thenMove: chat })
    },
    fork: (chat) => {
      setDialog({ kind: 'fork', chat })
    },
    drop: (chat, action) => {
      if (action.kind === 'pin') void pin(chat, true)
      else if (action.kind === 'move') {
        const projectId = action.projectId
        void (async () => {
          if (action.unpin) await projects.run(() => api.chats.pin(ref(chat), false))
          await move(chat, projectId)
        })()
      } else if (action.kind === 'ungroup') {
        void (async () => {
          if (action.unfile) await move(chat, null)
          if (action.unpin) await pin(chat, false)
        })()
      }
    },
    newProject: () => {
      setDialog({ kind: 'new-project' })
    },
    renameProject: (project) => {
      setDialog({ kind: 'rename-project', project })
    },
    moveProject: (project, to) => void projects.run(() => api.projects.move(project.id, to)),
    removeProject: (project) => {
      const group = arranged.projects.find((g) => g.project.id === project.id)
      setDialog({ kind: 'delete-project', project, chats: group?.chats.length ?? 0 })
    },
  }

  const close = (): void => {
    setDialog(null)
  }

  const renderDialog = (): React.ReactNode => {
    if (!dialog) return null
    switch (dialog.kind) {
      case 'new-project':
        return (
          <ProjectDialog
            suspended={suspended}
            onCancel={close}
            onSave={(name, icon) => {
              close()
              void (async () => {
                const made = await projects.run(() => api.projects.create(name, icon))
                if (made && dialog.thenMove) await move(dialog.thenMove, made.project.id)
              })()
            }}
          />
        )
      case 'rename-project':
        return (
          <ProjectDialog
            initial={dialog.project}
            suspended={suspended}
            onCancel={close}
            onSave={(name, icon) => {
              close()
              void projects.run(() => api.projects.rename(dialog.project.id, name, icon))
            }}
          />
        )
      case 'delete-project':
        return (
          <ConfirmDialog
            title="Delete project?"
            confirmLabel="Delete project"
            suspended={suspended}
            onCancel={close}
            onConfirm={() => {
              close()
              void projects.run(() => api.projects.remove(dialog.project.id))
            }}
          >
            <p>
              “<bdi className="confirm-title">{dialog.project.name}</bdi>” will be deleted.{' '}
              {dialog.chats === 0
                ? 'It has no chats.'
                : `Its ${String(dialog.chats)} ${dialog.chats === 1 ? 'chat is' : 'chats are'} kept and move out of the project.`}
            </p>
          </ConfirmDialog>
        )
      case 'delete-chat':
        return (
          <ConfirmDeleteDialog
            title={dialog.chat.title}
            suspended={suspended}
            onCancel={close}
            onConfirm={() => {
              close()
              if (isOwn(dialog.chat)) onDelete(dialog.chat.id)
              else void projects.run(() => api.chats.remove(ref(dialog.chat)))
            }}
          />
        )
      case 'fork': {
        const source = dialog.chat
        const isOpen = isOwn(source) && source.id === history.activeId
        return (
          <ForkDialog
            title={source.title}
            prompts={isOpen ? prompts : []}
            suspended={suspended}
            onCancel={close}
            onFork={(upTo) => {
              close()
              void (async () => {
                const forked = await projects.run(() => api.chats.fork(ref(source), upTo))
                if (!forked) return
                closeDrawer()
                if (isOwn(source)) onOpen(forked.chat.id)
                else onOpenOther(forked.chat)
              })()
            }}
          />
        )
      }
    }
  }

  return (
    <>
      <button
        className="sidebar-new"
        type="button"
        disabled={switching}
        aria-keyshortcuts="Control+N"
        onClick={onNewChat}
      >
        <SquarePen className="sidebar-row-icon" aria-hidden="true" />
        <span className="sidebar-row-label">New chat</span>
        <kbd className="sidebar-row-hint" aria-hidden="true">
          Ctrl+N
        </kbd>
      </button>
      {projects.error && (
        <p className="sidebar-error" role="alert">
          {projects.error}{' '}
          <button
            type="button"
            className="link-button"
            onClick={() => {
              projects.setError(null)
            }}
          >
            Dismiss
          </button>
        </p>
      )}
      <HistoryList
        arranged={arranged}
        view={view}
        provider={own}
        activeId={history.activeId}
        busy={switching}
        running={running}
        collapsed={sections}
        onToggleSection={toggleSection}
        collapsedProjects={collapsedProjects}
        onToggleProject={toggleProject}
        actions={actions}
      />
      <button
        type="button"
        className="sidebar-filter"
        aria-pressed={view === 'archived'}
        onClick={() => {
          setView((current) => (current === 'archived' ? 'chats' : 'archived'))
        }}
      >
        <Archive className="sidebar-row-icon" aria-hidden="true" />
        <span className="sidebar-row-label">Archived</span>
        {arranged.archived.length > 0 && (
          <span className="filter-count">{arranged.archived.length}</span>
        )}
      </button>
      {renderDialog()}
      {undo &&
        createPortal(
          <div
            className="undo-toast"
            role="status"
            data-variant={variant}
            onMouseEnter={() => {
              paused.current = true
            }}
            onMouseLeave={() => {
              paused.current = false
            }}
            onFocus={() => {
              paused.current = true
            }}
            onBlur={() => {
              paused.current = false
            }}
          >
            <span className="undo-message">{undo.message}</span>
            <button
              type="button"
              className="link-button"
              onClick={() => {
                const run = undo.undo
                setUndo(null)
                paused.current = false
                run()
              }}
            >
              Undo
            </button>
          </div>,
          document.body,
        )}
    </>
  )
}
