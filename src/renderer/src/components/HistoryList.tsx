import { useCallback, useEffect, useId, useRef, useState } from 'react'
import type { ConversationSummary } from '../../../shared/ipc'
import type { ConnectionId } from '../../../shared/ipc-connections'
import { connectionOf, useConnections } from '../connections'
import type { Project, ProjectMove, ProviderChat } from '../../../shared/ipc-projects'
import type { Arranged } from './sidebar/arrange'
import { resolveDrop, type DropAction, type DropTarget } from './sidebar/drop'
import { Menu, type MenuItem, type MenuPosition } from './sidebar/Menu'

const DAY = 24 * 60 * 60 * 1000

export interface HistoryGroup<T extends ConversationSummary = ConversationSummary> {
  label: 'Today' | 'Previous 7 days' | 'Older'
  conversations: T[]
}

/** Groups chats (already newest first) by when they were last used, in local time. */
export function groupConversations<T extends ConversationSummary>(
  conversations: readonly T[],
  now: number = Date.now(),
): HistoryGroup<T>[] {
  const midnight = new Date(now)
  midnight.setHours(0, 0, 0, 0)
  const today = midnight.getTime()
  const groups: HistoryGroup<T>[] = [
    { label: 'Today', conversations: [] },
    { label: 'Previous 7 days', conversations: [] },
    { label: 'Older', conversations: [] },
  ]
  for (const conversation of conversations) {
    const index =
      conversation.updatedAt >= today ? 0 : conversation.updatedAt >= today - 7 * DAY ? 1 : 2
    groups[index]?.conversations.push(conversation)
  }
  return groups.filter((group) => group.conversations.length > 0)
}

export type SectionId = 'pinned' | 'projects' | 'chats'

/** What the list asks the chat pane to do. */
export interface ChatListActions {
  open: (chat: ProviderChat) => void
  /** Resolves false when the rename failed (the pane shows why). */
  rename: (chat: ProviderChat, title: string) => Promise<boolean>
  /** Asks the user to confirm, then deletes. */
  remove: (chat: ProviderChat) => void
  pin: (chat: ProviderChat, pinned: boolean) => void
  archive: (chat: ProviderChat, archived: boolean) => void
  move: (chat: ProviderChat, projectId: string | null) => void
  /** Opens New project, then files the chat in it. */
  moveToNewProject: (chat: ProviderChat) => void
  fork: (chat: ProviderChat) => void
  drop: (chat: ProviderChat, action: DropAction) => void
  newProject: () => void
  renameProject: (project: Project) => void
  moveProject: (project: Project, to: ProjectMove) => void
  removeProject: (project: Project) => void
}

export interface HistoryListProps {
  arranged: Arranged
  view: 'chats' | 'archived'
  /** The open provider and its open chat. */
  provider: ConnectionId | null
  activeId: string | null
  /** A switch is under way: opening another chat waits until it is done. */
  busy: boolean
  /** A reply is running: forking waits for it (opening the fork would stop it). */
  running: boolean
  collapsed: ReadonlySet<SectionId>
  onToggleSection: (section: SectionId) => void
  collapsedProjects: ReadonlySet<string>
  onToggleProject: (id: string) => void
  actions: ChatListActions
  /** For tests: what "today" is. */
  now?: number
}

/** The longest name a rename sends; main cuts names to the same length. */
const MAX_NAME = 100

const keyOf = (chat: ProviderChat): string => `${chat.provider}:${chat.id}`
const NAV = '.history-open, .project-toggle'

function RenameField({
  initial,
  onDone,
}: {
  initial: string
  onDone: (title: string | null) => void
}): React.JSX.Element {
  const [value, setValue] = useState(initial)
  const input = useRef<HTMLInputElement>(null)
  const done = useRef(false)
  useEffect(() => {
    input.current?.focus()
    input.current?.select()
  }, [])
  const finish = (title: string | null): void => {
    if (done.current) return
    done.current = true
    onDone(title)
  }
  return (
    <input
      ref={input}
      className="history-rename"
      aria-label="Chat name"
      value={value}
      maxLength={MAX_NAME}
      onChange={(event) => {
        setValue(event.target.value)
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault()
          finish(value)
        } else if (event.key === 'Escape') {
          // Handled here: Escape must not also stop a running reply.
          event.preventDefault()
          event.stopPropagation()
          finish(null)
        }
      }}
      onBlur={() => {
        finish(value)
      }}
    />
  )
}

type OpenMenu = { key: string; position: MenuPosition }

/**
 * The chat list: Pinned, Projects (folders) and Chats (the open provider's
 * other chats, by date), or the archived chats. Each chat opens with Enter or
 * a click; arrow keys (and Home/End) move between chats and project folders;
 * F2 renames, Delete asks to delete, Shift+F10 or the ⋯ button or a right-click
 * opens the chat's menu, which holds every action (dragging is a shortcut for
 * Pin and Move to project, never the only way). Titles are plain text from
 * main, isolated so a right-to-left title cannot reorder the text around it.
 */
export function HistoryList({
  arranged,
  view,
  provider,
  activeId,
  busy,
  running,
  collapsed,
  onToggleSection,
  collapsedProjects,
  onToggleProject,
  actions,
  now,
}: HistoryListProps): React.JSX.Element {
  const connections = useConnections()
  const [menu, setMenu] = useState<OpenMenu | null>(null)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [dragging, setDragging] = useState<ProviderChat | null>(null)
  const [over, setOver] = useState<string | null>(null)
  const labelId = useId()
  // Looked up by id, not a ref: the menus' handlers are built while rendering.
  const scrollId = `${labelId}-scroll`
  const inList = <T extends HTMLElement>(selector: string): T[] => [
    ...(document.getElementById(scrollId)?.querySelectorAll<T>(selector) ?? []),
  ]
  const projects = arranged.projects.map((group) => group.project)

  const control = (key: string, selector: '.history-open' | '.history-more' | '.project-toggle') =>
    inList(selector).find((element) => element.dataset['key'] === key)
  const focusLater = (key: string, selector: '.history-open' | '.history-more'): void => {
    requestAnimationFrame(() => control(key, selector)?.focus())
  }

  // Stable, so the open menu's listeners are not re-attached on every render.
  const closeMenu = useCallback(
    (refocus: boolean): void => {
      setMenu((open) => {
        if (open && refocus) {
          requestAnimationFrame(() => {
            const buttons = document.getElementById(scrollId)?.querySelectorAll('.history-more')
            ;[...(buttons ?? [])]
              .filter((element) => element instanceof HTMLElement)
              .find((element) => element.dataset['key'] === open.key)
              ?.focus()
          })
        }
        return null
      })
    },
    [scrollId],
  )

  const openMenuAt = (key: string, anchor: HTMLElement | { x: number; y: number }): void => {
    if (anchor instanceof HTMLElement) {
      const rect = anchor.getBoundingClientRect()
      setMenu({
        key,
        position: { top: rect.bottom, right: Math.max(0, window.innerWidth - rect.right) },
      })
    } else {
      setMenu({ key, position: { top: anchor.y, left: anchor.x } })
    }
  }

  const onNavKeyDown = (event: React.KeyboardEvent<HTMLElement>): boolean => {
    const buttons = inList(NAV)
    const index = buttons.indexOf(event.currentTarget)
    const target =
      event.key === 'ArrowDown'
        ? buttons[index + 1]
        : event.key === 'ArrowUp'
          ? buttons[index - 1]
          : event.key === 'Home'
            ? buttons[0]
            : event.key === 'End'
              ? buttons.at(-1)
              : undefined
    if (!target) return false
    event.preventDefault()
    target.focus()
    return true
  }

  const chatMenu = (chat: ProviderChat): MenuItem[] => {
    const close = (run: () => void) => () => {
      setMenu(null)
      run()
    }
    const pinned = chat.pinnedAt !== undefined
    const filed = chat.projectId !== undefined && projects.some((p) => p.id === chat.projectId)
    const rename: MenuItem = {
      label: 'Rename',
      onSelect: close(() => {
        setRenaming(keyOf(chat))
      }),
    }
    const remove: MenuItem = {
      label: 'Delete…',
      danger: true,
      separated: true,
      disabled: busy && 'Wait until the chat has opened.',
      onSelect: () => {
        setMenu(null)
        // The confirmation gives focus back here when it closes.
        control(keyOf(chat), '.history-more')?.focus()
        actions.remove(chat)
      },
    }
    if (chat.archivedAt !== undefined)
      return [
        {
          label: 'Restore',
          onSelect: close(() => {
            actions.archive(chat, false)
          }),
        },
        rename,
        remove,
      ]
    const destinations: MenuItem[] = [
      ...projects
        .filter((project) => project.id !== chat.projectId)
        .map((project) => ({
          label: project.icon ? `${project.icon} ${project.name}` : project.name,
          onSelect: close(() => {
            actions.move(chat, project.id)
          }),
        })),
      {
        label: 'New project…',
        separated: projects.length > 0,
        onSelect: () => {
          setMenu(null)
          control(keyOf(chat), '.history-more')?.focus()
          actions.moveToNewProject(chat)
        },
      },
      ...(filed
        ? [
            {
              label: 'Remove from project',
              onSelect: close(() => {
                actions.move(chat, null)
              }),
            },
          ]
        : []),
    ]
    return [
      {
        label: pinned ? 'Unpin' : 'Pin',
        onSelect: close(() => {
          actions.pin(chat, !pinned)
        }),
      },
      {
        label: 'Fork…',
        disabled: running
          ? 'Wait for the reply to finish, or stop it.'
          : busy && 'Wait until the chat has opened.',
        onSelect: () => {
          setMenu(null)
          control(keyOf(chat), '.history-more')?.focus()
          actions.fork(chat)
        },
      },
      rename,
      {
        label: 'Move to project',
        submenu: { label: 'Move to project', items: destinations },
      },
      {
        label: 'Archive',
        separated: true,
        onSelect: close(() => {
          actions.archive(chat, true)
        }),
      },
      remove,
    ]
  }

  const projectMenu = (project: Project, index: number): MenuItem[] => {
    const last = projects.length - 1
    const close = (run: () => void) => () => {
      setMenu(null)
      control(`project:${project.id}`, '.history-more')?.focus()
      run()
    }
    const move = (label: string, to: ProjectMove, blocked: boolean): MenuItem => ({
      label,
      disabled: blocked && (to === 'up' || to === 'top' ? 'Already first.' : 'Already last.'),
      onSelect: close(() => {
        actions.moveProject(project, to)
      }),
    })
    return [
      {
        label: 'Rename project…',
        onSelect: close(() => {
          actions.renameProject(project)
        }),
      },
      move('Move up', 'up', index === 0),
      move('Move down', 'down', index === last),
      move('Move to top', 'top', index === 0),
      move('Move to bottom', 'bottom', index === last),
      {
        label: 'Delete project…',
        danger: true,
        separated: true,
        onSelect: close(() => {
          actions.removeProject(project)
        }),
      },
    ]
  }

  /** Drop-target props for a part of the list. */
  const dropZone = (key: string, target: DropTarget) => {
    const action = dragging
      ? resolveDrop(
          {
            pinned: dragging.pinnedAt !== undefined,
            projectId:
              dragging.projectId !== undefined && projects.some((p) => p.id === dragging.projectId)
                ? dragging.projectId
                : null,
            archived: dragging.archivedAt !== undefined,
          },
          target,
        )
      : ({ kind: 'none' } as const)
    const accepts = action.kind !== 'none'
    return {
      'data-drop': dragging ? (accepts ? (over === key ? 'over' : 'can') : undefined) : undefined,
      onDragOver: (event: React.DragEvent) => {
        // Only a chat dragged from this list: a drag from another app has no `dragging`.
        if (!accepts) return
        event.preventDefault()
        event.stopPropagation()
        event.dataTransfer.dropEffect = 'move'
        if (over !== key) setOver(key)
      },
      onDragLeave: (event: React.DragEvent) => {
        if (
          event.relatedTarget instanceof Node &&
          event.currentTarget.contains(event.relatedTarget)
        )
          return
        setOver((current) => (current === key ? null : current))
      },
      onDrop: (event: React.DragEvent) => {
        if (!accepts || !dragging) return
        event.preventDefault()
        event.stopPropagation()
        const chat = dragging
        setDragging(null)
        setOver(null)
        actions.drop(chat, action)
      },
    }
  }

  const row = (chat: ProviderChat): React.JSX.Element => {
    const key = keyOf(chat)
    const active = chat.provider === provider && chat.id === activeId
    const other = chat.provider !== provider
    // Short connection names, for chats of a connection that is not the open one.
    const otherName = connectionOf(connections, chat.provider)?.shortLabel ?? ''
    return (
      <li
        key={key}
        className="history-item"
        data-active={active || undefined}
        data-dragging={dragging && keyOf(dragging) === key ? true : undefined}
        draggable={renaming !== key && chat.archivedAt === undefined}
        onDragStart={(event) => {
          event.dataTransfer.effectAllowed = 'move'
          // Opaque to other apps: just the id. The list keeps the chat itself.
          event.dataTransfer.setData('application/x-desktop-agent-chat', chat.id)
          setMenu(null)
          setDragging(chat)
        }}
        onDragEnd={() => {
          setDragging(null)
          setOver(null)
        }}
        onContextMenu={(event) => {
          event.preventDefault()
          openMenuAt(key, { x: event.clientX, y: event.clientY })
        }}
      >
        {renaming === key ? (
          <RenameField
            initial={chat.title}
            onDone={(title) => {
              setRenaming(null)
              focusLater(key, '.history-open')
              const next = title?.trim()
              if (next && next !== chat.title) void actions.rename(chat, next)
            }}
          />
        ) : (
          <button
            type="button"
            className="history-open"
            data-key={key}
            aria-current={active ? 'page' : undefined}
            title={
              other ? `${chat.title} (${otherName}: opening it switches provider)` : chat.title
            }
            onClick={() => {
              if (!busy && !active) actions.open(chat)
            }}
            onKeyDown={(event) => {
              if (onNavKeyDown(event)) return
              if (event.key === 'F2') {
                event.preventDefault()
                setRenaming(key)
              } else if (event.key === 'Delete' && !busy) {
                event.preventDefault()
                actions.remove(chat)
              } else if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
                event.preventDefault()
                const more = control(key, '.history-more')
                if (more) openMenuAt(key, more)
              }
            }}
          >
            <bdi className="history-title">{chat.title}</bdi>
            {other && (
              <span className="chat-provider" aria-hidden="true">
                {otherName}
              </span>
            )}
          </button>
        )}
        <button
          type="button"
          className="history-more"
          data-key={key}
          aria-label={`Options for ${chat.title}`}
          aria-haspopup="menu"
          aria-expanded={menu?.key === key}
          onClick={(event) => {
            if (menu?.key === key) setMenu(null)
            else openMenuAt(key, event.currentTarget)
          }}
        >
          <span aria-hidden="true">⋯</span>
        </button>
        {menu?.key === key && (
          <Menu
            label={`Options for ${chat.title}`}
            position={menu.position}
            items={chatMenu(chat)}
            onClose={closeMenu}
          />
        )}
      </li>
    )
  }

  const sectionHeader = (id: SectionId, title: string, extra?: React.ReactNode) => (
    <div className="chat-section-header">
      <h2 className="sidebar-label" id={`${labelId}-${id}`}>
        <button
          type="button"
          className="section-toggle"
          aria-expanded={!collapsed.has(id)}
          onClick={() => {
            onToggleSection(id)
          }}
        >
          <span className="section-caret" aria-hidden="true" />
          {title}
        </button>
      </h2>
      {extra}
    </div>
  )

  const dateGroups = (chats: ProviderChat[], prefix: string) =>
    groupConversations(chats, now).map((group, index) => (
      <section
        key={group.label}
        className="history-group"
        aria-labelledby={`${labelId}-${prefix}-${String(index)}`}
      >
        <h3 className="history-group-label" id={`${labelId}-${prefix}-${String(index)}`}>
          {group.label}
        </h3>
        <ul>{group.conversations.map(row)}</ul>
      </section>
    ))

  const draggingFiled =
    dragging !== null &&
    (dragging.pinnedAt !== undefined ||
      (dragging.projectId !== undefined && projects.some((p) => p.id === dragging.projectId)))

  return (
    <nav className="sidebar-section sidebar-history" aria-label="Chats">
      <div id={scrollId} className="history-scroll" data-dragging={dragging ? true : undefined}>
        {view === 'archived' ? (
          <section className="chat-section" aria-labelledby={`${labelId}-archived`}>
            <h2 className="sidebar-label" id={`${labelId}-archived`}>
              Archived
            </h2>
            {arranged.archived.length === 0 ? (
              <p className="sidebar-hint">No archived chats</p>
            ) : (
              dateGroups(arranged.archived, 'archived')
            )}
          </section>
        ) : (
          <>
            {(arranged.pinned.length > 0 || dragging) && (
              <section
                className="chat-section"
                aria-labelledby={`${labelId}-pinned`}
                {...dropZone('pin', { kind: 'pin' })}
              >
                {sectionHeader('pinned', 'Pinned')}
                {!collapsed.has('pinned') &&
                  (arranged.pinned.length > 0 ? (
                    <ul className="chat-rows">{arranged.pinned.map(row)}</ul>
                  ) : (
                    <p className="drop-hint">Drop here to pin</p>
                  ))}
              </section>
            )}
            <section className="chat-section" aria-labelledby={`${labelId}-projects`}>
              {sectionHeader(
                'projects',
                'Projects',
                <button
                  type="button"
                  className="section-add"
                  aria-label="New project"
                  title="New project"
                  onClick={actions.newProject}
                >
                  <span aria-hidden="true">+</span>
                </button>,
              )}
              {!collapsed.has('projects') &&
                (arranged.projects.length === 0 ? (
                  <p className="sidebar-hint">Group chats into projects with +</p>
                ) : (
                  <ul className="project-list">
                    {arranged.projects.map(({ project, chats }, index) => {
                      const key = `project:${project.id}`
                      const open = !collapsedProjects.has(project.id)
                      return (
                        <li
                          key={key}
                          className="project-folder"
                          {...dropZone(key, { kind: 'project', projectId: project.id })}
                        >
                          <div className="project-row">
                            <button
                              type="button"
                              className="project-toggle"
                              data-key={key}
                              aria-expanded={open}
                              onClick={() => {
                                onToggleProject(project.id)
                              }}
                              onKeyDown={(event) => {
                                if (onNavKeyDown(event)) return
                                if (
                                  (event.key === 'ArrowRight' && !open) ||
                                  (event.key === 'ArrowLeft' && open)
                                ) {
                                  event.preventDefault()
                                  onToggleProject(project.id)
                                } else if (
                                  event.key === 'ContextMenu' ||
                                  (event.shiftKey && event.key === 'F10')
                                ) {
                                  event.preventDefault()
                                  const more = control(key, '.history-more')
                                  if (more) openMenuAt(key, more)
                                }
                              }}
                              onContextMenu={(event) => {
                                event.preventDefault()
                                openMenuAt(key, { x: event.clientX, y: event.clientY })
                              }}
                            >
                              <span className="project-icon" aria-hidden="true">
                                {project.icon ?? <span className="project-caret" />}
                              </span>
                              <bdi className="history-title">{project.name}</bdi>
                              <span className="project-count" aria-hidden="true">
                                {chats.length || ''}
                              </span>
                            </button>
                            <button
                              type="button"
                              className="history-more"
                              data-key={key}
                              aria-label={`Options for project ${project.name}`}
                              aria-haspopup="menu"
                              aria-expanded={menu?.key === key}
                              onClick={(event) => {
                                if (menu?.key === key) setMenu(null)
                                else openMenuAt(key, event.currentTarget)
                              }}
                            >
                              <span aria-hidden="true">⋯</span>
                            </button>
                            {menu?.key === key && (
                              <Menu
                                label={`Options for project ${project.name}`}
                                position={menu.position}
                                items={projectMenu(project, index)}
                                onClose={closeMenu}
                              />
                            )}
                          </div>
                          {open &&
                            (chats.length > 0 ? (
                              <ul className="chat-rows project-chats">{chats.map(row)}</ul>
                            ) : (
                              <p className="drop-hint">
                                No chats yet. Drag one here, or use Move to project.
                              </p>
                            ))}
                        </li>
                      )
                    })}
                  </ul>
                ))}
            </section>
            <section
              className="chat-section chat-section-loose"
              aria-labelledby={`${labelId}-chats`}
              {...dropZone('ungroup', { kind: 'ungroup' })}
            >
              {sectionHeader('chats', 'Chats')}
              {draggingFiled && <p className="drop-hint">Drop here to remove from project</p>}
              {!collapsed.has('chats') &&
                (arranged.count === 0 ? (
                  <p className="sidebar-hint">No saved chats yet</p>
                ) : (
                  dateGroups(arranged.loose, 'chats')
                ))}
            </section>
          </>
        )}
      </div>
    </nav>
  )
}
